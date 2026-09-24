// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseHealth, mergeVerdict, rescueFacts } from '../src/pr-policy.mjs'
import { createPolicy } from '../src/protected.mjs'

const policy = createPolicy({ codeowners: { path: '.github/CODEOWNERS', text: '/ci/ @alice\n/infra/lib/ @alice\n' } })
const PR = { number: 7, base: 'develop', headSha: 'h'.repeat(40) }
const RED = { conclusion: 'failure', url: 'https://example.invalid/run' }

/** The happy path; each case overrides the one fact it is about. */
const base = (over = {}) => ({
  pr: PR,
  allowedBases: ['develop'],
  policy,
  requiredCheck: 'ci',
  granted: false,
  lookups: {
    files: async () => ['README.md'],
    baseRed: async () => false,
    rescue: async () => ({ ok: false, why: 'stubbed' }),
  },
  ...over,
})
const withLookups = (l) => base({ lookups: { ...base().lookups, ...l } })

test('clean merge into the base', async () => {
  const v = await mergeVerdict(base())
  assert.equal(v.ok, true)
  assert.deepEqual(v.refusals, [])
})

test('a base outside mergeableBases is refused', async () => {
  const v = await mergeVerdict(base({ pr: { ...PR, base: 'main' } }))
  assert.equal(v.ok, false)
  assert.match(v.refusals[0].text, /targets `main`/)
})

test('an empty mergeableBases means agents never merge', async () => {
  const v = await mergeVerdict(base({ allowedBases: [] }))
  assert.equal(v.ok, false)
  assert.match(v.refusals[0].text, /no agent merge/)
})

test('a protected path in the diff is refused, named with its owner', async () => {
  const v = await mergeVerdict(withLookups({ files: async () => ['README.md', 'ci/run.mjs'] }))
  assert.equal(v.ok, false)
  assert.match(v.refusals[0].text, /ci\/run\.mjs — owned by @alice/)
})

test('an unreadable file list fails closed, and no grant lifts it', async () => {
  const lookups = { files: async () => { throw new Error('nope') } }
  for (const granted of [false, true]) {
    const v = await mergeVerdict({ ...withLookups(lookups), granted })
    assert.equal(v.ok, false)
    assert.match(v.refusals[0].text, /cannot read the files/)
  }
})

test('an impossible path is refused even with a merge grant', async () => {
  const v = await mergeVerdict({ ...withLookups({ files: async () => ['.github/workflows/ci.yml'] }), granted: true })
  assert.equal(v.ok, false)
  assert.equal(v.refusals[0].liftable, false)
})

test('a red base stops the line', async () => {
  const v = await mergeVerdict(withLookups({ baseRed: async () => RED }))
  assert.equal(v.ok, false)
  assert.match(v.refusals[0].text, /is red/)
  assert.match(v.refusals[0].text, /agit pr update 7/)
})

test('…unless this PR is the fix, which is said, not silent', async () => {
  const v = await mergeVerdict(withLookups({ baseRed: async () => RED, rescue: async () => ({ ok: true }) }))
  assert.equal(v.ok, true)
  assert.match(v.notes[0], /as the fix/)
})

test('unreadable base health allows — an outage must not block every merge', async () => {
  const v = await mergeVerdict(withLookups({ baseRed: async () => { throw new Error('503') } }))
  assert.equal(v.ok, true)
  assert.equal((await mergeVerdict(withLookups({ baseRed: async () => null }))).ok, true)
})

test('no requiredCheck: stop-the-line is off', async () => {
  const v = await mergeVerdict({ ...withLookups({ baseRed: async () => RED }), requiredCheck: null })
  assert.equal(v.ok, true)
})

test('a merge grant lifts base, protected and red — and reports each lift', async () => {
  const v = await mergeVerdict({
    ...base({ pr: { ...PR, base: 'main' } }),
    granted: true,
    lookups: { files: async () => ['ci/run.mjs'], baseRed: async () => RED, rescue: async () => ({ ok: false, why: 'x' }) },
  })
  assert.equal(v.ok, true)
  assert.equal(v.lifted.length, 3)
})

// ---------------------------------------------------------------------------
// The facts behind the red-base rule
// ---------------------------------------------------------------------------

const getter = (routes) => async (path) => {
  for (const [re, body] of routes) if (re.test(path)) return body
  throw new Error(`unrouted ${path}: 404 `)
}

test('baseHealth: green, red, unknown', async () => {
  const at = (run) => baseHealth({ get: getter([[/check-runs/, { check_runs: run ? [run] : [] }]]), owner: 'o', repo: 'r', base: 'develop', check: 'ci' })
  assert.equal(await at({ status: 'completed', conclusion: 'success' }), false)
  assert.deepEqual(await at({ status: 'completed', conclusion: 'failure', html_url: 'u' }), { conclusion: 'failure', url: 'u' })
  assert.equal(await at({ status: 'in_progress' }), null)
  assert.equal(await at(null), null)
})

test('rescueFacts: must contain the base head AND be green on it', async () => {
  const facts = (behind, run) =>
    rescueFacts({
      get: getter([[/compare/, { behind_by: behind }], [/check-runs/, { check_runs: [run] }]]),
      owner: 'o', repo: 'r', base: 'develop', headSha: 'a'.repeat(40), check: 'ci',
    })
  assert.deepEqual(await facts(0, { status: 'completed', conclusion: 'success' }), { ok: true })
  assert.match((await facts(3, { status: 'completed', conclusion: 'success' })).why ?? '', /3 commit\(s\) behind/)
  assert.match((await facts(0, { status: 'queued' })).why ?? '', /has not completed/)
  assert.match((await facts(0, { status: 'completed', conclusion: 'failure' })).why ?? '', /concluded `failure`/)
})
