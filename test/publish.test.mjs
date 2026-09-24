// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PublishError,
  advance,
  commitOnGitHub,
  createCommit,
  localMerge,
  moveRef,
  publishMerge,
  publishTree,
  publishWorktree,
  resolveBranch,
  worktreeTree,
} from '../src/publish/publish.mjs'
import { createClient } from '../src/github/app.mjs'
import { clientOver } from './fixtures.mjs'

const sha = (c) => c.repeat(40)
const HEAD = sha('a')
const HEAD_TREE = sha('b')
const NEW_TREE = sha('c')
const MERGED = sha('d')
const BLOB_OLD = sha('1')
const BLOB_NEW = sha('2')
const BLOB_THEIRS = sha('3')

/**
 * A fake GitHub. `routes` maps `METHOD /path` to a handler `(body) => json`
 * (or a status number to fail with). Every call is recorded with its parsed
 * body so a test can assert on exactly what was sent — the point of the
 * commit-body test in particular. The client over it is the real one.
 */
function fakeClient(routes) {
  const calls = []
  const client = clientOver(async (method, path, body) => {
    calls.push({ method, path, body })
    const handler = routes[`${method} ${path}`]
    if (handler === undefined) throw new Error(`${path}: 404 {"message":"Not Found"}`)
    if (typeof handler === 'number') throw new Error(`${path}: ${handler} {"message":"nope"}`)
    return typeof handler === 'function' ? handler(body) : handler
  })
  return Object.assign(client, { calls })
}

/**
 * A fake git: `answers` maps the joined argv (or a prefix, via `startsWith`)
 * to stdout, and every call is recorded so a test can assert the sequence —
 * and, for advance, assert what was NOT run.
 */
function fakeGit(answers) {
  const calls = []
  const git = (args, opts = {}) => {
    calls.push({ args, env: opts.env ?? null })
    const key = args.join(' ')
    for (const [k, v] of Object.entries(answers)) {
      if (key === k || key.startsWith(`${k} `)) {
        if (v instanceof Error) throw v
        return typeof v === 'function' ? v(args, opts) : v
      }
    }
    throw new Error(`unexpected git ${key}`)
  }
  git.calls = calls
  git.ran = (prefix) => calls.filter((c) => c.args.join(' ').startsWith(prefix))
  return git
}

// The Git Database responses, in the shapes the research recorded (§2).
const commitResponse =
  (extra = {}) =>
  (body) => ({
    sha: sha('e'),
    html_url: 'https://github.com/o/r/commit/eeee',
    tree: { sha: body.tree },
    parents: body.parents.map((p) => ({ sha: p })),
    author: { name: 'sektor-agents[bot]' },
    committer: { name: 'GitHub', email: 'noreply@github.com' },
    verification: { verified: true, reason: 'valid' },
    ...extra,
  })

// --- reading GitHub --------------------------------------------------------------

test('resolveBranch returns { sha, tree } for a branch and null for a missing one', async () => {
  const client = fakeClient({
    'GET /repos/o/r/git/ref/heads/agent/x': { object: { sha: HEAD } },
    [`GET /repos/o/r/git/commits/${HEAD}`]: { sha: HEAD, tree: { sha: HEAD_TREE } },
  })
  assert.deepEqual(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }), {
    sha: HEAD,
    tree: HEAD_TREE,
  })
  assert.equal(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/none' }), null)
  assert.equal(await commitOnGitHub({ client, owner: 'o', repo: 'r', sha: sha('f') }), null)
})

test('resolveBranch propagates anything that is not a 404', async () => {
  const client = fakeClient({ 'GET /repos/o/r/git/ref/heads/agent/x': 403 })
  await assert.rejects(resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }), /403/)
})

// --- worktreeTree ------------------------------------------------------------------

test('worktreeTree builds the branch head plus the in-scope changes in a throwaway index', () => {
  const git = fakeGit({
    'status --porcelain -uall -z': ' M a.txt\u0000?? docs/new.md\u0000 M other.txt\u0000',
    'read-tree': '',
    'update-index': '',
    'write-tree': `${NEW_TREE}\n`,
  })
  const { tree, changed } = worktreeTree({
    git,
    base: HEAD,
    paths: ['a.txt', 'docs'],
    indexFile: '/tmp/idx',
  })
  assert.equal(tree, NEW_TREE)
  assert.deepEqual(changed, ['a.txt', 'docs/new.md'])
  // Every index operation ran against the temporary index, never the real one.
  const indexed = git.calls.filter((c) =>
    ['read-tree', 'update-index', 'write-tree'].includes(c.args[0]),
  )
  assert.equal(indexed.length, 3)
  assert.ok(indexed.every((c) => c.env?.GIT_INDEX_FILE === '/tmp/idx'))
  assert.deepEqual(git.ran('update-index')[0].args, [
    'update-index',
    '--add',
    '--remove',
    '--',
    'a.txt',
    'docs/new.md',
  ])
  assert.deepEqual(git.ran('read-tree')[0].args, ['read-tree', HEAD])
})

