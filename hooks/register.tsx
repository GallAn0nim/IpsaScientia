import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, RenderSurface, Timer } from 'claude-code'

import type { AiContext, AiFact, Card, Day, FactFile, Pause, Seen, Settings, ToCheck, ToCheckItem, Totals } from '../types'
import type { Changed, Deps } from './ai'
import { MANIFESTS, buildProjectData, buildRequest, parseManifest, parseNumstat, parseReply, safeChanged } from './ai'
import type { Merged, PauseLength } from './logic'
import {
  DEFAULT_SETTINGS,
  HIDE_AFTER_MS,
  addToCheck,
  bump,
  categoryStats,
  copyText,
  costText,
  estimateCostUsd,
  factGate,
  hideAtFor,
  isAiDue,
  isAiTurn,
  isPauseOver,
  isPaused,
  knewLine,
  localDate,
  mergeUserFacts,
  nameOf,
  nextText,
  normalizeBag,
  normalizeDay,
  normalizePause,
  normalizeSeen,
  normalizeSettings,
  normalizeToCheck,
  normalizeTotals,
  patchSettings,
  pauseUntil,
  pickFact,
  recordShown,
  removeToCheck,
  rollDay,
  setOutcome,
  shouldShow,
  skippedToast,
  statusText,
  toggleCategory,
} from './logic'

// ---- Store keys (shared by every session) ----
const K = {
  settings: 'is.settings',
  pause: 'is.pause',
  day: 'is.day',
  totals: 'is.totals',
  seen: 'is.seen',
  bag: 'is.bag',
  toCheck: 'is.toCheck',
} as const

// ---- Session values, read while drawing ----
const settingsAtom = atom({ plugin: 'ipsa-scientia', key: 'settings' } as const, DEFAULT_SETTINGS)
const dayAtom = atom({ plugin: 'ipsa-scientia', key: 'day' } as const, null)
const totalsAtom = atom({ plugin: 'ipsa-scientia', key: 'totals' } as const, null)
const pauseAtom = atom({ plugin: 'ipsa-scientia', key: 'pause' } as const, null)
const toCheckAtom = atom({ plugin: 'ipsa-scientia', key: 'toCheck' } as const, null)
const categoriesAtom = atom({ plugin: 'ipsa-scientia', key: 'categories' } as const, [])
const cardAtom = atom({ plugin: 'ipsa-scientia', key: 'card' } as const, null)
const turnAtom = atom({ plugin: 'ipsa-scientia', key: 'turnStartedAt' } as const, null)
const askPauseAtom = atom({ plugin: 'ipsa-scientia', key: 'isAskingPause' } as const, false)
const pendingAiAtom = atom({ plugin: 'ipsa-scientia', key: 'pendingAiContext' } as const, null)
const nowAtom = atom({ plugin: 'ipsa-scientia', key: 'now' } as const, 0)

const PANE = 'ipsa-scientia'
const POLL_MS = 30_000
const MINUTE = 60_000

const BUILT_IN = ['computer-history', 'languages', 'web', 'math', 'space', 'body', 'nature', 'words']

type Snapshot = {
  settings: Settings
  pause: Pause | null
  day: Day | null
  totals: Totals
  seen: Seen
  toCheck: ToCheck
  now: number
}

const rng = (): number => Math.random()

// Module state, rebuilt at every (re)load: the merged fact base, this
// session's timers and turn, and an AI fact asked for in advance.
let merged: Merged | null = null
let showTimer: Timer | null = null
let hideTimer: Timer | null = null
let turn: { id: string; startedAt: number; hasShown: boolean } | null = null
let lastPrompt = ''
let aiFact: AiFact | null = null
let isAiPending = false

