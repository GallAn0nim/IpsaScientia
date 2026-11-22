import { mock } from 'claude-code/testing'

import type { ModelCompleteInput, ModelCompleteResult, On } from 'claude-code'

import type { FactFile } from '../../types'

/** A small fact base: two categories, three facts. */
export const FIXTURE: FactFile = {
  v: 1,
  categories: [
    { id: 'space', name: 'Space' },
    { id: 'math', name: 'Math' },
  ],
  facts: [
    { id: 'venus-day', category: 'space', text: 'A day on Venus is longer than its year.', source: 'https://example.org/venus' },
    { id: 'olympus-mons', category: 'space', text: 'Olympus Mons is about 22 km high.', source: 'https://example.org/olympus' },
    { id: 'birthday', category: 'math', text: 'In a room of 23 people, two likely share a birthday.', source: 'https://example.org/birthday' },
  ],
}

export const MIN = 60_000
export const T0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
export const HOME = '/home/tester'
export const USER_FILE = `${HOME}/.claude/ipsa-scientia/facts.json`

export const SURFACES = ['terminal', 'desktop'] as const

export const BAND_PROPS = {
  hasSurvey: false,
  isCollapsed: false,
  isWorking: true,
  maxRows: 8,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
} as const

export const PANE_PROPS = {
  title: 'Ipsa Scientia',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 80 },
  view: {},
} as const

export type WorldOptions = {
  store?: Record<string, unknown>
  /** files in the working directory, by name (manifests) */
  files?: Record<string, string>
  /** the user facts file's text, or absent */
  userFile?: string
  /** what the model answers */
  model?: (e: ModelCompleteInput) => ModelCompleteResult
  /** git's stdout per first argument after "git" */
  git?: Record<string, string>
  isCopyOk?: boolean
}

const USAGE = { input_tokens: 1200, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

export const answer = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })

/** The engine beneath the plugin: store, clock, files, git, clipboard, model, toasts. */
export function world(on: On, now: number, o: WorldOptions = {}) {
  const clock = mock.clock(on, { now })
  // The store as a map the test reads back (the test's own $ has no store noun).
  const store = new Map<string, unknown>(Object.entries(o.store ?? {}))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, { HOME })
  const toasts: string[] = []
  const copies: string[] = []
  const modelCalls: ModelCompleteInput[] = []
  const gitCalls: string[][] = []
  // Relative paths reach fs resolved against the working directory: manifests are matched by file name.
  const files = o.files ?? {}
  const nameOf = (path: string) => path.split('/').pop() ?? path
  const has = (path: string) => nameOf(path) in files
  const file = (path: string) => files[nameOf(path)]
  on('command.register', () => ({ value: { command: 'ipsa-scientia' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '', reason: 'answer' as const }))
  on('fs.exists', (_, e) => ({ value: e.path === USER_FILE ? o.userFile !== undefined : has(e.path) }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/data/facts.json')) return { value: JSON.stringify(FIXTURE) }
    if (e.path === USER_FILE && o.userFile !== undefined) return { value: o.userFile }
    const f = file(e.path)
    if (f !== undefined) return { value: f }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('process.run', (_, e) => {
    gitCalls.push([...e.argv])
    const stdout = o.git?.[e.argv[1] ?? ''] ?? ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', (_, e) => {
    modelCalls.push(e)
    return { value: o.model ? o.model(e) : answer('{"none": true}') }
  })
  on('ui.copy', (_, e) => {
    if (o.isCopyOk === false) return { value: { isCopied: false as const, reason: 'no-clipboard' as const } }
    copies.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, store, toasts, copies, modelCalls, gitCalls }
}

export const turnComplete = (turnId: string) => ({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' as const })
