import { describe, expect, test } from 'claude-code/testing'

import type { Day, Fact, FactFile, Seen } from '../types'
import {
  DEFAULT_SETTINGS,
  addDidntKnow,
  bump,
  categoryStats,
  copyText,
  factGate,
  isAiDue,
  knewLine,
  localDate,
  mergeUserFacts,
  newDay,
  nextText,
  normalizeSeen,
  normalizeSettings,
  normalizeTotals,
  pickFact,
  recordShown,
  removeDidntKnow,
  rollDay,
  setOutcome,
  shouldShow,
  skippedToast,
  statusText,
  toggleCategory,
} from '../hooks/logic'

const MIN = 60_000
const T0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
const S = DEFAULT_SETTINGS
const SEEN0: Seen = { v: 1, byId: {} }

const day = (extra: Partial<Day> = {}): Day => ({ ...newDay(T0), ...extra })

/** A seeded generator, so shuffles repeat. */
function seeded(seed = 1) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

const facts: Fact[] = ['a', 'b', 'c', 'd'].map((id, i) => ({
  id,
  category: i < 2 ? 'space' : 'math',
  text: `fact ${id}`,
  source: `https://example.org/${id}`,
}))

describe('when a fact appears', () => {
  test('a turn shorter than Show after never shows a fact; a longer one does', async () => {
    expect(shouldShow(S, null, null, T0 + 29_000, T0, false)).toBe(false)
    expect(shouldShow(S, null, null, T0 + 30_000, T0, false)).toBe(true)
  })

  test('at most one fact per turn, and none between turns', async () => {
    expect(shouldShow(S, null, null, T0 + 60_000, T0, true)).toBe(false)
    expect(shouldShow(S, null, null, T0 + 60_000, null, false)).toBe(false)
  })

  test('two facts never closer than Minutes between facts', async () => {
    const d = day({ lastFactAt: T0 })
    expect(factGate(S, null, d, T0 + 19 * MIN)).toBe('too-soon')
    expect(factGate(S, null, d, T0 + 20 * MIN)).toBe('ok')
    expect(nextText(S, null, d, T0 + 8 * MIN)).toBe('Next fact in 12 min')
  })

  test('the gap holds across midnight; the counters do not', async () => {
    const late = new Date(2026, 2, 10, 23, 55).getTime()
    const d = rollDay(day({ lastFactAt: late, counts: { ...newDay(T0).counts, shown: 12 } }), late + 10 * MIN)
    expect(d.date).toBe('2026-03-11')
    expect(d.counts.shown).toBe(0)
    expect(factGate(S, null, d, late + 10 * MIN)).toBe('too-soon')
  })

  test("today's limit, off and paused all close the gate", async () => {
    expect(factGate(S, null, day({ counts: { ...newDay(T0).counts, shown: 12 } }), T0)).toBe('daily-limit')
    expect(factGate({ ...S, enabled: false }, null, null, T0)).toBe('off')
    expect(factGate(S, { v: 1, until: T0 + MIN }, null, T0)).toBe('paused')
    expect(factGate(S, { v: 1, until: T0 - 1 }, null, T0)).toBe('ok')
  })

  test('the status line', async () => {
    const d = day({ lastFactAt: T0 })
    expect(statusText(S, null, d, 3, T0 + 8 * MIN)).toBe("Ipsa Scientia · next fact in 12 min · 3 didn't know")
    expect(statusText(S, null, null, 0, T0)).toBe('Ipsa Scientia · next fact during the next longer turn')
  })

  test('settings are clamped to their ranges', async () => {
    const s = normalizeSettings({ minutesBetween: 1, showAfterSeconds: 500, factsPerDay: 0, aiShare: 9, aiPerDay: 99, aiContext: 'all' })
    expect([s.minutesBetween, s.showAfterSeconds, s.factsPerDay, s.aiShare, s.aiPerDay, s.aiContext]).toEqual([5, 120, 1, 5, 20, 'off'])
  })
})