async function loadFacts($: EngineInterface): Promise<Merged> {
  let base: FactFile = { v: 1, categories: [], facts: [] }
  try {
    base = JSON.parse(await $.fs.read(`${$.plugin.root}/data/facts.json`)) as FactFile
  } catch (err) {
    $.ui.toast(`Ipsa Scientia: could not read data/facts.json (${String(err)}).`)
  }
  let raw: unknown = undefined
  let unreadable: string | null = null
  const home = await $.env.get('HOME')
  const path = home ? `${home}/.claude/ipsa-scientia/facts.json` : null
  if (path && (await $.fs.exists(path))) {
    try {
      raw = JSON.parse(await $.fs.read(path))
    } catch {
      unreadable = 'the file is not valid JSON'
    }
  }
  merged = mergeUserFacts(base, raw)
  const skipped = unreadable ? [unreadable] : merged.skipped
  if (skipped.length) $.ui.toast(skippedToast(skipped), { timeoutMs: 10_000 })
  return merged
}

async function readStore($: EngineInterface): Promise<Snapshot> {
  const [settings, pause, day, totals, seen, toCheck, now] = await Promise.all([
    $.store.get(K.settings),
    $.store.get(K.pause),
    $.store.get(K.day),
    $.store.get(K.totals),
    $.store.get(K.seen),
    $.store.get(K.toCheck),
    $.clock.now(),
  ])
  return {
    settings: normalizeSettings(settings),
    pause: normalizePause(pause),
    day: normalizeDay(day),
    totals: normalizeTotals(totals),
    seen: normalizeSeen(seen),
    toCheck: normalizeToCheck(toCheck),
    now,
  }
}

async function mirror($: EngineInterface, snap: Snapshot): Promise<void> {
  const m = merged ?? { facts: [], categories: [], skipped: [] }
  await Promise.all([
    update($, settingsAtom, () => snap.settings),
    update($, pauseAtom, () => snap.pause),
    update($, dayAtom, () => (snap.day ? rollDay(snap.day, snap.now) : null)),
    update($, totalsAtom, () => snap.totals),
    update($, toCheckAtom, () => snap.toCheck),
    update($, categoriesAtom, () => categoryStats(m.facts, m.categories, snap.seen)),
    update($, nowAtom, () => snap.now),
  ])
  $.ui.status(statusText(snap.settings, snap.pause, snap.day, snap.toCheck.items.length, snap.now))
}

/** Pull the shared values into this session, turn back on after a pause, hide an expired card. */
async function sync($: EngineInterface): Promise<Snapshot> {
  let snap = await readStore($)
  if (isPauseOver(snap.pause, snap.now)) {
    // Re-read before writing: another session may have resumed already.
    if (isPauseOver(normalizePause(await $.store.get(K.pause)), snap.now)) {
      await $.store.delete(K.pause)
      $.ui.toast('Ipsa Scientia is back on.')
    }
    snap = await readStore($)
  }
  const card = await read($, cardAtom)
  if (card?.hideAt != null && card.hideAt <= snap.now) {
    await expireCard($, card.key)
    snap = await readStore($)
  }
  await mirror($, snap)
  return snap
}

/** Today's record and the totals, read right before a write (last write wins across sessions). */
async function counters($: EngineInterface, now: number): Promise<{ day: Day; totals: Totals }> {
  const [day, totals] = await Promise.all([$.store.get(K.day), $.store.get(K.totals)])
  return { day: rollDay(normalizeDay(day), now), totals: normalizeTotals(totals) }
}

async function saveCounters($: EngineInterface, c: { day: Day; totals: Totals }): Promise<void> {
  await Promise.all([$.store.set(K.day, c.day), $.store.set(K.totals, c.totals)])
}

// ---- Showing a fact ----

