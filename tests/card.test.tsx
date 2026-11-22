import { expect, test } from 'claude-code/testing'

import { BAND_PROPS, MIN, SURFACES, T0, answer, turnComplete, world } from './fixtures/world'

const band = (surface: (typeof SURFACES)[number]) =>
  ({ plugin: 'ipsa-scientia', surface, component: 'AbovePrompt', props: BAND_PROPS }) as const

type Ui = { find: (q: { type: string; text?: RegExp; key?: string }) => Promise<{ text?: string; props: Record<string, unknown> } | undefined> }
const text = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
const label = (ui: Ui) => text(ui, /^Did you know\?/)

const start = (turnId: string, prompt = 'Refactor the parser') => ({ text: prompt, turnId })

for (const surface of SURFACES) {
  test(`${surface}: a short turn shows nothing; a longer one shows one fact`, async ($, on) => {
    const { clock, store } = world(on, T0)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))

    await $.turn.start(start('t1'))
    await clock.advance(10_000)
    await $.turn.complete(turnComplete('t1'))
    await clock.advance(60_000)
    expect(await label(ui)).toBe(undefined)

    await $.turn.start(start('t2'))
    await clock.advance(29_000)
    expect(await label(ui)).toBe(undefined)
    await clock.advance(1_000)
    expect(await label(ui)).toMatch(/^Did you know\? · (Space|Math)$/)
    expect((await ui.find({ type: 'Button', key: 'knew' }))?.props.label).toBe('I knew it')
    expect((await ui.find({ type: 'Button', key: 'knew' }))?.props.hotkey).toBe('k')
    expect((await ui.find({ type: 'Button', key: 'check' }))?.props.hotkey).toBe('c')
    expect((await ui.find({ type: 'Button', key: 'copy' }))?.props.hotkey).toBe('y')
    expect(store.get('is.day')).toEqual(expect.objectContaining({ counts: expect.objectContaining({ shown: 1 }) }))
    await ui.unmount()
  })

  test(`${surface}: I knew it closes the card and the fact never comes back`, async ($, on) => {
    const { clock, store } = world(on, T0)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))
    const knew = new Set<string>()

    // Three facts, three long turns 20 minutes apart: each is pressed away as known.
    for (let i = 0; i < 4; i++) {
      await $.turn.start(start(`t${i}`))
      await clock.advance(30_000)
      const fact = await ui.find({ type: 'Text', text: /\.$/ })
      if (i === 3) {
        expect(await label(ui)).toBe(undefined) // all known: nothing left to show
      } else {
        expect(knew.has(fact!.text!)).toBe(false)
        knew.add(fact!.text!)
        await ui.press({ key: 'knew' })
        expect(await label(ui)).toBe(undefined)
      }
      await $.turn.complete(turnComplete(`t${i}`))
      await clock.advance(20 * MIN)
    }
    expect(store.get('is.totals')).toEqual({
      v: 1,
      counts: { shown: 3, knew: 3, toCheck: 0, ignored: 0, copied: 0, checked: 0 },
    })
    await ui.unmount()
  })

  test(`${surface}: I need to check it puts the fact and its source on the To check list`, async ($, on) => {
    const { clock, store, toasts } = world(on, T0)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))
    await $.turn.start(start('t1'))
    await clock.advance(30_000)
    await ui.press({ key: 'check' })
    expect(await label(ui)).toBe(undefined)
    const list = (store.get('is.toCheck')) as { items: { source?: string; isAi: boolean }[] }
    expect(list.items).toHaveLength(1)
    expect(list.items[0]!.source).toMatch(/^https:\/\/example\.org\//)
    expect(list.items[0]!.isAi).toBe(false)
    expect(toasts).toContain('Added to To check in the Ipsa Scientia panel.')
    await ui.unmount()
  })

  test(`${surface}: Copy copies the fact and its source and keeps the card`, async ($, on) => {
    const { clock, store, copies, toasts } = world(on, T0)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))
    await $.turn.start(start('t1'))
    await clock.advance(30_000)
    await ui.press({ key: 'copy' })
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatch(/\nSource: https:\/\/example\.org\//)
    expect(toasts).toContain('Copied')
    expect(await label(ui)).toBeDefined()
    await ui.press({ key: 'knew' })
    expect(await label(ui)).toBe(undefined)
    const totals = (store.get('is.totals')) as { counts: Record<string, number> }
    expect([totals.counts.copied, totals.counts.knew]).toEqual([1, 1])
    await ui.unmount()
  })

  test(`${surface}: a failed copy says so`, async ($, on) => {
    const { clock, toasts } = world(on, T0, { isCopyOk: false })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))
    await $.turn.start(start('t1'))
    await clock.advance(30_000)
    await ui.press({ key: 'copy' })
    expect(toasts).toContain("Couldn't copy")
    await ui.unmount()
  })

  test(`${surface}: no press: the card hides 15 s after the turn and counts as Ignored`, async ($, on) => {
    const { clock, store } = world(on, T0)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))
    await $.turn.start(start('t1'))
    await clock.advance(45_000)
    await $.turn.complete(turnComplete('t1'))
    await clock.advance(14_000)
    expect(await label(ui)).toBeDefined()
    await clock.advance(1_000)
    expect(await label(ui)).toBe(undefined)
    const totals = (store.get('is.totals')) as { counts: Record<string, number> }
    expect(totals.counts.ignored).toBe(1)
    await ui.unmount()
  })

  test(`${surface}: a fact shown in another session less than 20 minutes ago holds this one back`, async ($, on) => {
    const day = { v: 1, date: '2026-03-10', counts: {}, lastFactAt: T0 - 5 * MIN, lastFactBy: 'session-2:x', aiCalls: 0, aiCostUsd: 0, sinceAi: 0 }
    const { clock } = world(on, T0, { store: { 'is.day': day } })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))
    await $.turn.start(start('t1'))
    await clock.advance(90_000)
    expect(await label(ui)).toBe(undefined)
    await $.turn.complete(turnComplete('t1'))
    await clock.advance(14 * MIN)
    await $.turn.start(start('t2'))
    await clock.advance(30_000)
    expect(await label(ui)).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a subagent's turn never shows a fact`, async ($, on) => {
    const { clock, store } = world(on, T0)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))
    await $.turn.start({ text: 'look around', turnId: 'a1', agentId: 'agent-1' })
    await clock.advance(60_000)
    expect(await label(ui)).toBe(undefined)
    await ui.unmount()
  })

  test(`${surface}: the user facts file is merged, a broken entry skipped with one toast`, async ($, on) => {
    const userFile = JSON.stringify([
      { id: 'my-fact', category: 'board-games', text: 'Chess has been played for about 1,500 years.' },
      { id: 'broken', category: 'board-games' },
    ])
    const { toasts } = world(on, T0, { userFile })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    expect(toasts).toEqual(['Ipsa Scientia: 1 fact in your file was skipped: broken: text is missing'])
  })
}

