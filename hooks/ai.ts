// AI facts, the pure part: what the model may see at each AI context level,
// the request the mod sends, and how its reply is read. Nothing here touches
// `$`; register.tsx reads the files and runs git, then hands the text here.

import type { ModelCompleteRequest } from 'claude-code'

import type { AiContext } from '../types'
import { MAX_TEXT } from './logic'

/** Manifest files read at the Dependencies level and above (dependency names only). */
export const MANIFESTS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'] as const
export type ManifestName = (typeof MANIFESTS)[number]

/** The most project data one request carries, in characters. */
export const MAX_DATA = 1024
/** How much of the current prompt the top level sends. */
export const PROMPT_CHARS = 300

export type Deps = { language: string; names: string[] }
export type Changed = { path: string; lines: number }

const unique = (xs: string[]): string[] => [...new Set(xs.filter(x => x.length > 0))]

/** Keys of a TOML table's `name = …` lines, from `[header]` to the next header. */
function tomlKeys(text: string, isWanted: (header: string) => boolean): string[] {
  const out: string[] = []
  let current = ''
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(t)
    if (header) {
      current = header[1]!
      // [dependencies.serde] is a table for one dependency
      const sub = /^(?:workspace\.)?(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(current)
      if (sub) out.push(sub[1]!)
      continue
    }
    if (!isWanted(current)) continue
    const key = /^([A-Za-z0-9_.-]+)\s*=/.exec(t)
    if (key) out.push(key[1]!.replace(/^"|"$/g, ''))
  }
  return out
}

/** A PEP 508 requirement's name: "requests[socks]>=2.31" → "requests". */
const requirementName = (s: string): string => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s)?.[1] ?? ''