/** The check Show after seconds into a turn: show one fact if everything holds. */
async function maybeShow($: EngineInterface, turnId: string): Promise<void> {
  if (!turn || turn.id !== turnId || turn.hasShown || (await read($, cardAtom))) return
  const snap = await readStore($)
  if (!shouldShow(snap.settings, snap.pause, snap.day, snap.now, turn.startedAt, false)) return
  const m = merged ?? (await loadFacts($))

  const ai = aiFact && isAiTurn(snap.settings, snap.day, snap.now) ? aiFact : null
  const picked = ai ? null : pickFact(m.facts, snap.settings, snap.seen, normalizeBag(await $.store.get(K.bag)), rng)
  if (!ai && !picked) return

  // Claim the fact for this session and turn, then check no other session claimed one meanwhile.
  const claim = `${await $.session.id()}:${turnId}`
  const c = await counters($, snap.now)
  if (factGate(snap.settings, snap.pause, c.day, snap.now) !== 'ok') return
  await saveCounters($, recordShown(c.day, c.totals, snap.now, ai !== null, claim))
  if (normalizeDay(await $.store.get(K.day))?.lastFactBy !== claim) return
  if (picked) await $.store.set(K.bag, picked.bag)

  turn.hasShown = true
  if (ai) aiFact = null
  const card: Card = picked
    ? {
        key: claim,
        factId: picked.fact.id,
        text: picked.fact.text,
        category: picked.fact.category,
        ...(picked.fact.source ? { source: picked.fact.source } : {}),
        isAi: false,
        shownAt: snap.now,
        hideAt: null,
        isCopied: false,
      }
    : { key: claim, text: ai!.text, category: ai!.category, isAi: true, shownAt: snap.now, hideAt: null, isCopied: false }
  await update($, cardAtom, () => card)
  await sync($)
}

/** The card hid by itself: Ignored. */
async function expireCard($: EngineInterface, key: string): Promise<void> {
  const card = await read($, cardAtom)
  if (!card || card.key !== key) return
  await update($, cardAtom, () => null)
  hideTimer?.cancel()
  hideTimer = null
  const now = await $.clock.now()
  await saveCounters($, (c => bump(c.day, c.totals, 'ignored'))(await counters($, now)))
  if (card.factId) await $.store.set(K.seen, setOutcome(normalizeSeen(await $.store.get(K.seen)), card.factId, 'ignored'))
}

/** I knew it, or I didn't know: the card closes. */
async function closeCard($: EngineInterface, key: string, outcome: 'knew' | 'check'): Promise<void> {
  const card = await read($, cardAtom)
  if (!card || card.key !== key) return
  await update($, cardAtom, () => null)
  hideTimer?.cancel()
  hideTimer = null
  const now = await $.clock.now()
  const c = await counters($, now)
  await saveCounters($, bump(c.day, c.totals, outcome === 'knew' ? 'knew' : 'toCheck'))
  if (card.factId) await $.store.set(K.seen, setOutcome(normalizeSeen(await $.store.get(K.seen)), card.factId, outcome))
  if (outcome === 'check') {
    const item: ToCheckItem = {
      id: card.factId ?? `ai-${card.shownAt}`,
      text: card.text,
      category: card.category,
      ...(card.source ? { source: card.source } : {}),
      date: localDate(now),
      isAi: card.isAi,
    }
    await $.store.set(K.toCheck, addToCheck(normalizeToCheck(await $.store.get(K.toCheck)), item))
    $.ui.toast("Added to Didn't know in the Ipsa Scientia panel.")
  }
  await sync($)
}

async function copy(
  $: EngineInterface,
  fact: { text: string; source?: string; isAi: boolean },
  surface: RenderSurface | undefined,
): Promise<boolean> {
  const r = await $.ui.copy({ text: copyText(fact), ...(surface ? { surface } : {}) })
  $.ui.toast(r.isCopied ? 'Copied' : "Couldn't copy")
  return r.isCopied
}

/** Copy on the card: the card stays, so I knew it or I didn't know can still be pressed. */
async function onCopyCard($: EngineInterface, key: string, surface: RenderSurface | undefined): Promise<void> {
  const card = await read($, cardAtom)
  if (!card || card.key !== key) return
  if (!(await copy($, card, surface)) || card.isCopied) return
  await update($, cardAtom, c => (c && c.key === key ? { ...c, isCopied: true } : c))
  const c = await counters($, await $.clock.now())
  await saveCounters($, bump(c.day, c.totals, 'copied'))
  await sync($)
}