describe('the shuffle bag', () => {
  test('every fact comes up once before any repeats', async () => {
    const rng = seeded(7)
    let bag = { v: 1 as const, ids: [] as string[] }
    let seen = SEEN0
    const order: string[] = []
    for (let i = 0; i < 4; i++) {
      const p = pickFact(facts, S, seen, bag, rng)!
      order.push(p.fact.id)
      bag = p.bag
      seen = setOutcome(seen, p.fact.id, 'ignored')
    }
    expect([...order].sort()).toEqual(['a', 'b', 'c', 'd'])
    // The bag is empty and everything was ignored: ignored facts return.
    expect(pickFact(facts, S, seen, bag, rng)).not.toBe(null)
  })

  test("I knew it never comes back; Didn't know does not while it is on the list", async () => {
    const seen: Seen = { v: 1, byId: { a: 'knew', b: 'didntKnow', c: 'lookedUp', d: 'ignored' } }
    const rng = seeded(3)
    for (let i = 0; i < 10; i++) expect(pickFact(facts, S, seen, { v: 1, ids: [] }, rng)!.fact.id).toBe('d')
    const all: Seen = { v: 1, byId: { a: 'knew', b: 'didntKnow', c: 'lookedUp', d: 'knew' } }
    expect(pickFact(facts, S, all, { v: 1, ids: [] }, rng)).toBe(null)
  })

  test('new facts come before ignored ones return', async () => {
    const seen: Seen = { v: 1, byId: { a: 'ignored', b: 'ignored', c: 'ignored' } }
    expect(pickFact(facts, S, seen, { v: 1, ids: [] }, seeded(1))!.fact.id).toBe('d')
  })

  test('disabled categories are skipped, the last one cannot be turned off', async () => {
    const s = { ...S, disabledCategories: ['space'] }
    for (let i = 0; i < 5; i++) {
      const p = pickFact(facts, s, SEEN0, { v: 1, ids: ['a', 'b'] }, seeded(i + 1))!
      expect(p.fact.category).toBe('math')
    }
    expect(toggleCategory(s, 'math', ['space', 'math'])).toBe(null)
    expect(toggleCategory(s, 'space', ['space', 'math'])!.disabledCategories).toEqual([])
  })

  test("an ignored showing never weakens knew or didn't know", async () => {
    const seen: Seen = { v: 1, byId: { a: 'didntKnow' } }
    expect(setOutcome(seen, 'a', 'ignored').byId.a).toBe('didntKnow')
    expect(setOutcome(seen, 'b', 'ignored').byId.b).toBe('ignored')
  })
})

describe('counters', () => {
  test('a showing counts today and all time, and moves the AI share', async () => {
    const r = recordShown(day(), normalizeTotals(null), T0, false, 's1:t1')
    expect(r.day.counts.shown).toBe(1)
    expect(r.day.lastFactAt).toBe(T0)
    expect(r.day.sinceAi).toBe(1)
    expect(r.totals.counts.shown).toBe(1)
    expect(recordShown(r.day, r.totals, T0, true, 's1:t2').day.sinceAi).toBe(0)
  })

  test('outcomes count in both records; the knew line', async () => {
    let r = { day: day(), totals: normalizeTotals(null) }
    for (let i = 0; i < 14; i++) r = bump(r.day, r.totals, 'shown')
    for (let i = 0; i < 6; i++) r = bump(r.day, r.totals, 'knew')
    expect(knewLine(r.day.counts)).toBe('You knew 6 of 14 (43%)')
    expect(r.totals.counts.knew).toBe(6)
    expect(knewLine(newDay(T0).counts)).toBe('No facts yet.')
  })
})

describe('values saved by 0.1.0', () => {
  test('the old outcome names map to the new ones', async () => {
    const seen = normalizeSeen({ v: 1, byId: { a: 'check', b: 'checked', c: 'knew', d: 'bogus' } })
    expect(seen.byId).toEqual({ a: 'didntKnow', b: 'lookedUp', c: 'knew' })
  })

  test('the old counter names carry over', async () => {
    const totals = normalizeTotals({ v: 1, counts: { shown: 9, knew: 4, toCheck: 3, ignored: 1, copied: 1, checked: 2 } })
    expect(totals.counts).toEqual({ shown: 9, knew: 4, didntKnow: 3, ignored: 1, copied: 1, lookedUp: 2 })
  })
})

