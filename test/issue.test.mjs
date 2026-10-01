// @ts-check
/**
 * The issue reads and writes (src/github/issues.mjs) against the API
 * contract, and `agit issue` end to end: bodies from files (or stdin), JSON
 * on stdout, and a read that cannot complete is one line and nothing on
 * stdout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run as issueVerb, parse } from '../src/cli/issue.mjs'
import { PublishError } from '../src/errors.mjs'
import {
  assignIssue,
  bodyEtag,
  closeIssue,
  commentOnIssue,
  createIssue,
  editIssueBody,
  labelIssue,
  labelsOf,
  readIssue,
  UNREADABLE,
} from '../src/github/issues.mjs'
import { emptyDir, github } from './routes.mjs'

const ISSUE = '/repos/o/r/issues/7'
const at = (client) => ({ client, owner: 'o', repo: 'r', number: 7 })
/** @param {{ method: string, path: string, body: any }[]} calls */
const trace = (calls) => calls.map((c) => [c.method, c.path, c.body])

const issue7 = {
  number: 7,
  title: 'A bug',
  state: 'open',
  state_reason: null,
  body: 'body text',
  labels: [{ name: 'bug' }, { name: 'priority:low' }],
  assignees: [{ login: 'alice' }],
  user: { login: 'someone' },
  html_url: 'https://github.com/o/r/issues/7',
  comments: 2,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
  closed_at: null,
}

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

test('readIssue returns the issue with labels and assignees as plain names, and a body etag', async () => {
  const { client } = github({ [`GET ${ISSUE}`]: issue7 })
  assert.deepEqual(await readIssue(at(client)), {
    number: 7,
    title: 'A bug',
    state: 'open',
    stateReason: null,
    labels: ['bug', 'priority:low'],
    assignees: ['alice'],
    author: 'someone',
    body: 'body text',
    etag: 'd9fbbc91492fbb3ba8e57ca15b039134e7098030a89578315a4c354f9117ccf2',
    url: 'https://github.com/o/r/issues/7',
    comments: 2,
    pullRequest: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    closedAt: null,
  })
})

test('readIssue says when the number is a pull request', async () => {
  const { client } = github({ [`GET ${ISSUE}`]: { ...issue7, pull_request: { url: 'x' } } })
  assert.equal(/** @type {any} */ (await readIssue(at(client))).pullRequest, true)
})

test('labelsOf takes an issue or a label list, objects or strings', () => {
  assert.deepEqual(labelsOf(issue7), ['bug', 'priority:low'])
  assert.deepEqual(labelsOf([{ name: 'a' }, 'b']), ['a', 'b'])
  assert.deepEqual(labelsOf(null), [])
})

test('a read that cannot complete is UNREADABLE, never null, and records one line naming the status', async () => {
  for (const [label, routes, status] of /** @type {const} */ ([
    ['missing', {}, /404/],
    ['forbidden', { [`GET ${ISSUE}`]: { status: 403, body: { message: 'Resource not accessible by integration' } } }, /403/],
    ['not an issue', { [`GET ${ISSUE}`]: { message: 'odd' } }, /not an issue/],
  ])) {
    /** @type {{ what: string, error: string }[]} */
    const failures = []
    const out = await readIssue({ ...at(github(routes).client), failures })
    assert.equal(out, UNREADABLE, label)
    assert.equal(failures.length, 1, label)
    assert.equal(failures[0].what, 'o/r#7')
    assert.match(failures[0].error, status, label)
    assert.ok(!failures[0].error.includes('\n'), label)
  }
})

test('createIssue posts title, body and labels, and returns the new number', async () => {
  const { client, calls } = github({
    'POST /repos/o/r/issues': (body) => ({ number: 42, html_url: 'https://github.com/o/r/issues/42', ...body }),
  })
  const out = await createIssue({ client, owner: 'o', repo: 'r', title: 'T', body: 'B', labels: ['chore'] })
  assert.deepEqual(out, { number: 42, url: 'https://github.com/o/r/issues/42' })
  assert.deepEqual(trace(calls), [['POST', '/repos/o/r/issues', { title: 'T', body: 'B', labels: ['chore'] }]])
})