// ---- AI facts ----

/** What the chosen level lets the model see: dependency names, changed file names and counts, the prompt. */
async function gatherProjectData($: EngineInterface, level: AiContext): Promise<string> {
  const deps: Deps[] = []
  for (const name of MANIFESTS) {
    try {
      if (await $.fs.exists(name)) {
        const d = parseManifest(name, await $.fs.read(name))
        if (d) deps.push(d)
      }
    } catch {
      // unreadable manifest: left out
    }
  }
  let changed: Changed[] = []
  if (level === 'files' || level === 'files-prompt') {
    try {
      let r = await $.process.run(['git', 'diff', 'HEAD', '--numstat'], { timeoutMs: 5000 })
      if (r.exitCode !== 0) r = await $.process.run(['git', 'diff', '--numstat'], { timeoutMs: 5000 })
      const files = r.exitCode === 0 ? parseNumstat(r.stdout) : []
      let ignored = new Set<string>()
      if (files.length) {
        const ig = await $.process.run(['git', 'check-ignore', '--no-index', '--stdin'], {
          stdin: files.map(f => f.path).join('\n'),
          timeoutMs: 5000,
        })
        ignored = new Set(ig.stdout.split(/\r?\n/).filter(Boolean))
      }
      changed = safeChanged(files, ignored)
    } catch {
      // no git here: no changed files
    }
  }
  return buildProjectData(level, { deps, changed, prompt: lastPrompt })
}

/**
 * Started as soon as a fact is due, so the card is ready before the turn
 * reaches Show after. The call is counted before it is made: the daily cap
 * is hard across sessions. A failure or `none` leaves no AI fact, and the
 * knowledge base fills in.
 */
async function prefetchAi($: EngineInterface): Promise<void> {
  if (isAiPending || aiFact) return
  isAiPending = true
  try {
    const snap = await readStore($)
    if (!isAiDue(snap.settings, snap.day, snap.now)) return
    const data = await gatherProjectData($, snap.settings.aiContext)
    if (!data) return
    const before = await counters($, snap.now)
    if (before.day.aiCalls >= snap.settings.aiPerDay) return
    await $.store.set(K.day, { ...before.day, aiCalls: before.day.aiCalls + 1 })
    const r = await $.model.complete(buildRequest(data))
    const after = await counters($, await $.clock.now())
    await $.store.set(K.day, { ...after.day, aiCostUsd: after.day.aiCostUsd + estimateCostUsd(r.usage) })
    if (r.isAnswered) {
      const reply = parseReply(r.text, BUILT_IN)
      if (reply.kind === 'fact') aiFact = { text: reply.text, category: reply.category }
    }
  } catch {
    // an AI fact is never worth an error: the knowledge base fills in
  } finally {
    isAiPending = false
  }
}

// ---- Panel actions ----

async function onSettings($: EngineInterface, fn: (s: Settings) => Settings | null): Promise<void> {
  // Re-read right before writing (last write wins across sessions).
  const next = fn(normalizeSettings(await $.store.get(K.settings)))
  if (next) await $.store.set(K.settings, next)
  else $.ui.toast('Ipsa Scientia: at least one category stays on.')
  await sync($)
}

/** Off applies at once; another level the first time waits for "Turn on AI facts". */
async function onAiContext($: EngineInterface, level: AiContext): Promise<void> {
  const settings = normalizeSettings(await $.store.get(K.settings))
  if (level !== 'off' && !settings.aiConsented) {
    await update($, pendingAiAtom, () => level)
    return
  }
  await update($, pendingAiAtom, () => null)
  await onSettings($, s => patchSettings(s, { aiContext: level }))
}

async function onConsent($: EngineInterface): Promise<void> {
  const level = await read($, pendingAiAtom)
  await update($, pendingAiAtom, () => null)
  if (level) await onSettings($, s => patchSettings(s, { aiContext: level, aiConsented: true }))
}

async function onTurnOn($: EngineInterface): Promise<void> {
  await $.store.delete(K.pause)
  await onSettings($, s => patchSettings(s, { enabled: true }))
}

