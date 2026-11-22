import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_DATA,
  buildProjectData,
  buildRequest,
  isSensitivePath,
  parseManifest,
  parseNumstat,
  parseReply,
  safeChanged,
} from '../hooks/ai'

const CATS = ['computer-history', 'languages', 'web', 'math', 'space', 'body', 'nature', 'words']

describe('manifests: dependency names only', () => {
  test('package.json', async () => {
    const d = parseManifest(
      'package.json',
      JSON.stringify({ name: 'secret-app', version: '1.0.0', dependencies: { react: '^18' }, devDependencies: { typescript: '5' } }),
    )
    expect(d).toEqual({ language: 'TypeScript', names: ['react', 'typescript'] })
  })

  test('Cargo.toml', async () => {
    const text = `[package]\nname = "mine"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\ntokio = "1"\n\n[dependencies.regex]\nversion = "1"\n\n[dev-dependencies]\ninsta = "1"\n`
    expect(parseManifest('Cargo.toml', text)).toEqual({ language: 'Rust', names: ['serde', 'tokio', 'regex', 'insta'] })
  })

  test('pyproject.toml', async () => {
    const text = `[project]\nname = "mine"\ndependencies = [\n  "requests[socks]>=2.31",\n  'httpx',\n]\n\n[tool.poetry.dependencies]\npython = "^3.12"\nrich = "*"\n`
    expect(parseManifest('pyproject.toml', text)).toEqual({ language: 'Python', names: ['requests', 'httpx', 'rich'] })
  })

  test('go.mod', async () => {
    const text = `module example.com/mine\n\ngo 1.22\n\nrequire github.com/spf13/cobra v1.8.0\n\nrequire (\n\tgolang.org/x/sync v0.7.0 // indirect\n\tgithub.com/stretchr/testify v1.9.0\n)\n`
    expect(parseManifest('go.mod', text)).toEqual({
      language: 'Go',
      names: ['github.com/spf13/cobra', 'golang.org/x/sync', 'github.com/stretchr/testify'],
    })
  })

  test('a broken manifest is skipped', async () => {
    expect(parseManifest('package.json', '{ nope')).toBe(null)
  })
})

describe('changed files', () => {
  test('numstat lines, renames and binaries', async () => {
    expect(parseNumstat('12\t3\tsrc/a.rs\n-\t-\tlogo.png\n4\t0\tsrc/{old => new}/b.rs\n1\t1\tx.txt => y.txt\n')).toEqual([
      { path: 'src/a.rs', lines: 15 },
      { path: 'logo.png', lines: 0 },
      { path: 'src/new/b.rs', lines: 4 },
      { path: 'y.txt', lines: 2 },
    ])
  })

  test('.env*, *.pem, *.key and ignored files never reach the model', async () => {
    expect(['.env', '.env.local', 'conf/server.pem', 'id.key', 'src/env.ts'].map(isSensitivePath)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ])
    const files = parseNumstat('1\t0\t.env\n2\t0\tsecret/token.txt\n9\t0\tsrc/main.rs\n3\t0\tdeploy/tls.key\n')
    expect(safeChanged(files, new Set(['secret/token.txt']))).toEqual([{ path: 'src/main.rs', lines: 9 }])
  })
})

describe('each AI context level sends only what its row names', () => {
  const input = {
    deps: [{ language: 'Rust', names: ['serde', 'regex'] }],
    changed: [{ path: 'src/parse.rs', lines: 40 }],
    prompt: 'Add retries with exponential backoff to the HTTP client',
  }

  test('Off: nothing', async () => {
    expect(buildProjectData('off', input)).toBe('')
  })

  test('Dependencies: languages and library names', async () => {
    expect(buildProjectData('deps', input)).toBe('Languages: Rust\nDependencies: serde, regex')
  })

  test('Changed files: plus file names and line counts', async () => {
    expect(buildProjectData('files', input)).toBe(
      'Languages: Rust\nDependencies: serde, regex\nChanged files (lines changed): src/parse.rs (40)',
    )
  })

  test('Changed files + prompt: plus the first 300 characters of the prompt', async () => {
    const long = { ...input, prompt: `${'word '.repeat(100)}END` }
    const data = buildProjectData('files-prompt', long)
    expect(data).toContain('Changed files (lines changed): src/parse.rs (40)')
    expect(data).toContain('Current request: "word word')
    expect(data).not.toContain('END')
    expect(buildProjectData('files-prompt', input)).toContain(
      'Current request: "Add retries with exponential backoff to the HTTP client"',
    )
  })

  test('at most about 1 KB of project data', async () => {
    const big = {
      deps: [{ language: 'JavaScript', names: Array.from({ length: 400 }, (_, i) => `package-${i}`) }],
      changed: Array.from({ length: 400 }, (_, i) => ({ path: `src/file-${i}.ts`, lines: i })),
      prompt: 'x'.repeat(1000),
    }
    for (const level of ['deps', 'files', 'files-prompt'] as const) {
      expect(buildProjectData(level, big).length).toBeLessThanOrEqual(MAX_DATA)
    }
    expect(buildProjectData('files', big)).toContain('src/file-0.ts')
  })

  test('the request: haiku, the fixed cached system prompt, the data and nothing else', async () => {
    const r = buildRequest('Languages: Rust')
    expect(r.model).toBe('haiku')
    expect(r.prompt).toBe('Project data:\nLanguages: Rust')
    expect(Array.isArray(r.system) && r.system[0]?.cache).toBe(true)
  })
})

describe('the reply', () => {
  test('a fact, with a known category or ai', async () => {
    expect(parseReply('{"text": "Regex came from Kleene.", "category": "math"}', CATS)).toEqual({
      kind: 'fact',
      text: 'Regex came from Kleene.',
      category: 'math',
    })
    expect(parseReply('```json\n{"text": "X.", "category": "cooking"}\n```', CATS)).toEqual({ kind: 'fact', text: 'X.', category: 'ai' })
  })

  test('none, over 200 characters, or not JSON', async () => {
    expect(parseReply('{"none": true}', CATS)).toEqual({ kind: 'none' })
    expect(parseReply(JSON.stringify({ text: 'x'.repeat(201), category: 'math' }), CATS).kind).toBe('invalid')
    expect(parseReply('I am not sure.', CATS).kind).toBe('invalid')
  })
})
