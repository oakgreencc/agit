// @ts-check
/**
 * The GitHub port: the client's own behaviour (paging, absence, bytes), and
 * `agit pr merge` end to end — the real verb, the real client, a bare repo
 * standing in for GitHub (fixtures.mjs). Until the fake could answer every
 * call the verb makes, none of its orchestration could run in a test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { explain } from '../src/cli/explain.mjs'
import { run as pr } from '../src/cli/pr.mjs'
import { PublishError } from '../src/errors.mjs'
import { createClient, isNotFound } from '../src/github/app.mjs'
import { clientOver, commitOn, run, scenario } from './fixtures.mjs'

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** A fetch serving `pages[url]` = [status, body, link?]. */
const pagedFetch = (pages) => /** @type {typeof globalThis.fetch} */ (async (url) => {
  const [status, body, link] = pages[String(url)] ?? [404, '{"message":"Not Found"}']
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: link ? { link: `<${link}>; rel="next"` } : {},
  })
})
const API = 'https://api.github.com'

test('paginate: array pages concatenated by Link: rel="next"', async () => {
  const client = createClient({
    token: 't',
    fetch: pagedFetch({ [`${API}/l`]: [200, [1, 2], `${API}/l?page=2`], [`${API}/l?page=2`]: [200, [3]] }),
  })
  assert.deepEqual(await client.paginate('/l'), [1, 2, 3])
})

test('paginate: a wrapped list is concatenated on its one array key; a non-list comes back as is', async () => {
  const client = createClient({
    token: 't',
    fetch: pagedFetch({
      [`${API}/w`]: [200, { total_count: 3, jobs: [{ id: 1 }] }, `${API}/w?page=2`],
      [`${API}/w?page=2`]: [200, { total_count: 3, jobs: [{ id: 2 }, { id: 3 }] }],
      [`${API}/one`]: [200, { id: 9 }],
    }),
  })
  assert.deepEqual(await client.paginate('/w'), { total_count: 3, jobs: [{ id: 1 }, { id: 2 }, { id: 3 }] })
  assert.deepEqual(await client.paginate('/one'), { id: 9 })
})

test('getOrNull: 404 is null; any other refusal still throws, with its status', async () => {
  const client = createClient({ token: 't', fetch: pagedFetch({ [`${API}/gone`]: [404, '{}'], [`${API}/no`]: [403, '{"message":"nope"}'], [`${API}/ok`]: [200, { a: 1 }] }) })
  assert.equal(await client.getOrNull('/gone'), null)
  assert.deepEqual(await client.getOrNull('/ok'), { a: 1 })
  await assert.rejects(client.getOrNull('/no'), (err) => /** @type {any} */ (err).status === 403)
})

test('download: the body as bytes, authenticated; a refusal carries its status', async () => {
  /** @type {any} */
  let seen = null
  const client = createClient({
    token: 'tok',
    fetch: /** @type {any} */ (async (url, init) => {
      seen = init
      return String(url).endsWith('/zip') ? new Response(new Uint8Array([0, 1, 255])) : new Response('no', { status: 410 })
    }),
  })
  assert.deepEqual([...(await client.download('/zip'))], [0, 1, 255])
  assert.equal(seen.headers.Authorization, 'token tok')
  await assert.rejects(client.download('/gone'), (err) => /** @type {any} */ (err).status === 410)
})

test('isNotFound and explain read the status the client attaches', () => {
  const notFound = Object.assign(new Error('boom'), { status: 404 })
  assert.equal(isNotFound(notFound), true)
  assert.equal(isNotFound(new Error('/x: 404 {}')), true)
  assert.equal(isNotFound(Object.assign(new Error('/x: 403'), { status: 403 })), false)
  assert.match(String(explain(notFound)), /Not found — or the App is not installed/)
})

// ---------------------------------------------------------------------------
// `agit pr merge`, end to end
// ---------------------------------------------------------------------------

/**
 * develop on the fake GitHub carries `base` files; agent/x adds `pr` files on
 * top; PR #7 is agent/x → develop. The worktree is a clone of it.
 */