test('createIssue and commentOnIssue refuse an empty title or body before any request', async () => {
  const { client, calls } = github({})
  await assert.rejects(createIssue({ client, owner: 'o', repo: 'r', title: ' ', body: 'B' }), /title/)
  await assert.rejects(createIssue({ client, owner: 'o', repo: 'r', title: 'T', body: '\n' }), /body/)
  await assert.rejects(commentOnIssue({ ...at(client), body: '' }), /body/)
  assert.equal(calls.length, 0)
})

test('commentOnIssue posts the body and returns the comment id and url', async () => {
  const { client, calls } = github({ [`POST ${ISSUE}/comments`]: { id: 99, html_url: 'u#99' } })
  assert.deepEqual(await commentOnIssue({ ...at(client), body: 'hi' }), { id: 99, url: 'u#99' })
  assert.deepEqual(trace(calls), [['POST', `${ISSUE}/comments`, { body: 'hi' }]])
})

test('a refused write throws with the status — a write is never UNREADABLE', async () => {
  const { client } = github({ [`POST ${ISSUE}/comments`]: { status: 410, body: { message: 'Issues are disabled' } } })
  await assert.rejects(commentOnIssue({ ...at(client), body: 'hi' }), / 410 /)
})

test('closeIssue comments first, then closes with the reason', async () => {
  const { client, calls } = github({
    [`POST ${ISSUE}/comments`]: { id: 5, html_url: 'u#5' },
    [`PATCH ${ISSUE}`]: (body) => ({ ...issue7, ...body }),
  })
  const out = await closeIssue({ ...at(client), body: 'not doing this', reason: 'not_planned' })
  assert.deepEqual(out, { number: 7, state: 'closed', stateReason: 'not_planned', comment: { id: 5, url: 'u#5' } })
  assert.deepEqual(trace(calls), [
    ['POST', `${ISSUE}/comments`, { body: 'not doing this' }],
    ['PATCH', ISSUE, { state: 'closed', state_reason: 'not_planned' }],
  ])
})

test('closeIssue defaults to completed', async () => {
  const { client, calls } = github({
    [`POST ${ISSUE}/comments`]: { id: 5, html_url: 'u#5' },
    [`PATCH ${ISSUE}`]: (body) => ({ ...issue7, ...body }),
  })
  await closeIssue({ ...at(client), body: 'done' })
  assert.equal(calls[1].body.state_reason, 'completed')
})

test('closeIssue refuses an unknown reason or an empty body before any request', async () => {
  const { client, calls } = github({})
  await assert.rejects(closeIssue({ ...at(client), body: 'x', reason: 'wontfix' }), /reason 'wontfix'/)
  await assert.rejects(closeIssue({ ...at(client), body: ' ' }), /body/)
  assert.equal(calls.length, 0)
})

test('closeIssue does not close when the comment is refused', async () => {
  const { client, calls } = github({ [`POST ${ISSUE}/comments`]: { status: 403, body: { message: 'nope' } } })
  await assert.rejects(closeIssue({ ...at(client), body: 'x' }), / 403 /)
  assert.deepEqual(
    calls.map((c) => c.method),
    ['POST'],
  )
})

test('editIssueBody writes when the body is still the one that was read', async () => {
  const { client, calls } = github({
    [`GET ${ISSUE}`]: issue7,
    [`PATCH ${ISSUE}`]: (body) => ({ ...issue7, ...body }),
  })
  const out = await editIssueBody({ ...at(client), body: 'new body', etag: bodyEtag('body text') })
  assert.deepEqual(out, { number: 7, url: 'https://github.com/o/r/issues/7', etag: bodyEtag('new body') })
  assert.deepEqual(trace(calls), [
    ['GET', ISSUE, undefined],
    ['PATCH', ISSUE, { body: 'new body' }],
  ])
})