// ---- AI facts ----

const aiDay = (extra: object = {}) => ({
  v: 1,
  date: '2026-03-10',
  counts: {},
  lastFactAt: null,
  aiCalls: 0,
  aiCostUsd: 0,
  sinceAi: 2,
  ...extra,
})
const aiSettings = (aiContext: string) => ({ v: 1, aiContext, aiConsented: true })
const MANIFEST = { 'package.json': JSON.stringify({ name: 'private-name', dependencies: { react: '18' } }) }
const DIFF = { diff: '12\t3\tsrc/retry.ts\n1\t0\t.env.local\n' }

for (const surface of SURFACES) {
  test(`${surface}: AI context Off: zero model calls`, async ($, on) => {
    const { clock, modelCalls } = world(on, T0, { store: { 'is.day': aiDay() }, files: MANIFEST })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))
    for (let i = 0; i < 3; i++) {
      await $.turn.start(start(`t${i}`))
      await clock.advance(60_000)
      await $.turn.complete(turnComplete(`t${i}`))
      await clock.advance(20 * MIN)
    }
    expect(modelCalls).toHaveLength(0)
    await ui.unmount()
  })

  test(`${surface}: an AI fact carries its label and the note that it may be wrong`, async ($, on) => {
    const { clock, store, modelCalls, copies } = world(on, T0, {
      store: { 'is.settings': aiSettings('deps'), 'is.day': aiDay() },
      files: MANIFEST,
      model: () => answer('{"text": "React was first used on Facebook\'s news feed in 2011.", "category": "web"}'),
    })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))
    await $.turn.start(start('t1'))
    await clock.advance(30_000)
    expect(modelCalls).toHaveLength(1)
    expect(await label(ui)).toBe('Did you know? · AI · about this project')
    expect(await text(ui, /^may be wrong$/)).toBe('may be wrong')
    await ui.press({ key: 'copy' })
    expect(copies[0]).toContain('It may be wrong.')
    const day = (store.get('is.day')) as { aiCalls: number; aiCostUsd: number }
    expect(day.aiCalls).toBe(1)
    expect(day.aiCostUsd).toBeGreaterThan(0)
    await ui.unmount()
  })

  for (const level of ['deps', 'files', 'files-prompt'] as const) {
    test(`${surface}: AI context ${level} sends only what its row names`, async ($, on) => {
      const { clock, modelCalls, gitCalls } = world(on, T0, {
        store: { 'is.settings': aiSettings(level), 'is.day': aiDay() },
        files: MANIFEST,
        git: DIFF,
      })
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await $.turn.start(start('t1', 'Add retries with exponential backoff'))
      await clock.advance(30_000)
      expect(modelCalls).toHaveLength(1)
      const sent = modelCalls[0]!.prompt
      const deps = 'Project data:\nLanguages: JavaScript\nDependencies: react'
      const files = `${deps}\nChanged files (lines changed): src/retry.ts (15)`
      if (level === 'deps') {
        expect(sent).toBe(deps)
        expect(gitCalls).toHaveLength(0)
      }
      if (level === 'files') expect(sent).toBe(files)
      if (level === 'files-prompt') expect(sent).toBe(`${files}\nCurrent request: "Add retries with exponential backoff"`)
      expect(sent).not.toContain('private-name')
      expect(sent).not.toContain('.env')
    })
  }

  test(`${surface}: the AI daily cap is hard, and none falls back to the fact base`, async ($, on) => {
    const capped = world(on, T0, {
      store: { 'is.settings': aiSettings('deps'), 'is.day': aiDay({ aiCalls: 5 }) },
      files: MANIFEST,
    })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(band(surface))
    await $.turn.start(start('t1'))
    await capped.clock.advance(30_000)
    expect(capped.modelCalls).toHaveLength(0)
    expect(await label(ui)).toMatch(/^Did you know\? · (Space|Math)$/)
    await ui.unmount()
  })

  for (const reply of ['none', 'error'] as const) {
    test(`${surface}: a model answer of ${reply} gives way to the fact base`, async ($, on) => {
      const { clock, modelCalls } = world(on, T0, {
        store: { 'is.settings': aiSettings('deps'), 'is.day': aiDay() },
        files: MANIFEST,
        model: () =>
          reply === 'error'
            ? {
                isAnswered: false,
                reason: 'api-error',
                status: 529,
                error: 'overloaded',
                usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              }
            : answer('{"none": true}'),
      })
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      const ui = await $.ui.mount(band(surface))
      await $.turn.start(start('t1'))
      await clock.advance(30_000)
      expect(modelCalls).toHaveLength(1)
      expect(await label(ui)).toMatch(/^Did you know\? · (Space|Math)$/)
      await ui.unmount()
    })
  }
}