function prScenario({ base = {}, head = { 'src/feature.ts': 'export {}\n' } } = {}) {
  const s = scenario()
  if (Object.keys(base).length) commitOn(s.bare, 'develop', base, { message: 'base policy' })
  commitOn(s.bare, 'agent/x', head, { from: 'develop', message: 'the PR' })
  s.client.openPull(7, 'agent/x', 'develop')
  const merge = (...flags) => pr(['merge', '7', '-C', s.wt, '--repo', 'o/r', ...flags], { client: s.client })
  const merged = () => s.client.calls.some((c) => c.method === 'PUT' && c.path === '/repos/o/r/pulls/7/merge')
  return { ...s, merge, merged }
}

const CODEOWNERS = { CODEOWNERS: '/ci/ @alice\n' }

test('pr merge: a clean PR into the base merges, pinned to the head it judged', async () => {
  const s = prScenario({ base: CODEOWNERS })
  try {
    await s.merge()
    assert.equal(s.merged(), true)
    const put = s.client.calls.find((c) => c.method === 'PUT')
    assert.equal(put?.body.sha, run(s.bare, ['rev-parse', 'refs/heads/agent/x']).trim())
  } finally {
    s.cleanup()
  }
})

test('pr merge: a PR touching a path the BASE protects is refused, and nothing is merged', async () => {
  const s = prScenario({ base: CODEOWNERS, head: { 'ci/gate.mjs': 'weakened\n' } })
  try {
    await assert.rejects(s.merge(), (err) => err instanceof PublishError && /ci\/gate\.mjs — owned by @alice in CODEOWNERS/.test(err.message))
    assert.equal(s.merged(), false)
  } finally {
    s.cleanup()
  }
})

test('pr merge: the base is red — refused; a PR that contains the base head and is green goes through', async () => {
  const s = prScenario({ base: { '.agit.json': JSON.stringify({ requiredCheck: 'ci' }) } })
  try {
    s.client.setCheck('develop', 'failure')
    await assert.rejects(s.merge(), (err) => err instanceof PublishError && /`develop` is red/.test(err.message))
    assert.equal(s.merged(), false)

    // The PR carries develop's head (it was cut from it) and is green: the fix.
    s.client.setCheck(run(s.bare, ['rev-parse', 'refs/heads/agent/x']).trim(), 'success')
    await s.merge()
    assert.equal(s.merged(), true)
  } finally {
    s.cleanup()
  }
})

test('pr merge: the worktree\'s own .agit.json does not leak into the base\'s policy', async () => {
  // The base has no .agit.json, so no required check; the worktree's claims
  // one, and a mergeableBases that would refuse develop. Neither applies.
  const s = prScenario()
  try {
    writeFileSync(join(s.wt, '.agit.json'), JSON.stringify({ requiredCheck: 'ci', mergeableBases: ['main'] }))
    s.client.setCheck('develop', 'failure')
    await s.merge()
    assert.equal(s.merged(), true)
  } finally {
    s.cleanup()
  }
})

test('pr merge: a merge grant for this session lifts a liftable refusal, and says so', async (t) => {
  const s = prScenario({ base: CODEOWNERS, head: { 'ci/gate.mjs': 'reviewed change\n' } })
  const before = process.env.AGIT_SESSION
  t.after(() => {
    if (before === undefined) delete process.env.AGIT_SESSION
    else process.env.AGIT_SESSION = before
  })
  try {
    process.env.AGIT_SESSION = 'the-session'
    delete process.env.CLAUDE_CODE_SESSION_ID
    mkdirSync(join(s.wt, '.git', 'agit'), { recursive: true })
    writeFileSync(
      join(s.wt, '.git', 'agit', 'maintainer.json'),
      JSON.stringify({ reason: 'owner approved', scopes: ['merge'], grantedAt: '', expiresAt: '2099-01-01T00:00:00Z', session: 'the-session', via: 't' }),
    )
    await s.merge()
    assert.equal(s.merged(), true)
  } finally {
    s.cleanup()
  }
})

test('pr: bad usage is a refusal, not an exit', async () => {
  await assert.rejects(pr(['merge', 'x'], { client: clientOver(() => null) }), (err) => err instanceof PublishError && /^usage: agit pr merge/.test(err.message))
})