test('editIssueBody refuses on an etag mismatch rather than clobbering a concurrent edit', async () => {
  const { client, calls } = github({ [`GET ${ISSUE}`]: { ...issue7, body: 'someone else edited this' } })
  await assert.rejects(editIssueBody({ ...at(client), body: 'mine', etag: bodyEtag('body text') }), /body changed since it was read/)
  assert.ok(!calls.some((c) => c.method === 'PATCH'))
})

test('editIssueBody refuses without an etag or with an empty body, before any request', async () => {
  const { client, calls } = github({})
  await assert.rejects(editIssueBody({ ...at(client), body: 'x', etag: '' }), /etag/)
  await assert.rejects(editIssueBody({ ...at(client), body: '', etag: 'e' }), /body/)
  assert.equal(calls.length, 0)
})

test('assignIssue adds the login, keeping who is already assigned', async () => {
  const { client, calls } = github({
    [`GET ${ISSUE}`]: issue7,
    [`PATCH ${ISSUE}`]: (body) => ({ ...issue7, assignees: body.assignees.map((login) => ({ login })) }),
  })
  assert.deepEqual(await assignIssue({ ...at(client), login: 'bob' }), { number: 7, assignees: ['alice', 'bob'] })
  assert.deepEqual(calls[1].body, { assignees: ['alice', 'bob'] })
})

test('assignIssue throws when GitHub silently drops the login', async () => {
  const { client } = github({
    [`GET ${ISSUE}`]: { ...issue7, assignees: [] },
    [`PATCH ${ISSUE}`]: { ...issue7, assignees: [] },
  })
  await assert.rejects(assignIssue({ ...at(client), login: 'ghost' }), /did not assign ghost/)
})

test('labelIssue adds existing labels and removes others, returning what is left', async () => {
  const { client, calls } = github({
    'GET /repos/o/r/labels/priority%3Ahigh': { name: 'priority:high' },
    [`POST ${ISSUE}/labels`]: [{ name: 'bug' }, { name: 'priority:low' }, { name: 'priority:high' }],
    [`DELETE ${ISSUE}/labels/priority%3Alow`]: [{ name: 'bug' }, { name: 'priority:high' }],
  })
  const out = await labelIssue({ ...at(client), add: ['priority:high'], remove: ['priority:low'] })
  assert.deepEqual(out, { number: 7, labels: ['bug', 'priority:high'] })
  assert.deepEqual(trace(calls), [
    ['GET', '/repos/o/r/labels/priority%3Ahigh', undefined],
    ['POST', `${ISSUE}/labels`, { labels: ['priority:high'] }],
    ['DELETE', `${ISSUE}/labels/priority%3Alow`, undefined],
  ])
})

test('labelIssue treats removing a label the issue lacks as done', async () => {
  const { client } = github({
    [`DELETE ${ISSUE}/labels/gone`]: { status: 404, body: { message: 'Label does not exist' } },
    [`GET ${ISSUE}/labels`]: [{ name: 'bug' }],
  })
  assert.deepEqual(await labelIssue({ ...at(client), remove: ['gone'] }), { number: 7, labels: ['bug'] })
})

test('labelIssue still throws when the issue itself is missing', async () => {
  const { client } = github({ [`DELETE ${ISSUE}/labels/bug`]: { status: 404, body: { message: 'Not Found' } } })
  await assert.rejects(labelIssue({ ...at(client), remove: ['bug'] }), / 404 /)
})

test('labelIssue refuses to add a label the repo does not have — GitHub would create it', async () => {
  const { client, calls } = github({})
  await assert.rejects(labelIssue({ ...at(client), add: ['priorty:high'] }), /label 'priorty:high' does not exist/)
  assert.ok(!calls.some((c) => c.method === 'POST'))
})

