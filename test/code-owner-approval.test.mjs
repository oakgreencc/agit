// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { codeOwnerApproval, individualOwners, stalePolicy, strict } from '../src/code-owner-approval.mjs'
import { parseCodeowners } from '../src/codeowners.mjs'
import { wantedRules } from '../src/setup/rulesets.mjs'

const CODEOWNERS = `
# comment
/packages/ci/        @jamesloosli
/packages/agent-env/ @jamesloosli @other-owner
/infra/cdk/lib/      @acme/infra-team
/apps/www/tos/       @jamesloosli
/apps/www/tos/draft/
/mixed/              @acme/infra-team owner@example.com @Mixed-Owner
`

const HEAD = 'cdcee3ea0000000000000000000000000000000'
const OLD = '1111111000000000000000000000000000000000'

/** A review as `GET /pulls/{n}/reviews` returns it. */
const review = (login, state, commit = HEAD, at = '2026-09-22T19:38:16Z', type = 'User') => ({
  user: { login, type },
  state,
  commit_id: commit,
  submitted_at: at,
})

const approve = (over = {}) =>
  codeOwnerApproval({
    paths: ['packages/ci/src/ci.mjs'],
    codeowners: CODEOWNERS,
    head: HEAD,
    reviews: [review('jamesloosli', 'APPROVED')],
    ...over,
  })

const owners = (text, path) => individualOwners(parseCodeowners(text), path)

test('individualOwners takes the last matching rule, as GitHub does', () => {
  assert.deepEqual(owners(CODEOWNERS, 'packages/ci/src/ci.mjs'), ['jamesloosli'])
  assert.deepEqual(owners(CODEOWNERS, 'packages/agent-env/hooks/x.mjs'), ['jamesloosli', 'other-owner'])
  // A later ownerless line un-owns what an earlier one owned.
  assert.deepEqual(owners(CODEOWNERS, 'apps/www/tos/draft/a.html'), [])
  assert.deepEqual(owners(CODEOWNERS, 'README.md'), [])
  // Teams and emails are dropped; logins are lower-cased.
  assert.deepEqual(owners(CODEOWNERS, 'mixed/a'), ['mixed-owner'])
})

test('a later wildcard line reassigns ownership, and the earlier owner no longer clears it', () => {
  const text = '/packages/ci/ @a\n*.mjs @b\n'
  assert.deepEqual(owners(text, 'packages/ci/src/ci.mjs'), ['b'])
  assert.deepEqual(owners(text, 'packages/ci/README.md'), ['a'])
  const byA = codeOwnerApproval({ paths: ['packages/ci/src/ci.mjs'], codeowners: text, head: HEAD, reviews: [review('a', 'APPROVED')] })
  assert.equal(byA.ok, false)
  const byB = codeOwnerApproval({ paths: ['packages/ci/src/ci.mjs'], codeowners: text, head: HEAD, reviews: [review('b', 'APPROVED')] })
  assert.equal(byB.ok, true)
})

test('an owner approval on the current head clears it', () => {
  const got = approve()
  assert.equal(got.ok, true)
  assert.deepEqual(got.ok && got.approvers, ['jamesloosli'])
})

test('login comparison ignores case, as GitHub does', () => {
  assert.equal(approve({ reviews: [review('JamesLoosli', 'APPROVED')] }).ok, true)
})

test('an approval on a stale sha does not, by default', () => {
  const got = approve({ reviews: [review('jamesloosli', 'APPROVED', OLD)] })
  assert.equal(got.ok, false)
  assert.match(String(!got.ok && got.why), /1111111/)
})

test('an approval from a non-owner does not', () => {
  const got = approve({ reviews: [review('someone-else', 'APPROVED')] })
  assert.equal(got.ok, false)
  assert.match(String(!got.ok && got.why), /no approval/)
})

test('an approval from the App, or any bot, does not — even one named like an owner', () => {
  assert.equal(approve({ reviews: [review('agit-app[bot]', 'APPROVED')] }).ok, false)
  assert.equal(approve({ reviews: [review('jamesloosli', 'APPROVED', HEAD, undefined, 'Bot')] }).ok, false)
})

