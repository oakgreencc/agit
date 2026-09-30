// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runApi, runGraphql } from '../src/cli/api.mjs'
import { PublishError } from '../src/errors.mjs'
import { graphqlMergeField, mutationRootFields, restMergeTarget } from '../src/raw-merge.mjs'

/** @type {[string, string, boolean][]} */
const rest = [
  ['PUT', '/repos/o/r/pulls/30/merge', true],
  ['put', '/repos/o/r/pulls/30/merge', true],
  ['POST', '/repos/o/r/pulls/30/merge', true],
  ['PUT', 'https://api.github.com/repos/o/r/pulls/30/merge', true],
  ['PUT', 'https://api.github.com//repos/o/r/pulls/30/merge/?x=1', true],
  ['PUT', '/repos/o/r/pulls/30/merge#frag', true],
  ['PUT', 'repos/o/r/pulls/30/merge', true],
  ['PUT', '/repos/o/r/pulls/30/%6Derge', true],
  ['PUT', '/repos/o/r/pulls/$N/merge', true],
  // Reading merge state is not merging.
  ['GET', '/repos/o/r/pulls/30/merge', false],
  ['GET', 'https://api.github.com/repos/o/r/pulls/30/merge', false],
  // update-branch lands nothing on the base.
  ['PUT', '/repos/o/r/pulls/30/update-branch', false],
  ['PATCH', '/repos/o/r/pulls/30', false],
  ['POST', '/repos/o/r/merges', false],
  ['PUT', '/repos/o/r/pulls/30/merge/extra', false],
]
for (const [method, path, want] of rest) {
  test(`rest ${method} ${path} → ${want ? 'merge' : 'passes'}`, () =>
    assert.equal(restMergeTarget({ method, path }) !== null, want))
}

/** @type {[string, string | null][]} */
const gql = [
  ['mutation{mergePullRequest(input:{pullRequestId:"PR_1"}){clientMutationId}}', 'mergePullRequest'],
  ['mutation M { enablePullRequestAutoMerge(input:{pullRequestId:"PR_1"}) { clientMutationId } }', 'enablePullRequestAutoMerge'],
  ['mutation { enqueuePullRequest(input:{pullRequestId:"PR_1"}) { clientMutationId } }', 'enqueuePullRequest'],
  // An alias does not hide the field.
  ['mutation { ok: mergePullRequest(input:{pullRequestId:"PR_1"}) { clientMutationId } }', 'mergePullRequest'],
  // Second root field, after a harmless one.
  ['mutation { addComment(input:{subjectId:"x",body:"hi"}){clientMutationId} m: mergePullRequest(input:{pullRequestId:"PR_1"}){clientMutationId} }', 'mergePullRequest'],
  // A second operation in the document.
  ['query Q { viewer { login } } mutation { mergePullRequest(input:{pullRequestId:"PR_1"}){clientMutationId} }', 'mergePullRequest'],
  // Queries pass, even when they name the field.
  ['query { repository(owner:"o",name:"r") { pullRequest(number:1) { mergePullRequest: title } } }', null],
  ['{ viewer { login } }', null],
  // A string, a comment, or an alias NAMED like the field is not the field.
  ['mutation { addComment(input:{subjectId:"x",body:"mergePullRequest please"}){clientMutationId} }', null],
  ['mutation { addComment(input:{subjectId:"x",body:"""enqueuePullRequest"""}){clientMutationId} }', null],
  ['# mergePullRequest\nmutation { addComment(input:{subjectId:"x",body:"y"}){clientMutationId} }', null],
  ['mutation { mergePullRequest: addComment(input:{subjectId:"x",body:"y"}){clientMutationId} }', null],
  // Nested, not a root field.
  ['mutation { addComment(input:{subjectId:"x",body:"y"}){ commentEdge { node { mergePullRequest } } } }', null],
]
for (const [query, want] of gql) {
  test(`graphql ${query.slice(0, 60)} → ${want ?? 'passes'}`, () => assert.equal(graphqlMergeField(query), want))
}

test('mutationRootFields resolves aliases and skips arguments', () => {
  assert.deepEqual(mutationRootFields('mutation { a: b(x: { c: "d" }) { e } f { g } }'), ['b', 'f'])
})

/** Runs `fn` and returns the PublishError it throws; fails on anything else. */
async function refusal(fn) {
  try {
    await fn()
  } catch (err) {
    assert.ok(err instanceof PublishError, `expected a PublishError, got ${err}`)
    return err.message
  }
  assert.fail('expected a refusal')
}

test('agit api refuses a raw REST merge before any client, naming the verb', async () => {
  const msg = await refusal(() => runApi(['PUT', 'https://api.github.com/repos/o/r/pulls/30/merge', '--body', '{}']))
  assert.match(msg, /this call merges o\/r#30 through the REST API/)
  assert.match(msg, /agit pr merge 30/)
})

test('agit graphql refuses a merge mutation before any client', async () => {
  const msg = await refusal(() => runGraphql(['mutation { m: enqueuePullRequest(input:{pullRequestId:"PR_1"}) { clientMutationId } }']))
  assert.match(msg, /this call queues a PR for merge through GraphQL/)
  assert.match(msg, /agit pr merge <n>/)
  assert.match(await refusal(() => runGraphql(['mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'])), /merges a PR through GraphQL/)
})

for (const flags of [
  ['--raw', '--paginate'],
  ['--raw', '--out', 'f.zip'],
  ['--paginate', '--out', 'f.zip'],
  ['--raw', '--paginate', '--out', 'f.zip'],
]) {
  test(`agit api refuses ${flags.filter((f) => f.startsWith('--')).join(' + ')}`, async () => {
    const msg = await refusal(() => runApi(['GET', '/repos/o/r/issues', ...flags]))
    assert.match(msg, /cannot be combined/)
    assert.match(msg, /^usage: agit api/m)
  })
}