describe("the Didn't know list", () => {
  const item = (id: string, date = localDate(T0)) => ({ id, text: `fact ${id}`, category: 'space', date, isAi: false })

  test('newest first, no duplicates; Looked it up removes the item', async () => {
    let list = addDidntKnow({ v: 1, items: [] }, item('a'))
    list = addDidntKnow(list, item('b'))
    list = addDidntKnow(list, item('a'))
    expect(list.items.map(x => x.id)).toEqual(['a', 'b'])
    const r = removeDidntKnow(list, 'a')
    expect(r.item?.id).toBe('a')
    expect(r.list.items.map(x => x.id)).toEqual(['b'])
  })

  test('Copy carries the source, or the AI note', async () => {
    expect(copyText({ text: 'X.', source: 'https://e.org', isAi: false })).toBe('X.\nSource: https://e.org')
    expect(copyText({ text: 'Y.', isAi: true })).toContain('It may be wrong.')
  })
})

describe('the user facts file', () => {
  const base: FactFile = {
    v: 1,
    categories: [{ id: 'space', name: 'Space' }],
    facts: [{ id: 'a', category: 'space', text: 'A.', source: 'https://e.org/a' }],
  }

  test('merged at session start, new categories marked as the user’s', async () => {
    const m = mergeUserFacts(base, [
      { id: 'mine-1', category: 'space', text: 'Mine.' },
      { id: 'mine-2', category: 'board-games', text: 'Chess is old.' },
    ])
    expect(m.facts.map(f => f.id)).toEqual(['a', 'mine-1', 'mine-2'])
    expect(m.facts[1]!.isUser).toBe(true)
    expect(m.categories).toEqual([
      { id: 'space', name: 'Space', isUser: false },
      { id: 'board-games', name: 'Board games', isUser: true },
    ])
    expect(m.skipped).toEqual([])
  })

  test('broken entries are skipped and listed, the rest still merges', async () => {
    const m = mergeUserFacts(base, {
      categories: [{ id: 'chess', name: 'Chess' }],
      facts: [
        { id: 'a', category: 'space', text: 'Duplicate.' },
        { id: 'Bad Id', category: 'space', text: 'x' },
        { id: 'long', category: 'space', text: 'x'.repeat(201) },
        { id: 'ok', category: 'chess', text: 'Fine.' },
        'nonsense',
      ],
    })
    expect(m.facts.map(f => f.id)).toEqual(['a', 'ok'])
    expect(m.categories[1]).toEqual({ id: 'chess', name: 'Chess', isUser: true })
    expect(m.skipped).toEqual([
      'a: id already used',
      'Bad Id: id must be kebab-case',
      'long: text is 201 characters, over 200',
      '#5: not an object',
    ])
    expect(skippedToast(m.skipped)).toBe(
      'Ipsa Scientia: 4 facts in your file were skipped: a: id already used; Bad Id: id must be kebab-case; long: text is 201 characters, over 200; and 1 more',
    )
  })

  test('a file that is no list is one skip line; no file changes nothing', async () => {
    expect(mergeUserFacts(base, { hello: 1 }).skipped).toEqual(['the file holds no list of facts'])
    expect(mergeUserFacts(base, undefined).facts).toHaveLength(1)
  })

  test('category sizes and how many were seen', async () => {
    const m = mergeUserFacts(base, [{ id: 'b', category: 'space', text: 'B.' }])
    expect(categoryStats(m.facts, m.categories, { v: 1, byId: { a: 'knew' } })).toEqual([
      { id: 'space', name: 'Space', isUser: false, size: 2, seen: 1 },
    ])
  })
})

describe('AI share and cap', () => {
  const on = { ...S, aiContext: 'deps' as const, aiConsented: true }

  test('off or not consented: never', async () => {
    expect(isAiDue(S, day({ sinceAi: 5 }), T0)).toBe(false)
    expect(isAiDue({ ...on, aiConsented: false }, day({ sinceAi: 5 }), T0)).toBe(false)
  })

  test('one fact in three by default', async () => {
    expect(isAiDue(on, day({ sinceAi: 0 }), T0)).toBe(false)
    expect(isAiDue(on, day({ sinceAi: 1 }), T0)).toBe(false)
    expect(isAiDue(on, day({ sinceAi: 2 }), T0)).toBe(true)
  })

  test('the daily cap is hard', async () => {
    expect(isAiDue(on, day({ sinceAi: 2, aiCalls: 5 }), T0)).toBe(false)
    expect(isAiDue({ ...on, aiPerDay: 0 }, day({ sinceAi: 2 }), T0)).toBe(false)
  })
})
