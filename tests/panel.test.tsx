import { expect, test } from 'claude-code/testing'

import { MIN, PANE_PROPS, SURFACES, T0, world } from './fixtures/world'

const pane = (surface: (typeof SURFACES)[number]) =>
  ({ plugin: 'ipsa-scientia', surface, component: 'Pane', requestId: 'ipsa-scientia', props: PANE_PROPS }) as const

type Ui = { find: (q: { type: string; text?: RegExp; key?: string }) => Promise<{ text?: string; props: Record<string, unknown> } | undefined> }
const text = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
const button = async (ui: Ui, key: string) => (await ui.find({ type: 'Button', key }))?.props.label

const counts = (o: Partial<Record<string, number>>) => ({ shown: 0, knew: 0, didntKnow: 0, ignored: 0, copied: 0, lookedUp: 0, ...o })
const day = (extra: object = {}) => ({
  v: 1,
  date: '2026-03-10',
  counts: counts({ shown: 10, knew: 4, didntKnow: 3, ignored: 3, copied: 2 }),
  lastFactAt: T0 - 8 * MIN,
  aiCalls: 0,
  aiCostUsd: 0,
  sinceAi: 0,
  ...extra,
})
const item = (id: string, extra: object = {}) => ({
  id,
  text: `Fact ${id}.`,
  category: 'space',
  source: `https://example.org/${id}`,
  date: '2026-03-10',
  isAi: false,
  ...extra,
})

test('/ipsa-scientia opens the panel', async ($, on) => {
  world(on, T0)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({
    command: 'ipsa-scientia',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(r).toEqual(expect.objectContaining({ text: 'Ipsa Scientia panel opened.' }))
})

for (const surface of SURFACES) {
  test(`${surface}: what it does, then Today and All time counters`, async ($, on) => {
    world(on, T0, {
      store: {
        'is.day': day(),
        'is.totals': { v: 1, counts: counts({ shown: 40, knew: 20, didntKnow: 5, ignored: 12, copied: 4, lookedUp: 2 }) },
      },
    })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(pane(surface))
    expect(await text(ui, /^Ipsa scientia potestas est$/)).toBeDefined()
    expect(await text(ui, /^Next fact in/)).toBe('Next fact in 12 min')
    expect(await text(ui, /^You knew/)).toBe('You knew 4 of 10 (40%)')
    expect(await text(ui, /^10$/)).toBe('10')
    expect(await text(ui, /^40$/)).toBe('40')
    expect(await text(ui, /^Nothing here/)).toBe('Nothing here. Every fact so far you either knew or let pass.')
    expect(await text(ui, /^Didn't know$/)).toBe("Didn't know")
    expect(await text(ui, /^Looked up$/)).toBe('Looked up')
    expect(await text(ui, /^DIDN'T KNOW$/)).toBe("DIDN'T KNOW")
    expect(await text(ui, /checked against their sources/)).toBe(
      'Built-in facts are checked against their sources. AI facts may be wrong.',
    )
    await ui.unmount()
  })

  test(`${surface}: the Didn't know list; Looked it up removes and counts`, async ($, on) => {
    const { store } = world(on, T0, {
      store: {
        'is.day': day(),
        'is.didntKnow': { v: 1, items: [item('venus-day'), item('ai-1', { isAi: true, source: undefined, text: 'An AI fact.' })] },
      },
    })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(pane(surface))
    expect(await text(ui, /^Fact venus-day\.$/)).toBeDefined()
    expect(await text(ui, /^Space · 2026-03-10$/)).toBeDefined()
    expect(await text(ui, /^AI fact · 2026-03-10$/)).toBeDefined()
    // One Source link: the AI fact has none.
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://example.org/venus-day')

    expect(await button(ui, 'looked-up-venus-day')).toBe('Looked it up')
    await ui.press({ key: 'looked-up-venus-day' })
    expect(await text(ui, /^Fact venus-day\.$/)).toBe(undefined)
    expect(await ui.find({ type: 'Link' })).toBe(undefined)
    expect((store.get('is.day') as { counts: { lookedUp: number } }).counts.lookedUp).toBe(1)
    expect((store.get('is.seen') as { byId: Record<string, string> }).byId['venus-day']).toBe('lookedUp')
    await ui.unmount()
  })

  test(`${surface}: settings are saved; categories tick off but one stays on`, async ($, on) => {
    const { store, toasts } = world(on, T0, { store: { 'is.day': day() } })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(pane(surface))

    await ui.select({ key: 'minutes-between', value: '5' })
    expect(await text(ui, /^Next fact/)).toBe('Next fact during the next longer turn')
    await ui.select({ key: 'show-after', value: '60' })
    await ui.select({ key: 'facts-per-day', value: '5' })
    expect(store.get('is.settings')).toEqual(expect.objectContaining({ minutesBetween: 5, showAfterSeconds: 60, factsPerDay: 5 }))

    expect(await button(ui, 'cat-space')).toBe('☑ Space · 0 of 2 seen')
    await ui.press({ key: 'cat-space' })
    expect(await button(ui, 'cat-space')).toBe('☐ Space · 0 of 2 seen')
    await ui.press({ key: 'cat-math' })
    expect(await button(ui, 'cat-math')).toBe('☑ Math · 0 of 1 seen')
    expect(toasts).toContain('Ipsa Scientia: at least one category stays on.')
    await ui.unmount()
  })

  test(`${surface}: AI context asks for consent the first time`, async ($, on) => {
    const { store } = world(on, T0)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(pane(surface))

    await ui.select({ key: 'ai-context', value: 'files' })
    expect(await text(ui, /^Facts will be written by Claude/)).toBeDefined()
    expect((store.get('is.settings') as { aiContext?: string } | undefined)?.aiContext ?? 'off').toBe('off')
    await ui.press({ key: 'ai-consent' })
    expect(await text(ui, /^Facts will be written by Claude/)).toBe(undefined)
    expect(store.get('is.settings')).toEqual(expect.objectContaining({ aiContext: 'files', aiConsented: true }))
    expect(await text(ui, /AI calls/)).toBe('Today: 0 of 5 AI calls · $0.0000 (estimate)')

    // Once consented, a later change applies at once.
    await ui.select({ key: 'ai-context', value: 'deps' })
    expect(await text(ui, /^Facts will be written by Claude/)).toBe(undefined)
    expect(store.get('is.settings')).toEqual(expect.objectContaining({ aiContext: 'deps' }))
    await ui.unmount()
  })

  test(`${surface}: user categories are marked yours`, async ($, on) => {
    world(on, T0, { userFile: JSON.stringify([{ id: 'my-fact', category: 'board-games', text: 'Chess is old.' }]) })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(pane(surface))
    expect(await button(ui, 'cat-board-games')).toBe('☑ Board games · 0 of 1 seen · yours')
    await ui.unmount()
  })

  test(`${surface}: turning off for 1 h, then it turns itself back on`, async ($, on) => {
    const { clock } = world(on, T0, { store: { 'is.day': day() } })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount(pane(surface))
    await ui.press({ key: 'off' })
    expect(await button(ui, 'off-1h')).toBe('1 h')
    await ui.press({ key: 'off-1h' })
    expect(await text(ui, /^Off until/)).toBeDefined()
    await clock.advance(60 * MIN + 30_000)
    expect(await text(ui, /^On$/)).toBe('On')
    await ui.unmount()
  })
}