test("an owner's later CHANGES_REQUESTED overrides their approval", () => {
  const got = approve({
    reviews: [
      review('jamesloosli', 'APPROVED', HEAD, '2026-09-22T19:00:00Z'),
      review('jamesloosli', 'CHANGES_REQUESTED', HEAD, '2026-09-22T20:00:00Z'),
    ],
  })
  assert.equal(got.ok, false)
  assert.match(String(!got.ok && got.why), /requested changes/)
})

test('latest decisive is by submitted_at, not array order', () => {
  const got = approve({
    reviews: [
      review('jamesloosli', 'CHANGES_REQUESTED', OLD, '2026-09-22T20:00:00Z'),
      review('jamesloosli', 'APPROVED', HEAD, '2026-09-22T19:00:00Z'),
    ],
  })
  assert.equal(got.ok, false)
})

test('a COMMENTED review after an approval does not undo it', () => {
  const got = approve({
    reviews: [
      review('jamesloosli', 'APPROVED', HEAD, '2026-09-22T19:00:00Z'),
      review('jamesloosli', 'COMMENTED', HEAD, '2026-09-22T20:00:00Z'),
    ],
  })
  assert.equal(got.ok, true)
})

test('a DISMISSED approval does not count', () => {
  assert.equal(approve({ reviews: [review('jamesloosli', 'DISMISSED')] }).ok, false)
})

test('a co-owner requesting changes blocks another owner’s approval', () => {
  const got = approve({
    paths: ['packages/agent-env/hooks/x.mjs'],
    reviews: [review('jamesloosli', 'APPROVED'), review('other-owner', 'CHANGES_REQUESTED')],
  })
  assert.equal(got.ok, false)
})

test('no review at all does not', () => {
  assert.equal(approve({ reviews: [] }).ok, false)
})

test('every path needs an approving owner of its own', () => {
  const got = approve({
    paths: ['packages/ci/src/ci.mjs', 'packages/agent-env/hooks/x.mjs'],
    reviews: [review('other-owner', 'APPROVED')],
  })
  assert.equal(got.ok, false)
  assert.match(String(!got.ok && got.why), /packages\/ci\/src\/ci\.mjs/)
})

test('a path owned only by a team cannot be cleared — membership is not checked', () => {
  const got = approve({ paths: ['infra/cdk/lib/a.ts'] })
  assert.equal(got.ok, false)
  assert.match(String(!got.ok && got.why), /no individual owner/)
})

test('a path CODEOWNERS does not own cannot be cleared', () => {
  assert.equal(approve({ paths: ['apps/www/tos/draft/a.html'] }).ok, false)
})

test('an unknown head or unreadable reviews cannot be cleared', () => {
  assert.equal(approve({ head: '' }).ok, false)
  assert.equal(approve({ reviews: null }).ok, false)
})

// ---------------------------------------------------------------------------
// Stale approvals: counted only when the base's ruleset keeps them.
// ---------------------------------------------------------------------------

/** A `pull_request` rule as `GET /rules/branches/{base}` returns it. */
const prRule = (over = {}) => ({
  type: 'pull_request',
  parameters: {
    required_approving_review_count: 0,
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: true,
    require_last_push_approval: false,
    ...over,
  },
})
const KEEPS = stalePolicy([{ type: 'deletion' }, prRule()], 'main')
const DISMISSES = stalePolicy([prRule({ dismiss_stale_reviews_on_push: true })], 'main')

test('stalePolicy keeps stale approvals only when every pull_request rule says so', () => {
  assert.equal(KEEPS.keepsStale, true)
  assert.match(KEEPS.basis, /`main` ruleset keeps stale approvals/)
  assert.equal(DISMISSES.keepsStale, false)
  // GitHub enforces the strictest of several rulesets.
  assert.equal(stalePolicy([prRule(), prRule({ dismiss_stale_reviews_on_push: true })]).keepsStale, false)
  // A required last-push approval is not met by an approval on an earlier commit.
  assert.equal(stalePolicy([prRule({ require_last_push_approval: true })]).keepsStale, false)
})