test('labelIssue refuses nothing to do, or the same label both ways, before any request', async () => {
  const { client, calls } = github({})
  await assert.rejects(labelIssue(at(client)), /no labels/)
  await assert.rejects(labelIssue({ ...at(client), add: ['bug'], remove: ['bug'] }), /both added and removed/)
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/**
 * `agit issue` with stdout captured, bodies from `files`, and `stdin`.
 *
 * @param {Record<string, any>} routes
 * @param {Record<string, string>} [files]
 * @param {string} [stdin]
 */
function harness(routes, files = {}, stdin = '') {
  const gh = github(routes)
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const read = []
  const dir = emptyDir()
  const go = (/** @type {string[]} */ argv) =>
    issueVerb([...argv, '-C', dir, '--repo', 'o/r'], {
      client: gh.client,
      say: (l) => out.push(l),
      stdin: () => {
        read.push('-')
        return stdin
      },
      readFile: (p) => {
        read.push(p)
        if (!(p in files)) throw new Error(`ENOENT: ${p}`)
        return files[p]
      },
    })
  return { go, out, read, calls: gh.calls }
}

test('parse: a number with or without the #, bodies as paths', () => {
  for (const n of ['12', '#12']) assert.deepEqual(parse(['read', n]), { action: 'read', number: 12 })
  assert.deepEqual(parse(['create', '--title', 'T', '--body-file', 'b.md', '--labels', 'bug,area:ci']), {
    action: 'create',
    title: 'T',
    bodyFile: 'b.md',
    labels: ['bug', 'area:ci'],
  })
  assert.deepEqual(parse(['close', '7', '--body-file', 'c.md']), { action: 'close', number: 7, bodyFile: 'c.md', reason: 'completed' })
  assert.deepEqual(parse(['edit', '7', '--body-file', '-', '--etag', 'e']), { action: 'edit', number: 7, bodyFile: '-', etag: 'e' })
  assert.deepEqual(parse(['assign', '7', '--login', 'x']), { action: 'assign', number: 7, login: 'x' })
  assert.deepEqual(parse(['label', '7', '--add', 'a,b', '--remove', 'c']), { action: 'label', number: 7, add: ['a', 'b'], remove: ['c'] })
})

test('a malformed issue command is refused as usage before anything runs', () => {
  for (const argv of [
    [],
    ['resolve', '7', '--body-file', 'b'],
    ['read'],
    ['read', 'seven'],
    ['read', '7', '8'],
    ['create', '--body-file', 'b.md'],
    ['create', '--title', 'T'],
    ['comment', '7'],
    ['close', '7'],
    ['edit', '7', '--body-file', 'b.md'],
    ['edit', '7', '--etag', 'e'],
    ['assign', '7'],
    ['label', '7'],
  ])
    assert.throws(() => parse(argv), (e) => e instanceof PublishError && /usage: agit issue/.test(e.message), argv.join(' '))
})

test('an inline --body is refused with the flag to use instead', () => {
  assert.throws(() => parse(['comment', '7', '--body', 'x']), /--body-file/)
})

test('issue read prints the issue as JSON on stdout', async () => {
  const h = harness({ 'GET /repos/o/r/issues/12': { number: 12, title: 'T', state: 'open', labels: [{ name: 'bug' }], assignees: [] } })
  await h.go(['read', '12'])
  assert.equal(h.out.length, 1)
  const printed = JSON.parse(h.out[0])
  assert.equal(printed.number, 12)
  assert.deepEqual(printed.labels, ['bug'])
})

test('an unreadable issue read fails with one line, and prints nothing on stdout', async () => {
  const h = harness({})
  await assert.rejects(h.go(['read', '12']), (err) => {
    assert.ok(err instanceof PublishError, String(err))
    assert.match(err.message, /^issue read: o\/r#12 is unreadable: .*404/)
    assert.ok(!err.message.includes('\n'), err.message)
    return true
  })
  assert.deepEqual(h.out, [])
})

test('issue create reads the body from its file and prints the number as JSON', async () => {
  const h = harness({ 'POST /repos/o/r/issues': { number: 50, html_url: 'u/50' } }, { 'b.md': '## Why\n\n`x`\n' })
  await h.go(['create', '--title', 'T', '--body-file', 'b.md', '--labels', 'chore'])
  assert.deepEqual(h.read, ['b.md'])
  assert.deepEqual(h.calls[0].body, { title: 'T', body: '## Why\n\n`x`\n', labels: ['chore'] })
  assert.deepEqual(JSON.parse(h.out[0]), { number: 50, url: 'u/50' })
})

test('issue comment --body-file - reads the body from stdin', async () => {
  const h = harness({ [`POST ${ISSUE}/comments`]: { id: 3, html_url: 'u#3' } }, {}, 'from stdin')
  await h.go(['comment', '#7', '--body-file', '-'])
  assert.deepEqual(h.read, ['-'])
  assert.deepEqual(h.calls[0].body, { body: 'from stdin' })
  assert.deepEqual(JSON.parse(h.out[0]), { id: 3, url: 'u#3' })
})

test('a body file that cannot be read fails before any request is made', async () => {
  const h = harness({})
  await assert.rejects(h.go(['comment', '7', '--body-file', 'missing.md']), /ENOENT/)
  assert.equal(h.calls.length, 0)
})

test('issue close comments from the file, closes, and prints JSON', async () => {
  const h = harness(
    {
      [`POST ${ISSUE}/comments`]: { id: 3, html_url: 'u' },
      [`PATCH ${ISSUE}`]: (body) => ({ number: 7, ...body }),
    },
    { 'c.md': 'dup of #3' },
  )
  await h.go(['close', '7', '--body-file', 'c.md', '--reason', 'duplicate'])
  assert.deepEqual(JSON.parse(h.out[0]), { number: 7, state: 'closed', stateReason: 'duplicate', comment: { id: 3, url: 'u' } })
})

test('issue edit refuses a stale etag and writes nothing', async () => {
  const h = harness({ [`GET ${ISSUE}`]: { number: 7, body: 'changed' } }, { 'b.md': 'mine' })
  await assert.rejects(h.go(['edit', '7', '--body-file', 'b.md', '--etag', 'stale']), (e) => e instanceof PublishError && /changed since it was read/.test(e.message))
  assert.ok(!h.calls.some((c) => c.method === 'PATCH'))
  assert.deepEqual(h.out, [])
})

test('issue edit round-trips the etag issue read printed', async () => {
  const h = harness(
    {
      [`GET ${ISSUE}`]: { number: 7, body: 'old' },
      [`PATCH ${ISSUE}`]: (body) => ({ number: 7, ...body }),
    },
    { 'b.md': 'new' },
  )
  await h.go(['read', '7'])
  const { etag } = JSON.parse(h.out[0])
  await h.go(['edit', '7', '--body-file', 'b.md', '--etag', etag])
  assert.deepEqual(h.calls.at(-1)?.body, { body: 'new' })
})

test('issue assign and issue label print JSON and read no file', async () => {
  const h = harness({
    [`GET ${ISSUE}`]: { number: 7, assignees: [] },
    [`PATCH ${ISSUE}`]: (body) => ({ number: 7, assignees: body.assignees.map((login) => ({ login })) }),
    [`DELETE ${ISSUE}/labels/wontfix`]: [{ name: 'bug' }],
  })
  await h.go(['assign', '7', '--login', 'alice'])
  await h.go(['label', '7', '--remove', 'wontfix'])
  assert.deepEqual(JSON.parse(h.out[0]), { number: 7, assignees: ['alice'] })
  assert.deepEqual(JSON.parse(h.out[1]), { number: 7, labels: ['bug'] })
  assert.deepEqual(h.read, [])
})