test('worktreeTree with nothing in scope builds nothing', () => {
  const git = fakeGit({ 'status --porcelain -uall -z': ' M other.txt\u0000' })
  assert.deepEqual(worktreeTree({ git, base: HEAD, paths: ['a.txt'], indexFile: '/tmp/idx' }), {
    tree: null,
    changed: [],
  })
  assert.equal(git.ran('read-tree').length, 0)
})

// --- publishTree -------------------------------------------------------------------

const DIFF = `:100644 100644 ${BLOB_OLD} ${BLOB_NEW} M\u0000a.txt\u0000:100644 000000 ${sha('4')} ${sha('0')} D\u0000gone.txt\u0000`

/** publishTree with the waits stubbed out; `pace` and `sleep` are what a test overrides. */
const ship = (over) =>
  publishTree({
    owner: 'o',
    repo: 'r',
    base: { sha: HEAD, tree: HEAD_TREE },
    tree: NEW_TREE,
    sleep: async () => {},
    pace: 0,
    ...over,
  })

test('publishTree ships text inline in the tree request — no blob POST — and checks the sha', async () => {
  const git = fakeGit({
    [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: DIFF,
    [`cat-file blob ${BLOB_NEW}`]: (_args, opts) => {
      assert.equal(opts.encoding, 'buffer')
      return Buffer.from('new content — ✓\n')
    },
  })
  const client = fakeClient({
    'POST /repos/o/r/git/trees': (body) => {
      assert.deepEqual(body, {
        base_tree: HEAD_TREE,
        tree: [
          { path: 'a.txt', mode: '100644', type: 'blob', content: 'new content — ✓\n' },
          { path: 'gone.txt', mode: '100644', type: 'blob', sha: null },
        ],
      })
      return { sha: NEW_TREE, truncated: false }
    },
  })
  const out = await ship({ git, client })
  assert.equal(out.tree, NEW_TREE)
  assert.deepEqual(out.uploaded, ['a.txt'])
  assert.deepEqual(out.inline, ['a.txt'])
  assert.deepEqual(out.posted, [])
  assert.equal(
    client.calls.some((c) => c.path.endsWith('/blobs')),
    false,
  )
})

test('publishTree posts a binary as its own blob, base64, and references it by sha', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])
  const git = fakeGit({
    [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: DIFF,
    [`cat-file blob ${BLOB_NEW}`]: png,
  })
  const client = fakeClient({
    'POST /repos/o/r/git/blobs': (body) => {
      assert.deepEqual(body, { content: png.toString('base64'), encoding: 'base64' })
      return { sha: BLOB_NEW }
    },
    'POST /repos/o/r/git/trees': (body) => {
      assert.deepEqual(body.tree[0], { path: 'a.txt', mode: '100644', type: 'blob', sha: BLOB_NEW })
      return { sha: NEW_TREE }
    },
  })
  const out = await ship({ git, client })
  assert.deepEqual(out.uploaded, ['a.txt'])
  assert.deepEqual(out.inline, [])
  assert.deepEqual(out.posted, ['a.txt'])
})

/** A diff of `n` added paths `f<i>` with blob shas derived from `i`. */
const manyAdded = (n) =>
  Array.from({ length: n }, (_, i) => {
    const s = String(i).padStart(40, '0')
    return `:000000 100644 ${sha('0')} ${s} A\u0000f${i}\u0000`
  }).join('')
const blobOf = (i) => String(i).padStart(40, '0')