test('stalePolicy fails closed on anything it cannot prove, naming the base', () => {
  for (const rules of [null, undefined, 'x', {}, [], [{ type: 'deletion' }]]) {
    assert.equal(stalePolicy(rules, 'trunk').keepsStale, false, JSON.stringify(rules))
    assert.match(stalePolicy(rules, 'trunk').basis, /`trunk`/)
  }
  // A missing field is not `false`.
  assert.equal(stalePolicy([{ type: 'pull_request', parameters: { require_last_push_approval: false } }]).keepsStale, false)
  assert.equal(strict('trunk').keepsStale, false)
  assert.match(strict('trunk').basis, /`trunk` ruleset could not be read/)
})

test("agit's own setup ruleset keeps stale approvals", () => {
  assert.equal(stalePolicy(wantedRules({ requiredCheck: 'ci' }), 'main').keepsStale, true)
})

test('a stale approval clears it when the ruleset keeps stale approvals, and says so', () => {
  const got = approve({ reviews: [review('jamesloosli', 'APPROVED', OLD)], policy: KEEPS })
  assert.ok(got.ok)
  assert.deepEqual(got.approvers, ['jamesloosli'])
  assert.deepEqual(got.approvals, [{ login: 'jamesloosli', commit: OLD, onHead: false }])
  assert.match(String(got.stale), /keeps stale approvals/)
})

test('an approval on the head reports no stale basis', () => {
  const got = approve({ policy: KEEPS })
  assert.ok(got.ok)
  assert.equal(got.stale, null)
  assert.deepEqual(got.approvals, [{ login: 'jamesloosli', commit: HEAD, onHead: true }])
})

test('a stale approval does not clear it when the ruleset dismisses stale approvals', () => {
  const got = approve({ reviews: [review('jamesloosli', 'APPROVED', OLD)], policy: DISMISSES })
  assert.equal(got.ok, false)
  assert.match(String(!got.ok && got.why), /1111111.*dismisses stale approvals/)
})

test('a stale approval does not clear it when the ruleset could not be read', () => {
  const got = approve({ reviews: [review('jamesloosli', 'APPROVED', OLD)], policy: stalePolicy(null, 'main') })
  assert.equal(got.ok, false)
  assert.match(String(!got.ok && got.why), /could not be read/)
})

test('a stale approval followed by CHANGES_REQUESTED still blocks, whatever the ruleset', () => {
  const got = approve({
    reviews: [
      review('jamesloosli', 'APPROVED', OLD, '2026-09-22T19:00:00Z'),
      review('jamesloosli', 'CHANGES_REQUESTED', OLD, '2026-09-22T20:00:00Z'),
    ],
    policy: KEEPS,
  })
  assert.equal(got.ok, false)
  assert.match(String(!got.ok && got.why), /requested changes/)
})

test('a stale approval later DISMISSED does not count, whatever the ruleset', () => {
  const got = approve({
    reviews: [
      review('jamesloosli', 'APPROVED', OLD, '2026-09-22T19:00:00Z'),
      review('jamesloosli', 'DISMISSED', OLD, '2026-09-22T20:00:00Z'),
    ],
    policy: KEEPS,
  })
  assert.equal(got.ok, false)
})

test('keeping stale approvals does not relax the per-path owner rule or the bot rule', () => {
  const perPath = approve({
    paths: ['packages/ci/src/ci.mjs', 'packages/agent-env/hooks/x.mjs'],
    reviews: [review('other-owner', 'APPROVED', OLD)],
    policy: KEEPS,
  })
  assert.equal(perPath.ok, false)
  assert.match(String(!perPath.ok && perPath.why), /packages\/ci\/src\/ci\.mjs/)
  assert.equal(approve({ reviews: [review('agit-app[bot]', 'APPROVED', OLD)], policy: KEEPS }).ok, false)
  assert.equal(approve({ reviews: [review('someone-else', 'APPROVED', OLD)], policy: KEEPS }).ok, false)
})
