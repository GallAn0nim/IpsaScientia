#!/usr/bin/env node
// Checks data/facts.json: unique kebab-case ids, known categories, text of at
// most 200 characters, and a source on every fact.
//   node scripts/check-facts.mjs            check only
//   node scripts/check-facts.mjs --release  also require 40 facts per category
// Needs Node 23.6+ (runs the TypeScript rules in hooks/logic.ts directly).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { factError } from '../hooks/logic.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = JSON.parse(readFileSync(join(root, 'data/facts.json'), 'utf8'))
const PER_CATEGORY = 40
const isRelease = process.argv.includes('--release')

const errors = []
const err = (where, msg) => errors.push(`${where}: ${msg}`)

if (data.v !== 1) err('file', 'v must be 1')
const categories = Array.isArray(data.categories) ? data.categories : []
if (categories.length === 0) err('file', 'categories missing')
const catIds = new Set()
for (const c of categories) {
  if (!c || typeof c.id !== 'string' || typeof c.name !== 'string') err('categories', 'each needs an id and a name')
  else if (catIds.has(c.id)) err(`categories.${c.id}`, 'id used twice')
  else catIds.add(c.id)
}

const facts = Array.isArray(data.facts) ? data.facts : []
if (facts.length === 0) err('file', 'facts missing')
const ids = new Set()
const texts = new Map()
const perCategory = new Map([...catIds].map(id => [id, 0]))
facts.forEach((f, i) => {
  const where = typeof f?.id === 'string' ? f.id : `#${i + 1}`
  const e = factError(f, true)
  if (e) return err(where, e)
  if (ids.has(f.id)) err(where, 'id used twice')
  ids.add(f.id)
  if (!catIds.has(f.category)) err(where, `unknown category ${f.category}`)
  else perCategory.set(f.category, perCategory.get(f.category) + 1)
  if (!f.addedIn) err(where, 'addedIn missing')
  const key = f.text.toLowerCase().replace(/\W+/g, ' ').trim()
  if (texts.has(key)) err(where, `same text as ${texts.get(key)}`)
  texts.set(key, f.id)
})

if (isRelease) {
  for (const [id, n] of perCategory) if (n < PER_CATEGORY) err(`categories.${id}`, `${n} facts, ${PER_CATEGORY} needed`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
const longest = Math.max(...facts.map(f => f.text.length))
const counts = [...perCategory].map(([id, n]) => `${id} ${n}`).join(', ')
console.log(`OK: ${facts.length} facts in ${catIds.size} categories (${counts}); longest ${longest} characters.`)
