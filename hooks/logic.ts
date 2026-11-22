// Pure rules of ipsa-scientia. Nothing here touches `$`: every function takes
// the current values plus `now` and returns new values, so each rule is
// unit-tested without the engine.

import type {
  AiContext,
  Bag,
  CategoryDef,
  CategoryInfo,
  Counts,
  Day,
  Fact,
  FactFile,
  Outcome,
  Pause,
  Seen,
  Settings,
  ToCheck,
  ToCheckItem,
  Totals,
} from '../types'

const MINUTE = 60_000

/** A fact's text is at most this long. */
export const MAX_TEXT = 200
/** The card stays this long after the turn ends, then hides as Ignored. */
export const HIDE_AFTER_MS = 15_000

export const AI_CONTEXTS: readonly AiContext[] = ['off', 'deps', 'files', 'files-prompt']

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  enabled: true,
  minutesBetween: 20,
  showAfterSeconds: 30,
  factsPerDay: 12,
  disabledCategories: [],
  aiContext: 'off',
  aiShare: 3,
  aiPerDay: 5,
  aiConsented: false,
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback

const bool = (b: unknown, fallback: boolean): boolean => (typeof b === 'boolean' ? b : fallback)

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [])

/** Reads whatever the store holds under is.settings into valid settings. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>
  const d = DEFAULT_SETTINGS
  return {
    v: 1,
    enabled: bool(r.enabled, d.enabled),
    minutesBetween: clamp(r.minutesBetween, 5, 120, d.minutesBetween),
    showAfterSeconds: clamp(r.showAfterSeconds, 15, 120, d.showAfterSeconds),
    factsPerDay: clamp(r.factsPerDay, 1, 50, d.factsPerDay),
    disabledCategories: strings(r.disabledCategories),
    aiContext: AI_CONTEXTS.includes(r.aiContext as AiContext) ? (r.aiContext as AiContext) : d.aiContext,
    aiShare: clamp(r.aiShare, 2, 5, d.aiShare),
    aiPerDay: clamp(r.aiPerDay, 0, 20, d.aiPerDay),
    aiConsented: bool(r.aiConsented, d.aiConsented),
  }
}

export const patchSettings = (settings: Settings, patch: Partial<Settings>): Settings =>
  normalizeSettings({ ...settings, ...patch })

// ---- Counters ----

export const EMPTY_COUNTS: Counts = { shown: 0, knew: 0, toCheck: 0, ignored: 0, copied: 0, checked: 0 }

export function normalizeCounts(raw: unknown): Counts {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Counts, unknown>>
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0)
  return {
    shown: n(r.shown),
    knew: n(r.knew),
    toCheck: n(r.toCheck),
    ignored: n(r.ignored),
    copied: n(r.copied),
    checked: n(r.checked),
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local calendar date of `now`, YYYY-MM-DD. */
export function localDate(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** local HH:MM */
export function timeText(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function newDay(now: number, lastFactAt: number | null = null): Day {
  return { v: 1, date: localDate(now), counts: { ...EMPTY_COUNTS }, lastFactAt, aiCalls: 0, aiCostUsd: 0, sinceAi: 0 }
}

/** A stored is.day, or null when absent or from an unknown version. */
export function normalizeDay(raw: unknown): Day | null {
  const r = raw as Partial<Day> | null | undefined
  if (!r || r.v !== 1 || typeof r.date !== 'string') return null
  return {
    v: 1,
    date: r.date,
    counts: normalizeCounts(r.counts),
    lastFactAt: typeof r.lastFactAt === 'number' ? r.lastFactAt : null,
    ...(typeof r.lastFactBy === 'string' ? { lastFactBy: r.lastFactBy } : {}),
    aiCalls: typeof r.aiCalls === 'number' ? r.aiCalls : 0,
    aiCostUsd: typeof r.aiCostUsd === 'number' ? r.aiCostUsd : 0,
    sinceAi: typeof r.sinceAi === 'number' ? r.sinceAi : 0,
  }
}

/**
 * Today's record: the same one while the local date holds, else a fresh one
 * with zero counters. The time of the last fact carries over midnight, so
 * the gap between two facts holds across days too.
 */
export function rollDay(day: Day | null, now: number): Day {
  if (day && day.date === localDate(now)) return day
  return newDay(now, day?.lastFactAt ?? null)
}

export const normalizeTotals = (raw: unknown): Totals => {
  const r = raw as Partial<Totals> | null | undefined
  return { v: 1, counts: normalizeCounts(r && r.v === 1 ? r.counts : null) }
}

export type CountKey = keyof Counts

/** Add one to a counter of today's record and of the all-time totals. */
export function bump(day: Day, totals: Totals, key: CountKey, by = 1): { day: Day; totals: Totals } {
  return {
    day: { ...day, counts: { ...day.counts, [key]: day.counts[key] + by } },
    totals: { v: 1, counts: { ...totals.counts, [key]: totals.counts[key] + by } },
  }
}

/** A fact was shown: counted, the time of the last fact set, the AI share advanced. */
export function recordShown(
  day: Day,
  totals: Totals,
  now: number,
  isAi: boolean,
  claim: string,
): { day: Day; totals: Totals } {
  const b = bump(day, totals, 'shown')
  return {
    day: { ...b.day, lastFactAt: now, lastFactBy: claim, sinceAi: isAi ? 0 : day.sinceAi + 1 },
    totals: b.totals,
  }
}

/** "You knew 6 of 14 (43%)" */
export function knewLine(counts: Counts): string {
  if (counts.shown === 0) return 'No facts yet.'
  const pct = Math.round((counts.knew / counts.shown) * 100)
  return `You knew ${counts.knew} of ${counts.shown} (${pct}%)`
}

// ---- When a fact appears ----

export function normalizePause(raw: unknown): Pause | null {
  const r = raw as Partial<Pause> | null | undefined
  return r && r.v === 1 && typeof r.until === 'number' ? { v: 1, until: r.until } : null
}

/** Turned off, or inside a timed pause. */
export function isPaused(settings: Settings, pause: Pause | null, now: number): boolean {
  return !settings.enabled || (pause !== null && pause.until > now)
}

export type PauseLength = '1h' | '2h' | 'tomorrow'

/** The moment a pause of that length ends: 1 h, 2 h, or the next local midnight. */
export function pauseUntil(length: PauseLength, now: number): number {
  if (length === '1h') return now + 60 * MINUTE
  if (length === '2h') return now + 120 * MINUTE
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** A pause whose time has come: the mod turns itself back on. */
export const isPauseOver = (pause: Pause | null, now: number): boolean => pause !== null && pause.until <= now

export type Gate = 'ok' | 'off' | 'paused' | 'daily-limit' | 'too-soon'

/**
 * Everything that must hold for a fact, except the turn's length: on and not
 * paused, today's limit not used up, and the gap since the last fact (in any
 * session) at least `minutesBetween`.
 */
export function factGate(settings: Settings, pause: Pause | null, day: Day | null, now: number): Gate {
  if (!settings.enabled) return 'off'
  if (pause !== null && pause.until > now) return 'paused'
  const today = rollDay(day, now)
  if (today.counts.shown >= settings.factsPerDay) return 'daily-limit'
  if (today.lastFactAt !== null && now - today.lastFactAt < settings.minutesBetween * MINUTE) return 'too-soon'
  return 'ok'
}

/**
 * The turn has run for at least `showAfterSeconds`, no fact was shown in it
 * yet, and the gate is open. `turnStartedAt` is null between turns.
 */
export function shouldShow(
  settings: Settings,
  pause: Pause | null,
  day: Day | null,
  now: number,
  turnStartedAt: number | null,
  hasShownThisTurn: boolean,
): boolean {
  if (turnStartedAt === null || hasShownThisTurn) return false
  if (now - turnStartedAt < settings.showAfterSeconds * 1000) return false
  return factGate(settings, pause, day, now) === 'ok'
}

/** Milliseconds until the gap since the last fact is over, or null when no fact can come today as things stand. */
export function msUntilNext(settings: Settings, pause: Pause | null, day: Day | null, now: number): number | null {
  const gate = factGate(settings, pause, day, now)
  if (gate === 'ok') return 0
  if (gate !== 'too-soon') return null
  const last = rollDay(day, now).lastFactAt ?? now
  return Math.max(0, last + settings.minutesBetween * MINUTE - now)
}

/** "Next fact in 12 min", or why there is none. */
export function nextText(settings: Settings, pause: Pause | null, day: Day | null, now: number): string {
  const gate = factGate(settings, pause, day, now)
  if (gate === 'off') return 'Off'
  if (gate === 'paused') return `Off until ${timeText(pause!.until)}`
  if (gate === 'daily-limit') return `Today's ${settings.factsPerDay} facts are used up`
  if (gate === 'ok') return 'Next fact during the next longer turn'
  return `Next fact in ${Math.ceil(msUntilNext(settings, pause, day, now)! / MINUTE)} min`
}

/** The status line: "Ipsa Scientia · next fact in 12 min · 3 to check". */
export function statusText(
  settings: Settings,
  pause: Pause | null,
  day: Day | null,
  toCheckCount: number,
  now: number,
): string {
  const next = nextText(settings, pause, day, now)
  const head = next.charAt(0).toLowerCase() + next.slice(1)
  return `Ipsa Scientia · ${head}${toCheckCount > 0 ? ` · ${toCheckCount} to check` : ''}`
}

/** When a card shown in a turn hides: 15 s after the turn ends. */
export const hideAtFor = (turnEndedAt: number): number => turnEndedAt + HIDE_AFTER_MS

// ---- Picking: a shuffle bag ----

export type Rng = () => number

export function normalizeSeen(raw: unknown): Seen {
  const r = raw as Partial<Seen> | null | undefined
  const byId: Record<string, Outcome> = {}
  if (r && r.v === 1 && r.byId && typeof r.byId === 'object') {
    for (const [k, v] of Object.entries(r.byId)) {
      if (v === 'knew' || v === 'ignored' || v === 'check' || v === 'checked') byId[k] = v
    }
  }
  return { v: 1, byId }
}

export const normalizeBag = (raw: unknown): Bag => {
  const r = raw as Partial<Bag> | null | undefined
  return { v: 1, ids: r && r.v === 1 ? strings(r.ids) : [] }
}

/** Facts that may still come up: in an enabled category, never marked I knew it, not on (or checked off) the To check list. */
export function eligibleFacts(facts: readonly Fact[], settings: Settings, seen: Seen): Fact[] {
  return facts.filter(f => {
    if (settings.disabledCategories.includes(f.category)) return false
    const o = seen.byId[f.id]
    return o === undefined || o === 'ignored'
  })
}

export function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * The next knowledge-base fact and the bag after it. The bag holds every
 * fact not yet shown, shuffled, so each comes up once before any repeats.
 * When it is empty it refills with facts never shown (new ones, a category
 * turned back on); with none left, only Ignored facts return. Null: nothing
 * can be shown.
 */
export function pickFact(
  facts: readonly Fact[],
  settings: Settings,
  seen: Seen,
  bag: Bag,
  rng: Rng,
): { fact: Fact; bag: Bag } | null {
  const eligible = eligibleFacts(facts, settings, seen)
  const byId = new Map(eligible.map(f => [f.id, f]))
  let queue = bag.ids.filter(id => byId.has(id))
  if (queue.length === 0) {
    const fresh = eligible.filter(f => seen.byId[f.id] === undefined)
    const pool = fresh.length > 0 ? fresh : eligible.filter(f => seen.byId[f.id] === 'ignored')
    queue = shuffle(
      pool.map(f => f.id),
      rng,
    )
  }
  const [id, ...rest] = queue
  const fact = id === undefined ? undefined : byId.get(id)
  if (!fact) return null
  return { fact, bag: { v: 1, ids: rest } }
}

/**
 * What a fact's outcome becomes. Ignored never overwrites a stronger one, so
 * a fact on the To check list that comes back as ignored stays on it.
 */
export function setOutcome(seen: Seen, id: string, outcome: Outcome): Seen {
  const before = seen.byId[id]
  if (outcome === 'ignored' && before !== undefined && before !== 'ignored') return seen
  return { v: 1, byId: { ...seen.byId, [id]: outcome } }
}

// ---- The To check list ----

export function normalizeToCheck(raw: unknown): ToCheck {
  const r = raw as Partial<ToCheck> | null | undefined
  if (!r || r.v !== 1 || !Array.isArray(r.items)) return { v: 1, items: [] }
  const items = r.items.filter(
    (x): x is ToCheckItem =>
      !!x && typeof x.id === 'string' && typeof x.text === 'string' && typeof x.category === 'string',
  )
  return { v: 1, items }
}

/** Newest first; a fact already on the list moves to the top. */
export function addToCheck(list: ToCheck, item: ToCheckItem): ToCheck {
  return { v: 1, items: [item, ...list.items.filter(x => x.id !== item.id)] }
}

/** Checked: the item leaves the list. */
export function removeToCheck(list: ToCheck, id: string): { list: ToCheck; item: ToCheckItem | null } {
  const item = list.items.find(x => x.id === id) ?? null
  return { list: { v: 1, items: list.items.filter(x => x.id !== id) }, item }
}

/** What Copy puts on the clipboard: the fact and its source. */
export function copyText(fact: { text: string; source?: string; isAi: boolean }): string {
  if (fact.isAi) return `${fact.text}\n(An AI fact about my project. It may be wrong.)`
  return fact.source ? `${fact.text}\nSource: ${fact.source}` : fact.text
}

// ---- The fact base and the user facts file ----

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Why an entry is not a valid fact, or null when it is. */
export function factError(raw: unknown, requireSource: boolean): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object'
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !KEBAB.test(r.id)) return 'id must be kebab-case'
  if (typeof r.category !== 'string' || !KEBAB.test(r.category)) return 'category must be kebab-case'
  if (typeof r.text !== 'string' || r.text.trim() === '') return 'text is missing'
  if (r.text.length > MAX_TEXT) return `text is ${r.text.length} characters, over ${MAX_TEXT}`
  if (r.source !== undefined && (typeof r.source !== 'string' || !/^https?:\/\/\S+$/.test(r.source)))
    return 'source must be an http(s) address'
  if (requireSource && r.source === undefined) return 'source is missing'
  if (r.addedIn !== undefined && typeof r.addedIn !== 'string') return 'addedIn must be a string'
  return null
}

const asFact = (r: Record<string, unknown>, isUser: boolean): Fact => ({
  id: r.id as string,
  category: r.category as string,
  text: (r.text as string).trim(),
  ...(typeof r.source === 'string' ? { source: r.source } : {}),
  ...(typeof r.addedIn === 'string' ? { addedIn: r.addedIn } : {}),
  ...(isUser ? { isUser: true } : {}),
})

/** "machine-learning" → "Machine learning" */
export const categoryName = (id: string): string => {
  const s = id.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export type Merged = {
  facts: Fact[]
  categories: (CategoryDef & { isUser: boolean })[]
  /** one line per skipped entry: "<id or #n>: <why>" */
  skipped: string[]
}

/**
 * The built-in base with the user's file merged in. The file is a list of
 * facts in the same format, or `{ "facts": [...], "categories": [...] }`;
 * `source` is optional there. Broken entries and ids already used are
 * skipped, never fatal. New categories are the user's own.
 */
export function mergeUserFacts(base: FactFile, raw: unknown): Merged {
  const facts: Fact[] = base.facts.map(f => ({ ...f }))
  const categories: Merged['categories'] = base.categories.map(c => ({ ...c, isUser: false }))
  const skipped: string[] = []
  if (raw === undefined || raw === null) return { facts, categories, skipped }

  const obj = raw as { facts?: unknown; categories?: unknown }
  const list = Array.isArray(raw) ? raw : Array.isArray(obj.facts) ? obj.facts : null
  if (!list) return { facts, categories, skipped: ['the file holds no list of facts'] }

  const named = new Map<string, string>()
  if (!Array.isArray(raw) && Array.isArray(obj.categories)) {
    for (const c of obj.categories as unknown[]) {
      const cc = c as Partial<CategoryDef> | null
      if (cc && typeof cc.id === 'string' && typeof cc.name === 'string') named.set(cc.id, cc.name)
    }
  }

  const ids = new Set(facts.map(f => f.id))
  list.forEach((entry, i) => {
    const r = entry as Record<string, unknown>
    const label = r && typeof r === 'object' && typeof r.id === 'string' ? r.id : `#${i + 1}`
    const error = factError(entry, false)
    if (error) return void skipped.push(`${label}: ${error}`)
    if (ids.has(r.id as string)) return void skipped.push(`${label}: id already used`)
    ids.add(r.id as string)
    const fact = asFact(r, true)
    facts.push(fact)
    if (!categories.some(c => c.id === fact.category)) {
      categories.push({ id: fact.category, name: named.get(fact.category) ?? categoryName(fact.category), isUser: true })
    }
  })
  return { facts, categories, skipped }
}

/** "3 facts in your file were skipped: a: text is missing; b: …" */
export function skippedToast(skipped: readonly string[]): string {
  const n = skipped.length
  const shown = skipped.slice(0, 3).join('; ')
  const more = n > 3 ? `; and ${n - 3} more` : ''
  return `Ipsa Scientia: ${n} ${n === 1 ? 'fact' : 'facts'} in your file ${n === 1 ? 'was' : 'were'} skipped: ${shown}${more}`
}

/** Each category with its size and how many of its facts were seen. */
export function categoryStats(
  facts: readonly Fact[],
  categories: readonly (CategoryDef & { isUser: boolean })[],
  seen: Seen,
): CategoryInfo[] {
  return categories.map(c => {
    const own = facts.filter(f => f.category === c.id)
    return {
      id: c.id,
      name: c.name,
      isUser: c.isUser,
      size: own.length,
      seen: own.filter(f => seen.byId[f.id] !== undefined).length,
    }
  })
}

/** Tick or untick a category; the last enabled one stays on. Null: refused. */
export function toggleCategory(settings: Settings, id: string, allIds: readonly string[]): Settings | null {
  const off = settings.disabledCategories.includes(id)
  if (off) return patchSettings(settings, { disabledCategories: settings.disabledCategories.filter(x => x !== id) })
  const enabled = allIds.filter(x => !settings.disabledCategories.includes(x))
  if (enabled.length <= 1) return null
  return patchSettings(settings, { disabledCategories: [...settings.disabledCategories, id] })
}

/** "Space" for a known category, else the id made readable. */
export const nameOf = (categories: readonly { id: string; name: string }[], id: string): string =>
  categories.find(c => c.id === id)?.name ?? categoryName(id)

// ---- AI facts: when, and what they cost ----

/** AI is on and consented to, and the next fact is the AI one of the share (one in `aiShare`). */
export function isAiTurn(settings: Settings, day: Day | null, now: number): boolean {
  if (settings.aiContext === 'off' || !settings.aiConsented) return false
  return rollDay(day, now).sinceAi >= settings.aiShare - 1
}

/** An AI turn, and a model call is still allowed today: the cap is hard. */
export function isAiDue(settings: Settings, day: Day | null, now: number): boolean {
  return isAiTurn(settings, day, now) && rollDay(day, now).aiCalls < settings.aiPerDay
}

/** Dollars per million tokens for the `haiku` alias (Claude Haiku 5.5), the basis of an estimate only. */
export const HAIKU_PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } as const

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function estimateCostUsd(u: Usage): number {
  const p = HAIKU_PRICE
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_input_tokens * p.cacheRead +
      u.cache_creation_input_tokens * p.cacheWrite) /
    1_000_000
  )
}

/** "$0.0004" */
export const costText = (usd: number): string => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`