async function onTurnOff($: EngineInterface, length: PauseLength): Promise<void> {
  await $.store.set(K.pause, { v: 1, until: pauseUntil(length, await $.clock.now()) })
  await update($, askPauseAtom, () => false)
  await sync($)
}

async function onChecked($: EngineInterface, id: string): Promise<void> {
  const { list, item } = removeToCheck(normalizeToCheck(await $.store.get(K.toCheck)), id)
  if (!item) return
  await $.store.set(K.toCheck, list)
  const c = await counters($, await $.clock.now())
  await saveCounters($, bump(c.day, c.totals, 'checked'))
  if (!item.isAi) await $.store.set(K.seen, setOutcome(normalizeSeen(await $.store.get(K.seen)), id, 'checked'))
  await sync($)
}

async function onCopyItem($: EngineInterface, item: ToCheckItem, surface: RenderSurface | undefined): Promise<void> {
  if (await copy($, item, surface)) {
    const c = await counters($, await $.clock.now())
    await saveCounters($, bump(c.day, c.totals, 'copied'))
    await sync($)
  }
}

/**
 * Developer helpers, only with IPSA_SCIENTIA_DEV=1 in the environment:
 * `/ipsa-scientia show <fact-id> | due | reset`.
 */
async function devCommand($: EngineInterface, args: string): Promise<string | null> {
  if ((await $.env.get('IPSA_SCIENTIA_DEV')) !== '1') return null
  const [cmd, arg = ''] = args.trim().split(/\s+/)
  const now = await $.clock.now()
  switch (cmd) {
    case 'show': {
      const m = merged ?? (await loadFacts($))
      const fact = m.facts.find(f => f.id === arg)
      if (!fact) return `No fact with the id "${arg}".`
      await update($, cardAtom, () => ({
        key: `dev:${now}`,
        factId: fact.id,
        text: fact.text,
        category: fact.category,
        ...(fact.source ? { source: fact.source } : {}),
        isAi: false,
        shownAt: now,
        hideAt: null,
        isCopied: false,
      }))
      return `Showing ${fact.id} (not counted as shown). A button closes it.`
    }
    case 'due': {
      const settings = normalizeSettings(await $.store.get(K.settings))
      const c = await counters($, now)
      await $.store.set(K.day, { ...c.day, lastFactAt: now - settings.minutesBetween * MINUTE - 1 })
      return 'The gap since the last fact is over: the next longer turn shows one.'
    }
    case 'reset': {
      await Promise.all(Object.values(K).map(k => $.store.delete(k)))
      await update($, cardAtom, () => null)
      return 'All Ipsa Scientia data removed.'
    }
    default:
      return null
  }
}