test('publishTree paces blob POSTs: one at a time, `pace` ms apart, none before the first', async () => {
  const git = fakeGit({
    [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: manyAdded(3),
    'cat-file blob': (args) => Buffer.from([0x00, Number(args[2].slice(-1))]),
  })
  const order = []
  const client = fakeClient({
    'POST /repos/o/r/git/blobs': (body) => {
      order.push(`post ${Buffer.from(body.content, 'base64')[1]}`)
      return { sha: blobOf(Buffer.from(body.content, 'base64')[1]) }
    },
    'POST /repos/o/r/git/trees': { sha: NEW_TREE },
  })
  const reports = []
  const out = await ship({
    git,
    client,
    pace: 700,
    sleep: async (ms) => void order.push(`sleep ${ms}`),
    report: (l) => reports.push(l),
  })
  assert.deepEqual(order, ['post 0', 'sleep 700', 'post 1', 'sleep 700', 'post 2'])
  assert.deepEqual(out.posted, ['f0', 'f1', 'f2'])
  assert.deepEqual(reports, [
    'shipping 3 blobs: 0 inline in 0 tree requests, 3 posted one by one',
    'blob 1/3 f0',
    'blob 2/3 f1',
    'blob 3/3 f2',
  ])
})

test('publishTree splits inline content across chained tree requests within the byte budget, checking only the last', async () => {
  const git = fakeGit({
    [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: `${manyAdded(5)}:100644 000000 ${sha('4')} ${sha('0')} D\u0000gone.txt\u0000`,
    'cat-file blob': (args) => Buffer.from(`text ${args[2].slice(-1)}`), // 6 bytes each
  })
  const trees = []
  const client = fakeClient({
    'POST /repos/o/r/git/trees': (body) => {
      trees.push(body)
      return { sha: trees.length === 3 ? NEW_TREE : sha(String(trees.length)) }
    },
  })
  const out = await ship({ git, client, inlineBudget: 12 })
  assert.equal(trees.length, 3)
  // Each request builds on the tree the previous one produced.
  assert.deepEqual(
    trees.map((t) => t.base_tree),
    [HEAD_TREE, sha('1'), sha('2')],
  )
  assert.deepEqual(
    trees.map((t) => t.tree.map((e) => e.path)),
    [
      ['f0', 'f1'],
      ['f2', 'f3'],
      ['f4', 'gone.txt'],
    ],
  )
  assert.deepEqual(trees[2].tree, [
    { path: 'f4', mode: '100644', type: 'blob', content: 'text 4' },
    { path: 'gone.txt', mode: '100644', type: 'blob', sha: null },
  ])
  assert.deepEqual(out.inline, ['f0', 'f1', 'f2', 'f3', 'f4'])
  assert.deepEqual(out.uploaded, ['f0', 'f1', 'f2', 'f3', 'f4'])
})

test('publishTree falls back to blobs when the inline tree does not match — and refuses if that does not either', async () => {
  const git = fakeGit({
    [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: DIFF,
    [`cat-file blob ${BLOB_NEW}`]: Buffer.from('text\n'),
  })
  let inlineAnswer = sha('9')
  const treeBodies = []
  const routes = {
    'POST /repos/o/r/git/blobs': { sha: BLOB_NEW },
    'POST /repos/o/r/git/trees': (body) => {
      treeBodies.push(body)
      return { sha: body.tree.some((e) => e.content !== undefined) ? inlineAnswer : NEW_TREE }
    },
  }
  const reports = []
  const client = fakeClient(routes)
  const out = await ship({ git, client, report: (l) => reports.push(l) })
  assert.equal(out.tree, NEW_TREE)
  assert.deepEqual(out.posted, ['a.txt'])
  assert.deepEqual(out.inline, [])
  assert.equal(treeBodies.length, 2)
  assert.deepEqual(treeBodies[1].tree[0], {
    path: 'a.txt',
    mode: '100644',
    type: 'blob',
    sha: BLOB_NEW,
  })
  assert.ok(
    reports.some((l) => /built tree 9999999 from inline content.*re-shipping 1 path/.test(l)),
  )

  // Still wrong as blobs: that is the real refusal, before any commit.
  inlineAnswer = sha('9')
  routes['POST /repos/o/r/git/trees'] = () => ({ sha: sha('9') })
  await assert.rejects(
    ship({ git, client: fakeClient(routes) }),
    (err) => err instanceof PublishError && /not the tree that was validated/.test(err.message),
  )
})

/**
 * A fetch over the route table, so a test can run the REAL client — with its
 * rate-limit retry — against the fake. A route may answer `{ status, body,
 * headers }` to refuse; anything else is a 200 JSON body.
 */
function fetchFor(routes) {
  const calls = []
  /** @type {any} */
  const fetch = async (url, init = {}) => {
    const path = url.replace('https://api.github.com', '')
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const handler = routes[`${method} ${path}`]
    const answer = typeof handler === 'function' ? handler(body, calls.length) : handler
    const reply = (status, json, headers = {}) => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(json),
      headers: new Map(Object.entries(headers)),
    })
    if (answer === undefined) return reply(404, { message: 'Not Found' })
    if (answer?.status) return reply(answer.status, { message: answer.body }, answer.headers)
    return reply(200, answer)
  }
  fetch.calls = calls
  return fetch
}

test('a publish whose blob POSTs are rate-limited every third call still lands as one commit, each path uploaded once', async () => {
  const N = 7
  const git = fakeGit({
    'status --porcelain -uall -z': Array.from({ length: N }, (_, i) => `?? f${i}\u0000`).join(''),
    'read-tree': '',
    'update-index': '',
    'write-tree': `${NEW_TREE}\n`,
    [`ls-tree -r -z ${HEAD}`]: '',
    [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: manyAdded(N),
    'cat-file blob': (args) => Buffer.from([0x00, Number(args[2].slice(-1))]), // binary: one POST each
  })
  let blobPosts = 0
  const landed = []
  const fetch = fetchFor({
    'POST /repos/o/r/git/blobs': (body) => {
      blobPosts++
      if (blobPosts % 3 === 0) {
        // The third refusal carries no retry-after at all: the backoff rule.
        return blobPosts === 9
          ? { status: 403, body: 'You have exceeded a secondary rate limit.' }
          : {
              status: 403,
              body: 'You have exceeded a secondary rate limit.',
              headers: { 'retry-after': '1' },
            }
      }
      const i = Buffer.from(body.content, 'base64')[1]
      landed.push(`f${i}`)
      return { sha: blobOf(i) }
    },
    'POST /repos/o/r/git/trees': { sha: NEW_TREE },
    'POST /repos/o/r/git/commits': commitResponse(),
    'PATCH /repos/o/r/git/refs/heads/agent/x': {},
  })
  const waits = []
  const client = createClient({ token: 't', fetch, sleep: async (ms) => void waits.push(ms) })
  const out = await publishWorktree({
    git,
    client,
    owner: 'o',
    repo: 'r',
    branch: 'agent/x',
    head: { sha: HEAD, tree: HEAD_TREE },
    base: null,
    message: 'feat: many',
    indexFile: '/tmp/idx',
    sleep: async () => {},
    pace: 0,
  })
  assert.equal(out.commit.sha, sha('e'))
  // Every path landed exactly once, in order; the refusals were retried, not skipped.
  assert.deepEqual(
    landed,
    Array.from({ length: N }, (_, i) => `f${i}`),
  )
  assert.equal(blobPosts, N + 3)
  assert.deepEqual(waits, [1_000, 1_000, 60_000])
  const writes = fetch.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/blobs'))
  assert.deepEqual(
    writes.map((c) => `${c.method} ${c.path}`),
    [
      'POST /repos/o/r/git/trees',
      'POST /repos/o/r/git/commits',
      'PATCH /repos/o/r/git/refs/heads/agent/x',
    ],
  )
})

test('publishTree skips blobs GitHub already has', async () => {
  const git = fakeGit({ [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: DIFF })
  const client = fakeClient({ 'POST /repos/o/r/git/trees': { sha: NEW_TREE } })
  const out = await publishTree({
    git,
    client,
    owner: 'o',
    repo: 'r',
    base: { sha: HEAD, tree: HEAD_TREE },
    tree: NEW_TREE,
    known: new Set([BLOB_NEW]),
  })
  assert.deepEqual(out.uploaded, [])
  assert.equal(client.calls.filter((c) => c.path.endsWith('/blobs')).length, 0)
})

test("publishTree refuses when GitHub's tree sha differs from the local one — before any commit", async () => {
  const git = fakeGit({ [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: DIFF })
  const client = fakeClient({ 'POST /repos/o/r/git/trees': { sha: sha('9') } })
  await assert.rejects(
    publishTree({
      git,
      client,
      owner: 'o',
      repo: 'r',
      base: { sha: HEAD, tree: HEAD_TREE },
      tree: NEW_TREE,
      known: new Set([BLOB_NEW]),
    }),
    (err) => err instanceof PublishError && /not the tree that was validated/.test(err.message),
  )
  assert.equal(
    client.calls.some((c) => c.path.endsWith('/commits')),
    false,
  )
})

test('publishTree refuses a posted blob that uploaded under a different sha', async () => {
  const git = fakeGit({
    [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: DIFF,
    [`cat-file blob ${BLOB_NEW}`]: Buffer.from([0x00, 0x01]),
  })
  const client = fakeClient({ 'POST /repos/o/r/git/blobs': { sha: sha('9') } })
  await assert.rejects(ship({ git, client }), /uploaded as 9999999 but is 2222222 locally/)
  assert.equal(
    client.calls.some((c) => c.path.endsWith('/trees')),
    false,
  )
})

test('publishTree has nothing to do when the tree is the head tree', async () => {
  const git = fakeGit({})
  const client = fakeClient({})
  await assert.rejects(
    publishTree({
      git,
      client,
      owner: 'o',
      repo: 'r',
      base: { sha: HEAD, tree: HEAD_TREE },
      tree: HEAD_TREE,
    }),
    /nothing to publish/,
  )
})

// --- createCommit: the request that decides Verified ---------------------------

test('createCommit sends message, tree and parents and nothing else, and reads the verification back', async () => {
  const client = fakeClient({ 'POST /repos/o/r/git/commits': commitResponse() })
  const out = await createCommit({
    client,
    owner: 'o',
    repo: 'r',
    message: 'feat: x\n\nbody',
    tree: NEW_TREE,
    parents: [HEAD, MERGED],
  })
  const [call] = client.calls
  assert.deepEqual(Object.keys(call.body).sort(), ['message', 'parents', 'tree'])
  assert.deepEqual(call.body, {
    message: 'feat: x\n\nbody',
    tree: NEW_TREE,
    parents: [HEAD, MERGED],
  })
  assert.deepEqual(out, {
    sha: sha('e'),
    url: 'https://github.com/o/r/commit/eeee',
    verified: true,
    reason: 'valid',
  })
})

test('createCommit refuses an author, committer or signature rather than forwarding it', async () => {
  const client = fakeClient({ 'POST /repos/o/r/git/commits': commitResponse() })
  for (const extra of [
    {
      author: {
        name: 'sektor-agents[bot]',
        email: '312147635+sektor-agents[bot]@users.noreply.github.com',
      },
    },
    { committer: { name: 'GitHub', email: 'noreply@github.com' } },
    { signature: '-----BEGIN PGP SIGNATURE-----' },
  ]) {
    await assert.rejects(
      createCommit({
        client,
        owner: 'o',
        repo: 'r',
        message: 'm',
        tree: NEW_TREE,
        parents: [HEAD],
        ...extra,
      }),
      /may carry only message, tree, parents/,
    )
  }
  assert.equal(client.calls.length, 0)
})

test('createCommit reports an unsigned result as verified: false', async () => {
  const client = fakeClient({
    'POST /repos/o/r/git/commits': commitResponse({
      verification: { verified: false, reason: 'unsigned' },
    }),
  })
  const out = await createCommit({
    client,
    owner: 'o',
    repo: 'r',
    message: 'm',
    tree: NEW_TREE,
    parents: [HEAD],
  })
  assert.equal(out.verified, false)
  assert.equal(out.reason, 'unsigned')
})

// --- moveRef -----------------------------------------------------------------------

test('moveRef fast-forwards an existing branch and creates a missing one', async () => {
  const client = fakeClient({
    'PATCH /repos/o/r/git/refs/heads/agent/x': (body) => ({ object: { sha: body.sha } }),
    'POST /repos/o/r/git/refs': (body) => ({ ref: body.ref }),
  })
  assert.deepEqual(
    await moveRef({ client, owner: 'o', repo: 'r', branch: 'agent/x', sha: sha('e') }),
    { created: false },
  )
  assert.deepEqual(client.calls[0].body, { sha: sha('e'), force: false })
  assert.deepEqual(
    await moveRef({
      client,
      owner: 'o',
      repo: 'r',
      branch: 'agent/x',
      sha: sha('e'),
      create: true,
    }),
    { created: true },
  )
  assert.deepEqual(client.calls[1].body, { ref: 'refs/heads/agent/x', sha: sha('e') })
})

test('moveRef never forces: a branch that moved is a 422 from GitHub, surfaced as-is', async () => {
  const client = fakeClient({ 'PATCH /repos/o/r/git/refs/heads/agent/x': 422 })
  await assert.rejects(
    moveRef({ client, owner: 'o', repo: 'r', branch: 'agent/x', sha: sha('e') }),
    /422/,
  )
})

// --- localMerge --------------------------------------------------------------------

test('localMerge reads a completed two-parent merge whose first parent is the branch head', () => {
  const git = fakeGit({
    'rev-list --parents -n 1 HEAD': `${sha('e')} ${HEAD} ${MERGED}\n`,
    'rev-parse HEAD^{tree}': `${NEW_TREE}\n`,
    'log -1 --format=%B HEAD': "Merge branch 'develop' into agent/x\n\n",
  })
  assert.deepEqual(localMerge({ git, branchHead: HEAD }), {
    kind: 'merge',
    sha: sha('e'),
    tree: NEW_TREE,
    parents: [HEAD, MERGED],
    message: "Merge branch 'develop' into agent/x",
  })
})

test('localMerge refuses a merge made on a stale worktree', () => {
  const git = fakeGit({ 'rev-list --parents -n 1 HEAD': `${sha('e')} ${sha('f')} ${MERGED}\n` })
  assert.throws(
    () => localMerge({ git, branchHead: HEAD }),
    (err) => err instanceof PublishError && /behind the branch/.test(err.message),
  )
})

test('localMerge recognises a fast-forward and refuses an octopus', () => {
  assert.deepEqual(
    localMerge({
      git: fakeGit({ 'rev-list --parents -n 1 HEAD': `${MERGED} ${HEAD}\n` }),
      branchHead: HEAD,
    }),
    {
      kind: 'fast-forward',
      sha: MERGED,
      parents: [HEAD],
    },
  )
  assert.throws(
    () =>
      localMerge({
        git: fakeGit({
          'rev-list --parents -n 1 HEAD': `${sha('e')} ${HEAD} ${MERGED} ${sha('f')}\n`,
        }),
        branchHead: HEAD,
      }),
    /exactly two/,
  )
})

// --- advance -----------------------------------------------------------------------

const NEVER = ['reset --hard', 'checkout --', 'checkout -- ', 'clean']
const assertNoDestructiveGit = (git) => {
  for (const c of git.calls) {
    const s = c.args.join(' ')
    assert.ok(
      !NEVER.some((n) => s.startsWith(n) || s.includes(` ${n}`)),
      `destructive git ran: ${s}`,
    )
  }
}

test('advance after a publish: HEAD moves, untouched paths follow the branch, published paths are recorded, nothing is discarded', () => {
  const git = fakeGit({
    'rev-parse HEAD': `${HEAD}\n`,
    [`merge-base --is-ancestor ${HEAD} ${sha('e')}`]: '',
    'status --porcelain -uall -z': ' M a.txt\u0000 M wip.txt\u0000',
    [`diff --name-only -z ${HEAD} ${sha('e')}`]: 'a.txt\u0000theirs.txt\u0000',
    [`ls-tree -r -z ${sha('e')} -- a.txt`]: `100644 blob ${BLOB_NEW}\ta.txt\u0000`,
    'hash-object -- a.txt': `${BLOB_NEW}\n`,
    'reset --soft': '',
    restore: '',
    'update-index': '',
  })
  const out = advance({ git, target: sha('e') })
  assert.deepEqual(out, {
    advanced: true,
    from: HEAD,
    to: sha('e'),
    restored: ['theirs.txt'],
    recorded: ['a.txt'],
  })
  assertNoDestructiveGit(git)
  const seq = git.calls
    .map((c) => c.args.join(' '))
    .filter((s) => /^(reset|restore|update-index)/.test(s))
  assert.deepEqual(seq, [
    `reset --soft ${sha('e')}`,
    `restore --source=${sha('e')} --staged --worktree -- theirs.txt`,
    'update-index --add --remove -- a.txt',
  ])
  // wip.txt — dirty, but not changed on the branch — was not mentioned to git at all.
  assert.ok(!git.calls.some((c) => c.args.includes('wip.txt')))
})

test('advance refuses when a locally modified path changed on the branch with different content, and moves nothing', () => {
  const git = fakeGit({
    'rev-parse HEAD': `${HEAD}\n`,
    [`merge-base --is-ancestor ${HEAD} ${sha('e')}`]: '',
    'status --porcelain -uall -z': ' M a.txt\u0000',
    [`diff --name-only -z ${HEAD} ${sha('e')}`]: 'a.txt\u0000',
    [`ls-tree -r -z ${sha('e')} -- a.txt`]: `100644 blob ${BLOB_THEIRS}\ta.txt\u0000`,
    'hash-object -- a.txt': `${BLOB_NEW}\n`,
  })
  assert.throws(
    () => advance({ git, target: sha('e') }),
    (err) => err instanceof PublishError && /refusing to advance: 1 path changed/.test(err.message),
  )
  assert.equal(git.ran('reset').length, 0)
  assert.equal(git.ran('restore').length, 0)
})

test('advance does not move HEAD past local commits the branch does not have', () => {
  const git = fakeGit({
    'rev-parse HEAD': `${sha('f')}\n`,
    [`merge-base --is-ancestor ${sha('f')} ${sha('e')}`]: new Error('exit 1'),
    [`rev-parse ${sha('f')}^{tree}`]: `${sha('1')}\n`,
    [`rev-parse ${sha('e')}^{tree}`]: `${sha('2')}\n`,
    [`for-each-ref --contains=${sha('f')} refs/remotes/`]: '',
  })
  const out = advance({ git, target: sha('e') })
  assert.equal(out.advanced, false)
  assert.match(String(out.reason), /commits that are not on the branch/)
  assert.equal(git.ran('reset').length, 0)
})

test('advance after a merge publish: the local merge commit is left behind for its Verified equivalent', () => {
  // HEAD is the local merge commit (parents [head, develop]); target is the
  // App-made commit with the same tree and parents. Not an ancestor — a
  // different sha — but nothing is lost by moving past it.
  const LOCAL = sha('f')
  const git = fakeGit({
    'rev-parse HEAD': `${LOCAL}\n`,
    [`merge-base --is-ancestor ${LOCAL} ${sha('e')}`]: new Error('exit 1'),
    [`rev-parse ${LOCAL}^{tree}`]: `${NEW_TREE}\n`,
    [`rev-parse ${sha('e')}^{tree}`]: `${NEW_TREE}\n`,
    [`rev-list --parents -n 1 ${LOCAL}`]: `${LOCAL} ${HEAD} ${MERGED}\n`,
    [`merge-base --is-ancestor ${HEAD} ${sha('e')}`]: '',
    'status --porcelain -uall -z': '',
    [`diff --name-only -z ${LOCAL} ${sha('e')}`]: '',
    'reset --soft': '',
  })
  const out = advance({ git, target: sha('e') })
  assert.deepEqual(out, { advanced: true, from: LOCAL, to: sha('e'), restored: [], recorded: [] })
  assert.deepEqual(git.ran('reset')[0].args, ['reset', '--soft', sha('e')])
})

test('advance still refuses a local commit whose tree matches but whose parent is not on the branch', () => {
  const LOCAL = sha('f')
  const git = fakeGit({
    'rev-parse HEAD': `${LOCAL}\n`,
    [`merge-base --is-ancestor ${LOCAL} ${sha('e')}`]: new Error('exit 1'),
    [`rev-parse ${LOCAL}^{tree}`]: `${NEW_TREE}\n`,
    [`rev-parse ${sha('e')}^{tree}`]: `${NEW_TREE}\n`,
    [`rev-list --parents -n 1 ${LOCAL}`]: `${LOCAL} ${sha('9')}\n`,
    [`merge-base --is-ancestor ${sha('9')} ${sha('e')}`]: new Error('exit 1'),
    [`for-each-ref --contains=${LOCAL} refs/remotes/`]: '',
  })
  assert.equal(advance({ git, target: sha('e') }).advanced, false)
})

test('advance moves off a HEAD that origin already holds, even when it is not an ancestor of the target (stacking)', () => {
  // A worktree at develop's tip layering onto an agent branch cut from an
  // older develop: HEAD is not an ancestor of the target, but nothing on it
  // is local work — origin/develop contains it.
  const DEV = sha('f')
  const git = fakeGit({
    'rev-parse HEAD': `${DEV}\n`,
    [`merge-base --is-ancestor ${DEV} ${sha('e')}`]: new Error('exit 1'),
    [`rev-parse ${DEV}^{tree}`]: `${sha('1')}\n`,
    [`rev-parse ${sha('e')}^{tree}`]: `${sha('2')}\n`,
    [`for-each-ref --contains=${DEV} refs/remotes/`]: `${DEV} commit\trefs/remotes/origin/develop\n`,
    'status --porcelain -uall -z': '',
    [`diff --name-only -z ${DEV} ${sha('e')}`]: 'a.txt\u0000',
    'reset --soft': '',
    restore: '',
  })
  const out = advance({ git, target: sha('e') })
  assert.deepEqual(out, {
    advanced: true,
    from: DEV,
    to: sha('e'),
    restored: ['a.txt'],
    recorded: [],
  })
})

test('advance treats a deleted-and-published path as recorded, and a no-op target as done', () => {
  const git = fakeGit({
    'rev-parse HEAD': `${HEAD}\n`,
    [`merge-base --is-ancestor ${HEAD} ${sha('e')}`]: '',
    'status --porcelain -uall -z': 'D  gone.txt\u0000',
    [`diff --name-only -z ${HEAD} ${sha('e')}`]: 'gone.txt\u0000',
    [`ls-tree -r -z ${sha('e')} -- gone.txt`]: '',
    'hash-object -- gone.txt': new Error('fatal: could not open'),
    'reset --soft': '',
    'update-index': '',
  })
  assert.deepEqual(advance({ git, target: sha('e') }).recorded, ['gone.txt'])
  assert.deepEqual(advance({ git: fakeGit({ 'rev-parse HEAD': `${HEAD}\n` }), target: HEAD }), {
    advanced: true,
    from: HEAD,
    to: HEAD,
    restored: [],
    recorded: [],
  })
})

// --- the composed publishes ------------------------------------------------------

test('publishWorktree: tree → commit with one parent → fast-forward the ref', async () => {
  const git = fakeGit({
    'status --porcelain -uall -z': ' M a.txt\u0000',
    'read-tree': '',
    'update-index': '',
    'write-tree': `${NEW_TREE}\n`,
    [`ls-tree -r -z ${HEAD}`]: `100644 blob ${BLOB_OLD}\ta.txt\u0000`,
    [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: `:100644 100644 ${BLOB_OLD} ${BLOB_NEW} M\u0000a.txt\u0000`,
    [`cat-file blob ${BLOB_NEW}`]: Buffer.from('x'),
  })
  const client = fakeClient({
    'POST /repos/o/r/git/blobs': { sha: BLOB_NEW },
    'POST /repos/o/r/git/trees': { sha: NEW_TREE },
    'POST /repos/o/r/git/commits': commitResponse(),
    'PATCH /repos/o/r/git/refs/heads/agent/x': {},
  })
  const out = await publishWorktree({
    git,
    client,
    owner: 'o',
    repo: 'r',
    branch: 'agent/x',
    head: { sha: HEAD, tree: HEAD_TREE },
    base: { sha: sha('9'), tree: sha('8') },
    message: 'feat: x',
    paths: ['a.txt'],
    indexFile: '/tmp/idx',
  })
  assert.equal(out.commit.sha, sha('e'))
  assert.equal(out.created, false)
  // Text rides inline in the tree request, so a small publish is three writes.
  assert.deepEqual(
    client.calls.map((c) => `${c.method} ${c.path}`),
    [
      'POST /repos/o/r/git/trees',
      'POST /repos/o/r/git/commits',
      'PATCH /repos/o/r/git/refs/heads/agent/x',
    ],
  )
  assert.deepEqual(client.calls[0].body.tree, [
    { path: 'a.txt', mode: '100644', type: 'blob', content: 'x' },
  ])
  assert.deepEqual(client.calls[1].body.parents, [HEAD])
})

test('publishWorktree on a new branch builds on the base and creates the ref pointing at the commit — no empty branch first', async () => {
  const BASE = { sha: sha('9'), tree: sha('8') }
  const git = fakeGit({
    'status --porcelain -uall -z': '?? new.txt\u0000',
    'read-tree': '',
    'update-index': '',
    'write-tree': `${NEW_TREE}\n`,
    [`ls-tree -r -z ${BASE.sha}`]: '',
    [`diff-tree -r --no-renames -z ${BASE.sha} ${NEW_TREE}`]: `:000000 100644 ${sha('0')} ${BLOB_NEW} A\u0000new.txt\u0000`,
    [`cat-file blob ${BLOB_NEW}`]: Buffer.from('x'),
  })
  const client = fakeClient({
    'POST /repos/o/r/git/blobs': { sha: BLOB_NEW },
    'POST /repos/o/r/git/trees': { sha: NEW_TREE },
    'POST /repos/o/r/git/commits': commitResponse(),
    'POST /repos/o/r/git/refs': {},
  })
  const out = await publishWorktree({
    git,
    client,
    owner: 'o',
    repo: 'r',
    branch: 'agent/x',
    head: null,
    base: BASE,
    message: 'm',
    indexFile: '/tmp/idx',
  })
  assert.equal(out.created, true)
  assert.deepEqual(client.calls.at(-1).body, { ref: 'refs/heads/agent/x', sha: sha('e') })
  assert.deepEqual(client.calls[1].body.parents, [BASE.sha])
  assert.deepEqual(git.ran('read-tree')[0].args, ['read-tree', BASE.sha])
})

test('publishMerge: the resolved tree lands as a two-parent commit, parents [head, merged-in], no author', async () => {
  const git = fakeGit({
    'rev-list --parents -n 1 HEAD': `${sha('e')} ${HEAD} ${MERGED}\n`,
    'rev-parse HEAD^{tree}': `${NEW_TREE}\n`,
    'log -1 --format=%B HEAD': "Merge branch 'develop' into agent/x\n",
    [`ls-tree -r -z ${HEAD}`]: `100644 blob ${BLOB_OLD}\ta.txt\u0000`,
    [`ls-tree -r -z ${MERGED}`]: `100644 blob ${BLOB_THEIRS}\ttheirs.txt\u0000`,
    [`diff-tree -r --no-renames -z ${HEAD} ${NEW_TREE}`]: `:100644 100644 ${BLOB_OLD} ${BLOB_NEW} M\u0000a.txt\u0000:000000 100644 ${sha('0')} ${BLOB_THEIRS} A\u0000theirs.txt\u0000`,
    [`cat-file blob ${BLOB_NEW}`]: Buffer.from('resolved'),
  })
  const client = fakeClient({
    [`GET /repos/o/r/git/commits/${MERGED}`]: { sha: MERGED, tree: { sha: sha('7') } },
    'POST /repos/o/r/git/blobs': { sha: BLOB_NEW },
    'POST /repos/o/r/git/trees': { sha: NEW_TREE },
    'POST /repos/o/r/git/commits': commitResponse(),
    'PATCH /repos/o/r/git/refs/heads/agent/x': {},
  })
  const out = await publishMerge({
    git,
    client,
    owner: 'o',
    repo: 'r',
    branch: 'agent/x',
    head: { sha: HEAD, tree: HEAD_TREE },
  })
  assert.equal(out.kind, 'merge')
  assert.deepEqual(out.parents, [HEAD, MERGED])
  // Only the conflict resolution was uploaded; the other side's blob is
  // already on GitHub as part of the merged-in commit.
  assert.deepEqual(out.shipped.uploaded, ['a.txt'])
  const commit = client.calls.find((c) => c.path.endsWith('/git/commits') && c.method === 'POST')
  assert.deepEqual(commit.body, {
    message: "Merge branch 'develop' into agent/x",
    tree: NEW_TREE,
    parents: [HEAD, MERGED],
  })
  assert.deepEqual(client.calls.at(-1).body, { sha: sha('e'), force: false })
})

test('publishMerge refuses a merged-in commit GitHub does not have', async () => {
  const git = fakeGit({
    'rev-list --parents -n 1 HEAD': `${sha('e')} ${HEAD} ${MERGED}\n`,
    'rev-parse HEAD^{tree}': `${NEW_TREE}\n`,
    'log -1 --format=%B HEAD': 'm\n',
  })
  const client = fakeClient({})
  await assert.rejects(
    publishMerge({
      git,
      client,
      owner: 'o',
      repo: 'r',
      branch: 'agent/x',
      head: { sha: HEAD, tree: HEAD_TREE },
    }),
    /merged-in commit ddddddd is not on GitHub/,
  )
})

test('publishMerge fast-forwards the ref when git fast-forwarded locally', async () => {
  const git = fakeGit({ 'rev-list --parents -n 1 HEAD': `${MERGED} ${HEAD}\n` })
  const client = fakeClient({
    [`GET /repos/o/r/git/commits/${MERGED}`]: { sha: MERGED, tree: { sha: sha('7') } },
    'PATCH /repos/o/r/git/refs/heads/agent/x': {},
  })
  const out = await publishMerge({
    git,
    client,
    owner: 'o',
    repo: 'r',
    branch: 'agent/x',
    head: { sha: HEAD, tree: HEAD_TREE },
  })
  assert.equal(out.kind, 'fast-forward')
  assert.deepEqual(client.calls.at(-1).body, { sha: MERGED, force: false })
})