/** The quoted strings of a TOML array `key = [ … ]` that may span lines. */
function tomlArray(text: string, key: string): string[] {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[`, 'm')
  const m = re.exec(text)
  if (!m) return []
  // The closing bracket outside quotes ("requests[socks]" holds one inside).
  const out: string[] = []
  let quote: string | null = null
  let current = ''
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) {
        out.push(current)
        current = ''
        quote = null
      } else current += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === ']') break
  }
  return out
}

/** The language and dependency names of one manifest, never versions or anything else. Null: unreadable. */
export function parseManifest(name: ManifestName, text: string): Deps | null {
  try {
    switch (name) {
      case 'package.json': {
        const j = JSON.parse(text) as Record<string, unknown>
        const keys = (k: string) => (j[k] && typeof j[k] === 'object' ? Object.keys(j[k] as object) : [])
        const names = unique([...keys('dependencies'), ...keys('devDependencies'), ...keys('peerDependencies')])
        return { language: names.includes('typescript') ? 'TypeScript' : 'JavaScript', names }
      }
      case 'Cargo.toml': {
        const names = tomlKeys(text, h => /^(?:workspace\.)?(?:dev-|build-)?dependencies$/.test(h))
        return { language: 'Rust', names: unique(names) }
      }
      case 'pyproject.toml': {
        const project = tomlArray(text, 'dependencies').map(requirementName)
        const poetry = tomlKeys(text, h => /^tool\.poetry\.(?:dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$/.test(h))
        return { language: 'Python', names: unique([...project, ...poetry.filter(n => n !== 'python')]) }
      }
      case 'go.mod': {
        const names: string[] = []
        let inBlock = false
        for (const line of text.split(/\r?\n/)) {
          const t = line.replace(/\/\/.*$/, '').trim()
          if (/^require\s*\($/.test(t)) inBlock = true
          else if (inBlock && t === ')') inBlock = false
          else if (inBlock && t) names.push(t.split(/\s+/)[0]!)
          else if (/^require\s+\S+/.test(t)) names.push(t.split(/\s+/)[1]!)
        }
        return { language: 'Go', names: unique(names) }
      }
    }
  } catch {
    return null
  }
}

/** `.env*`, `*.pem` and `*.key`: not even their names reach the model. */
export function isSensitivePath(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return base.startsWith('.env') || /\.(pem|key)$/i.test(base)
}

/**
 * `git diff --numstat` read into file names and changed line counts. Renames
 * keep the new name; binary files count 0 lines.
 */
export function parseNumstat(stdout: string): Changed[] {
  const out: Changed[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line)
    if (!m) continue
    const path = m[3]!.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/^.* => /, '').replace(/\/\//g, '/')
    const lines = (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]))
    out.push({ path, lines })
  }
  return out
}

/** The changed files the model may see: sensitive names and git-ignored paths left out, biggest change first. */
export function safeChanged(files: readonly Changed[], ignored: ReadonlySet<string>): Changed[] {
  return files.filter(f => !isSensitivePath(f.path) && !ignored.has(f.path)).sort((a, b) => b.lines - a.lines)
}

/** As many items as fit in `budget` characters, joined by ", ". */
function within(items: readonly string[], budget: number): string {
  let out = ''
  for (const item of items) {
    const next = out ? `${out}, ${item}` : item
    if (next.length > budget) break
    out = next
  }
  return out
}

export type ProjectInput = { deps: readonly Deps[]; changed: readonly Changed[]; prompt: string }

/**
 * The project data one level sends, at most MAX_DATA characters. Each level
 * adds to the one before: Dependencies (languages and library names),
 * Changed files (file names and line counts), Changed files + prompt (the
 * first 300 characters of the current prompt). Off sends nothing.
 */
export function buildProjectData(level: AiContext, input: ProjectInput): string {
  if (level === 'off') return ''
  const prompt = level === 'files-prompt' ? input.prompt.trim().replace(/\s+/g, ' ').slice(0, PROMPT_CHARS) : ''
  const promptLine = prompt ? `Current request: "${prompt}"` : ''
  const langs = unique(input.deps.map(d => d.language))
  const langLine = langs.length ? `Languages: ${langs.join(', ')}` : ''
  // Room left for the two lists once the fixed lines are in (and the newlines between).
  const room = MAX_DATA - langLine.length - promptLine.length - 70
  const hasFiles = level !== 'deps' && input.changed.length > 0
  const names = within(unique(input.deps.flatMap(d => d.names)), hasFiles ? Math.floor(room * 0.4) : room)
  const depLine = names ? `Dependencies: ${names}` : ''
  const files = hasFiles
    ? within(
        input.changed.map(f => `${f.path} (${f.lines})`),
        room - names.length,
      )
    : ''
  const fileLine = files ? `Changed files (lines changed): ${files}` : ''
  return [langLine, depLine, fileLine, promptLine]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_DATA)
}

export const AI_SYSTEM = `You write one short, surprising and true fact for a software developer, tied to the project data you are given: a language, a library, a tool, a file type, or the topic of the current request.

Rules:
- At most ${MAX_TEXT} characters, one or two sentences, in English.
- Only what you are certain of: well-documented history, numbers, names, dates. No guesses, no rumours.
- It should intrigue, not lecture. You may open with a short link to the work, such as "You're editing a regex."
- No politics, religion, tragedies, or health claims that could read as advice.
- Do not give advice and do not repeat the project data back.

Answer with JSON only, no other text:
{"text": "<the fact>", "category": "<one of: computer-history, languages, web, math, space, body, nature, words>"}
If you know nothing about this project data that you are sure of, answer:
{"none": true}`

/** The one request an AI fact takes: haiku, a fixed cached system prompt, the project data. */
export function buildRequest(projectData: string): ModelCompleteRequest {
  return {
    model: 'haiku',
    system: [{ text: AI_SYSTEM, cache: true }],
    prompt: `Project data:\n${projectData}`,
    maxTokens: 400,
    effort: 'low',
    timeoutMs: 20_000,
  }
}

export type Reply = { kind: 'fact'; text: string; category: string } | { kind: 'none' } | { kind: 'invalid'; reason: string }

/** The model's answer: a fact, `{ "none": true }`, or something to drop (over 200 characters, not JSON). */
export function parseReply(raw: string, knownCategories: readonly string[]): Reply {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end < start) return { kind: 'invalid', reason: 'no JSON object' }
  let j: unknown
  try {
    j = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { kind: 'invalid', reason: 'not JSON' }
  }
  const r = j as { none?: unknown; text?: unknown; category?: unknown }
  if (r.none === true) return { kind: 'none' }
  if (typeof r.text !== 'string' || r.text.trim() === '') return { kind: 'invalid', reason: 'no text' }
  const text = r.text.trim()
  if (text.length > MAX_TEXT) return { kind: 'invalid', reason: `${text.length} characters` }
  const category = typeof r.category === 'string' && knownCategories.includes(r.category) ? r.category : 'ai'
  return { kind: 'fact', text, category }
}