export const register: Register = on => {
  // ---- Events ----

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ipsa-scientia', description: 'Open the Ipsa Scientia panel' })
    await loadFacts($)
    await sync($)
    $.clock.every(POLL_MS, () => void sync($))
    return next(e)
  })

  // The main loop's turns only: a subagent's run is no turn the person waits on.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    turn = { id: e.turnId, startedAt: now, hasShown: false }
    if (e.text.trim()) lastPrompt = e.text
    await update($, turnAtom, () => now)
    showTimer?.cancel()
    showTimer = null
    const snap = await readStore($)
    if (factGate(snap.settings, snap.pause, snap.day, snap.now) === 'ok') {
      if (isAiDue(snap.settings, snap.day, snap.now)) void prefetchAi($)
      const turnId = e.turnId
      showTimer = $.clock.after(snap.settings.showAfterSeconds * 1000, () => {
        showTimer = null
        void maybeShow($, turnId)
      })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    showTimer?.cancel()
    showTimer = null
    turn = null
    await update($, turnAtom, () => null)
    const card = await read($, cardAtom)
    if (card && card.hideAt === null) {
      const hideAt = hideAtFor(await $.clock.now())
      await update($, cardAtom, c => (c && c.key === card.key ? { ...c, hideAt } : c))
      hideTimer?.cancel()
      hideTimer = $.clock.after(HIDE_AFTER_MS, () => {
        hideTimer = null
        void expireCard($, card.key).then(() => sync($))
      })
    }
    return next(e)
  })

  on('command.run', { command: 'ipsa-scientia' }, async ($, e) => {
    const dev = e.args.trim() === '' ? null : await devCommand($, e.args)
    const snap = await sync($)
    const status = statusText(snap.settings, snap.pause, snap.day, snap.toCheck.items.length, snap.now)
    if (dev !== null) return { text: `${dev}\n${status}` }
    const opened = await $.ui.open({ id: PANE, title: 'Ipsa Scientia' })
    return { text: opened.isPlaced ? 'Ipsa Scientia panel opened.' : status }
  })

  // ---- The fact card above the prompt ----

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const card = await read($, cardAtom)
    if (!card) return next(e)
    const categories = await read($, categoriesAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    const label = card.isAi ? 'Did you know? · AI · about this project' : `Did you know? · ${nameOf(categories, card.category)}`
    return (
      <Box flexDirection="column">
        <Text dimColor>{label}</Text>
        <Text>{card.text}</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          <Button key="knew" label="I knew it" hotkey="k" onPress={() => closeCard($, card.key, 'knew')} />
          <Button key="didnt-know" label="I didn't know" hotkey="d" onPress={() => closeCard($, card.key, 'check')} />
          <Button key="copy" label="Copy" hotkey="y" onPress={p => onCopyCard($, card.key, p.surface)} />
          {card.isAi ? <Text dimColor>may be wrong</Text> : null}
        </Box>
      </Box>
    )
  })

  // ---- The side panel ----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [settings, day, totals, pause, toCheck, categories, now, isAskingPause, pendingAi] = await Promise.all([
      read($, settingsAtom),
      read($, dayAtom),
      read($, totalsAtom),
      read($, pauseAtom),
      read($, toCheckAtom),
      read($, categoriesAtom),
      read($, nowAtom),
      read($, askPauseAtom),
      read($, pendingAiAtom),
    ])
    const { Box, Text, Button, Link, Select } = $.ui.resolve(e)
    const items = toCheck?.items ?? []
    const next = nextText(settings, pause, day, now)

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text weight="semibold">Ipsa Scientia</Text>
          <Text dimColor>{statusText(settings, pause, day, items.length, now).replace('Ipsa Scientia · ', '')}</Text>
        </Box>
      )
    }

    const isOn = !isPaused(settings, pause, now)
    const today = day && day.date === localDate(now) ? day : null
    const todayCounts = today?.counts ?? { shown: 0, knew: 0, toCheck: 0, ignored: 0, copied: 0, checked: 0 }
    const allCounts = totals?.counts ?? todayCounts

    const section = (key: string, children: RenderChildren[]) => (
      <Box key={key} flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={2} paddingY={1}>
        {children}
      </Box>
    )
    const label = (t: string) => (
      <Text key={`label-${t}`} weight="semibold" dimColor>
        {t.toUpperCase()}
      </Text>
    )
    /** One setting: its name (and a hint) on the left, its control on the right. */
    const row = (key: string, name: string, control: RenderChildren, hint?: string) => (
      <Box key={key} flexDirection="row" gap={2} alignItems="center" justifyContent="space-between">
        <Box flexDirection="column" flexShrink={1}>
          <Text>{name}</Text>
          {hint ? <Text dimColor>{hint}</Text> : null}
        </Box>
        {control}
      </Box>
    )
    const select = (key: string, value: number | string, options: { value: string; label: string }[], onSelect: (v: string) => Promise<void>) => (
      <Select key={key} value={String(value)} options={options} onSelect={onSelect} />
    )
    const nums = (xs: number[], unit: (n: number) => string) => xs.map(n => ({ value: String(n), label: unit(n) }))

    // What it does
    const turnOn = isOn ? (
      <Button key="off" label="Turn off" variant="secondary" onPress={() => update($, askPauseAtom, () => true)} />
    ) : (
      <Button key="on" label="Turn on" variant="primary" onPress={() => onTurnOn($)} />
    )
    const pauseChoices =
      isOn && isAskingPause ? (
        <Box key="pause-box" flexDirection="column" gap={1}>
          <Text>Turn off for how long? It turns itself back on after that.</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="off-1h" label="1 h" variant="secondary" onPress={() => onTurnOff($, '1h')} />
            <Button key="off-2h" label="2 h" variant="secondary" onPress={() => onTurnOff($, '2h')} />
            <Button key="off-tomorrow" label="Until tomorrow" variant="secondary" onPress={() => onTurnOff($, 'tomorrow')} />
            <Button key="off-cancel" label="Keep it on" plain onPress={() => update($, askPauseAtom, () => false)} />
          </Box>
        </Box>
      ) : null

    // Stats: Today and All time side by side
    const STATS: [keyof typeof todayCounts, string][] = [
      ['shown', 'Shown'],
      ['knew', 'Knew'],
      ['toCheck', "Didn't know"],
      ['ignored', 'Ignored'],
      ['copied', 'Copied'],
      ['checked', 'Looked up'],
    ]
    const column = (key: string, title: string, counts: typeof todayCounts) => (
      <Box key={key} flexDirection="column" flexGrow={1} flexShrink={1}>
        <Text weight="semibold">{title}</Text>
        {STATS.map(([k, name]) => (
          <Box key={`${key}-${k}`} flexDirection="row" justifyContent="space-between" gap={1}>
            <Text dimColor>{name}</Text>
            <Text tabular>{String(counts[k])}</Text>
          </Box>
        ))}
      </Box>
    )

    const toCheckRows =
      items.length === 0
        ? [<Text key="none-to-check" dimColor>Nothing here. Every fact so far you either knew or let pass.</Text>]
        : items.map(item => (
            <Box key={`item-${item.id}`} flexDirection="column" gap={0}>
              <Text>{item.text}</Text>
              <Text dimColor>
                {item.isAi ? 'AI fact' : nameOf(categories, item.category)} · {item.date}
              </Text>
              <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                {item.source ? <Link key={`source-${item.id}`} href={item.source} label="Source" /> : null}
                <Button key={`looked-up-${item.id}`} label="Looked it up" variant="secondary" onPress={() => onChecked($, item.id)} />
                <Button key={`copy-${item.id}`} label="Copy" variant="secondary" onPress={p => onCopyItem($, item, p.surface)} />
              </Box>
            </Box>
          ))

    // Settings
    const AI_OPTIONS: { value: AiContext; label: string }[] = [
      { value: 'off', label: 'Off' },
      { value: 'deps', label: 'Dependencies' },
      { value: 'files', label: 'Changed files' },
      { value: 'files-prompt', label: 'Changed files + prompt' },
    ]
    const AI_HINT: Record<AiContext, string> = {
      off: 'No model calls. Facts come from the fact base only.',
      deps: 'Language and library names from package.json, Cargo.toml, pyproject.toml, go.mod',
      files: 'Plus the names of changed files and their line counts, no diff content',
      'files-prompt': "Plus the first 300 characters of your current prompt",
    }
    const consent = pendingAi ? (
      <Box key="consent" flexDirection="column" gap={1}>
        <Text>
          Facts will be written by Claude from your project's dependencies and changed file names (and a summary of your
          prompt, at the top level). This uses your Claude usage.
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="ai-consent" label="Turn on AI facts" variant="primary" onPress={() => onConsent($)} />
          <Button key="ai-cancel" label="Keep them off" plain onPress={() => update($, pendingAiAtom, () => null)} />
        </Box>
      </Box>
    ) : null
    const aiUsage =
      settings.aiContext !== 'off' ? (
        <Text key="ai-usage" dimColor>
          Today: {String(today?.aiCalls ?? 0)} of {String(settings.aiPerDay)} AI calls · {costText(today?.aiCostUsd ?? 0)}{' '}
          (estimate)
        </Text>
      ) : null

    const allIds = categories.map(c => c.id)

    return (
      <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
        {section('about', [
          <Text key="motto" weight="semibold">
            Ipsa scientia potestas est
          </Text>,
          <Text key="motto-en" dimColor italic>
            Knowledge itself is power. Francis Bacon, Meditationes Sacrae, 1597
          </Text>,
          <Text key="what">
            Now and then, while Claude works on a longer task, Ipsa Scientia shows one short fact above the prompt. A fact
            appears only once a turn has run for {String(settings.showAfterSeconds)} s, at most every{' '}
            {String(settings.minutesBetween)} minutes and {String(settings.factsPerDay)} times a day.
          </Text>,
          row('row-on', isOn ? 'On' : 'Off', turnOn, next),
          pauseChoices,
        ])}

        {section('stats', [
          label('Stats'),
          <Box key="columns" flexDirection="row" gap={3}>
            {column('today', 'Today', todayCounts)}
            {column('all', 'All time', allCounts)}
          </Box>,
          <Text key="knew-line">{knewLine(todayCounts)}</Text>,
          label("Didn't know"),
          ...toCheckRows,
        ])}

        {section('settings', [
          label('Settings'),
          row(
            'row-gap',
            'Minutes between facts',
            select('minutes-between', settings.minutesBetween, nums([5, 10, 15, 20, 30, 45, 60, 90, 120], n => `${n} min`), v =>
              onSettings($, s => patchSettings(s, { minutesBetween: Number(v) })),
            ),
            'Across all open sessions',
          ),
          row(
            'row-after',
            'Show after',
            select('show-after', settings.showAfterSeconds, nums([15, 20, 30, 45, 60, 90, 120], n => `${n} s`), v =>
              onSettings($, s => patchSettings(s, { showAfterSeconds: Number(v) })),
            ),
            'How long a turn runs before a fact shows',
          ),
          row(
            'row-per-day',
            'Facts per day',
            select('facts-per-day', settings.factsPerDay, nums([1, 2, 3, 5, 8, 10, 12, 15, 20, 30, 40, 50], String), v =>
              onSettings($, s => patchSettings(s, { factsPerDay: Number(v) })),
            ),
          ),
          row(
            'row-ai',
            'AI context',
            select('ai-context', pendingAi ?? settings.aiContext, AI_OPTIONS, v => onAiContext($, v as AiContext)),
            AI_HINT[pendingAi ?? settings.aiContext],
          ),
          consent,
          settings.aiContext !== 'off'
            ? row(
                'row-ai-share',
                'AI share',
                select('ai-share', settings.aiShare, nums([2, 3, 4, 5], n => `1 of ${n}`), v =>
                  onSettings($, s => patchSettings(s, { aiShare: Number(v) })),
                ),
              )
            : null,
          settings.aiContext !== 'off'
            ? row(
                'row-ai-per-day',
                'AI facts per day',
                select('ai-per-day', settings.aiPerDay, nums(Array.from({ length: 21 }, (_, i) => i), String), v =>
                  onSettings($, s => patchSettings(s, { aiPerDay: Number(v) })),
                ),
                'A hard cap on model calls',
              )
            : null,
          aiUsage,
          <Text key="apply" dimColor>
            Changes apply from the next fact.
          </Text>,
        ])}

        {section('base', [
          label('Fact base'),
          ...categories.map(c => (
            <Button
              key={`cat-${c.id}`}
              plain
              label={`${settings.disabledCategories.includes(c.id) ? '☐' : '☑'} ${c.name} · ${c.seen} of ${c.size} seen${c.isUser ? ' · yours' : ''}`}
              onPress={() => onSettings($, s => toggleCategory(s, c.id, allIds))}
            />
          )),
          <Text key="health" dimColor>
            Built-in facts are checked against their sources. AI facts may be wrong.
          </Text>,
        ])}
      </Box>
    )
  })
}
