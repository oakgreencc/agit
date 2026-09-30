// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseHealth, mergeVerdict, rescueFacts } from '../src/pr-policy.mjs'
import { createPolicy } from '../src/protected.mjs'
import { codeOwnerApproval, stalePolicy } from '../src/code-owner-approval.mjs'

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
// A code owner's approval, as GitHub records it, clears protected paths
// ---------------------------------------------------------------------------

const OLD = 'o'.repeat(40)
const rv = (login, state, commit = PR.headSha, at = '2026-09-22T19:00:00Z') => ({ user: { login, type: 'User' }, state, commit_id: commit, submitted_at: at })
const prRule = (dismiss) => ({
  type: 'pull_request',
  parameters: { dismiss_stale_reviews_on_push: dismiss, require_last_push_approval: false, require_code_owner_review: true },
})
/** The lookup as `agit pr merge` builds it, over the base policy's CODEOWNERS. */
const approvedBy = (reviews, rules = [prRule(true)], pol = policy) => (paths) =>
  Promise.resolve(
    codeOwnerApproval({ paths, codeowners: pol.codeowners.text, head: PR.headSha, reviews, policy: stalePolicy(rules, PR.base) }),
  )
const touchingCi = (approval) => withLookups({ files: async () => ['README.md', 'ci/run.mjs'], approval })

test("a code owner's approval on the head allows the merge, with a note naming them", async () => {
  const v = await mergeVerdict(touchingCi(approvedBy([rv('alice', 'APPROVED')])))
  assert.equal(v.ok, true)
  assert.deepEqual(v.refusals, [])
  assert.match(v.notes[0], /@alice approved its current head/)
})

test('no approval: still refused, says why, and a merge grant still lifts it', async () => {
  const v = await mergeVerdict(touchingCi(approvedBy([])))
  assert.equal(v.ok, false)
  assert.equal(v.refusals[0].liftable, true)
  assert.match(v.refusals[0].text, /No code-owner approval clears it: no approval from a code owner of ci\/run\.mjs \(@alice\)\./)
  assert.equal((await mergeVerdict({ ...touchingCi(approvedBy([])), granted: true })).ok, true)
})

test('an approval lookup that throws refuses', async () => {
  const v = await mergeVerdict(touchingCi(async () => { throw new Error('502') }))
  assert.equal(v.ok, false)
  assert.match(v.refusals[0].text, /No code-owner approval clears it: that could not be checked: 502\./)
})

test('no approval lookup at all refuses', async () => {
  const v = await mergeVerdict(withLookups({ files: async () => ['ci/run.mjs'] }))
  assert.equal(v.ok, false)
  assert.match(v.refusals[0].text, /No code-owner approval clears it/)
})

test('the lookup is asked only about guarded paths, and not at all without them', async () => {
  /** @type {string[][]} */
  const asked = []
  const approval = async (paths) => (asked.push(paths), { ok: true, approvals: [] })
  await mergeVerdict(touchingCi(approval))
  await mergeVerdict(withLookups({ approval }))
  assert.deepEqual(asked, [['ci/run.mjs']])
})

test('an approval does not override a red base', async () => {
  const v = await mergeVerdict(
    withLookups({ files: async () => ['ci/run.mjs'], approval: approvedBy([rv('alice', 'APPROVED')]), baseRed: async () => RED }),
  )
  assert.equal(v.ok, false)
  assert.equal(v.refusals.length, 1)
  assert.match(v.refusals[0].text, /is red/)
})

test('an approval does not override an impossible path', async () => {
  const v = await mergeVerdict(
    withLookups({ files: async () => ['ci/run.mjs', '.github/workflows/ci.yml'], approval: approvedBy([rv('alice', 'APPROVED')]) }),
  )
  assert.equal(v.ok, false)
  assert.equal(v.refusals.length, 1)
  assert.equal(v.refusals[0].liftable, false)
  assert.match(v.refusals[0].text, /cannot write/)
})

test('a stale approval is allowed when the base ruleset keeps stale approvals, and the note says so', async () => {
  const v = await mergeVerdict(touchingCi(approvedBy([rv('alice', 'APPROVED', OLD)], [prRule(false)])))
  assert.equal(v.ok, true)
  assert.match(v.notes[0], /@alice approved at ooooooo, an earlier commit/)
  assert.match(v.notes[0], /because the `develop` ruleset keeps stale approvals/)
})

test('a stale approval is refused when the base ruleset dismisses stale approvals', async () => {
  const v = await mergeVerdict(touchingCi(approvedBy([rv('alice', 'APPROVED', OLD)], [prRule(true)])))
  assert.equal(v.ok, false)
  assert.match(v.refusals[0].text, /approval is on ooooooo, not the current head hhhhhhh, and the `develop` ruleset dismisses stale approvals/)
})

test('a path protected only by agit (protected.extra, self-protection) is never cleared by an approval', async () => {
  const extra = createPolicy({
    config: /** @type {any} */ ({ protected: { impossible: [], extra: ['/secrets/'], codeowners: true } }),
    codeowners: { path: '.github/CODEOWNERS', text: '/ci/ @alice\n' },
  })
  let asked = false
  for (const file of ['secrets/x', '.agit.json']) {
    const v = await mergeVerdict({
      ...withLookups({ files: async () => [file], approval: async () => ((asked = true), { ok: true, approvals: [] }) }),
      policy: extra,
    })
    assert.equal(v.ok, false, file)
    assert.match(v.refusals[0].text, /No code-owner approval clears it: .*agit's own policy/)
  }
  assert.equal(asked, false)
})

test('a team-only owner is never cleared by an approval', async () => {
  const team = createPolicy({ codeowners: { path: '.github/CODEOWNERS', text: '/ci/ @acme/ops\n' } })
  const v = await mergeVerdict({
    ...withLookups({ files: async () => ['ci/run.mjs'], approval: approvedBy([rv('alice', 'APPROVED')], [prRule(false)], team) }),
    policy: team,
  })
  assert.equal(v.ok, false)
  assert.match(v.refusals[0].text, /names no individual owner for ci\/run\.mjs/)
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

test('approvalOnBase reads the base ruleset and every page of reviews; an unreadable ruleset is strict', async () => {
  const { approvalOnBase } = await import('../src/cli/pr.mjs')
  /** @type {string[]} */
  const asked = []
  const client = (rules) =>
    /** @type {any} */ ({
      paginate: async (path) => {
        asked.push(path)
        if (/\/rules\/branches\//.test(path)) return rules()
        if (/\/pulls\/7\/reviews/.test(path)) return [rv('alice', 'APPROVED', OLD)]
        throw new Error(`unrouted ${path}`)
      },
    })
  const at = (rules) =>
    approvalOnBase({ client: client(rules), owner: 'o', repo: 'r', base: 'develop', number: 7, head: PR.headSha, paths: ['ci/run.mjs'], codeowners: '/ci/ @alice\n' })
  assert.equal((await at(() => [prRule(false)])).ok, true)
  assert.ok(asked.includes('/repos/o/r/rules/branches/develop?per_page=100'))
  const boom = await at(() => { throw new Error('403') })
  assert.equal(boom.ok, false)
  assert.match(String(boom.why), /`develop` ruleset could not be read .*\(403\)/)
})
