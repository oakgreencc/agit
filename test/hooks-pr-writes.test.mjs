// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findTargets, reasonFor } from '../src/hooks/guard-pr-writes.mjs'

const A = 'agit api'
/** @type {[string, number][]} */
const cases = [
  ['git status', 0],
  ['ls /repos/foo/bar', 0],
  [`${A} GET /repos/o/r/pulls/30`, 0],
  // Reading merge state is not merging.
  [`${A} GET /repos/o/r/pulls/30/merge`, 0],
  // The policy-carrying verb itself.
  ['agit pr merge 30', 0],
  ['agit pr merge 30 --auto --method squash', 0],
  ['agit pr update 30', 0],
  // update-branch lands nothing on the base.
  [`${A} PUT /repos/o/r/pulls/29/update-branch`, 0],
  // Raw merges, however spelled.
  [`${A} PUT '/repos/o/r/pulls/30/merge' --body '{"merge_method":"merge"}'`, 1],
  ['curl -X PUT https://api.github.com/repos/o/r/pulls/30/merge', 1],
  [`echo hi && ${A} PUT /repos/o/r/pulls/30/merge`, 1],
  [`bash -c "${A} PUT /repos/o/r/pulls/30/merge"`, 1],
  [`${A} PUT /repos/o/r/pulls/29/merge && ${A} PUT /repos/o/r/pulls/30/merge`, 2],
  // A non-literal number is still a merge.
  [`${A} PUT "/repos/o/r/pulls/$N/merge"`, 1],
  // Auto-merge through GraphQL.
  ['agit graphql \'mutation{enablePullRequestAutoMerge(input:{pullRequestId:"PR_kwABC"}){clientMutationId}}\'', 1],
]
for (const [cmd, want] of cases) {
  test(`${want} merge write(s): ${cmd}`, () => assert.equal(findTargets(cmd).length, want))
}

test('the denial names the verb, with the PR number when literal', () => {
  const text = reasonFor(findTargets(`${A} PUT /repos/o/r/pulls/30/merge`))
  assert.match(text, /agit pr merge 30/)
  assert.match(text, /`merge` scope/)
  assert.match(reasonFor(findTargets(`${A} PUT /repos/o/r/pulls/$N/merge`)), /agit pr merge <n>/)
  assert.match(reasonFor(findTargets('agit graphql "enablePullRequestAutoMerge"')), /auto-merge/)
})
