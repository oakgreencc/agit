// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allows,
  currentSession,
  describe as describeView,
  grantAdvice,
  isSessionId,
  listLive,
  readGrant,
  revokeGrant,
  validateRequest,
  writeGrant,
} from '../src/maintainer.mjs'
import { run as runMaintainer } from '../src/cli/maintainer.mjs'
import { PublishError } from '../src/errors.mjs'
import { run as gitRun } from './fixtures.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'agit-mm-'))
const NOW = Date.parse('2026-06-01T00:00:00Z')

test('readGrant: every state', () => {
  const d = tmp()
  const dir = join(d, 'maintainer')
  const at = (name) => join(dir, `${name}.json`)
  try {
    assert.deepEqual(readGrant({ dir, session: 's', now: NOW }), { state: 'none', session: 's' })
    mkdirSync(dir)
    writeFileSync(at('s'), '{nope')
    assert.equal(readGrant({ dir, session: 's', now: NOW }).state, 'invalid')
    writeFileSync(at('s'), JSON.stringify({ reason: 'x y' }))
    assert.equal(readGrant({ dir, session: 's', now: NOW }).state, 'invalid')
    const g = { reason: 'fix the gate', scopes: ['protected'], expiresAt: '2026-06-01T04:00:00Z', session: 's' }
    writeFileSync(at('s'), JSON.stringify({ ...g, expiresAt: 'soon' }))
    assert.equal(readGrant({ dir, session: 's', now: NOW }).state, 'invalid')
    writeFileSync(at('s'), JSON.stringify({ ...g, expiresAt: '2026-05-31T00:00:00Z' }))
    assert.equal(readGrant({ dir, session: 's', now: NOW }).state, 'expired')
    writeFileSync(at('s'), JSON.stringify(g))
    assert.equal(readGrant({ dir, session: 's', now: NOW }).state, 'active')
    const other = readGrant({ dir, session: 'other', now: NOW })
    assert.equal(other.state, 'mismatch')
    assert.deepEqual(/** @type {any} */ (other).grants.map((x) => x.session), ['s'])
    assert.equal(readGrant({ dir, session: null, now: NOW }).state, 'mismatch')
    // A grant naming no session unlocks nothing — not even a sessionless asker.
    writeFileSync(at('s'), JSON.stringify({ ...g, session: '' }))
    const orphan = readGrant({ dir, session: '', now: NOW })
    assert.equal(orphan.state, 'mismatch')
    assert.match(describeView(orphan), /no session \(via=unknown, so it unlocks nothing\)/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

const LIVE = { reason: 'fix the gate', scopes: ['protected'], grantedAt: '', expiresAt: '2026-06-01T04:00:00Z', via: 't' }

/** A grants dir with each `[file, body]` written into it. */
function grantsWith(entries) {
  const d = tmp()
  const dir = join(d, 'agit', 'maintainer')
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of entries) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  return { d, dir, log: join(d, 'agit', 'maintainer.log') }
}

test('two sessions hold grants at once, each active for itself', () => {
  const { d, dir } = grantsWith([
    ['a.json', { ...LIVE, session: 'a', reason: 'work of a' }],
    ['b.json', { ...LIVE, session: 'b', reason: 'work of b', scopes: ['merge'] }],
  ])
  try {
    const a = readGrant({ dir, session: 'a', now: NOW })
    const b = readGrant({ dir, session: 'b', now: NOW })
    assert.equal(a.state, 'active')
    assert.equal(b.state, 'active')
    assert.equal(/** @type {any} */ (a).grant.reason, 'work of a')
    assert.equal(allows(b, 'merge'), true)
    assert.equal(allows(b, 'protected'), false)
    assert.deepEqual(listLive(dir, NOW).map((g) => g.session), ['a', 'b'])
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('a refused session is told every grantee, with scopes, expiry and reason', () => {
  const { d, dir } = grantsWith([
    ['a.json', { ...LIVE, session: 'a', reason: 'work of a' }],
    ['b.json', { ...LIVE, session: 'b', reason: 'work of b', scopes: ['merge'], expiresAt: '2026-06-01T02:00:00Z' }],
  ])
  try {
    const view = readGrant({ dir, session: 'c', now: NOW })
    assert.equal(view.state, 'mismatch')
    const advice = grantAdvice(view, 'protected')
    assert.match(advice, /session a \[protected\] until 2026-06-01T04:00:00Z — "work of a"/)
    assert.match(advice, /session b \[merge\] until 2026-06-01T02:00:00Z — "work of b"/)
    assert.match(advice, /--session c/)
    assert.match(describeView(view), /OFF for this session \(c\) — granted to session a .*; session b /)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('each grant expires on its own', () => {
  const { d, dir } = grantsWith([
    ['a.json', { ...LIVE, session: 'a', expiresAt: '2026-05-31T23:00:00Z' }],
    ['b.json', { ...LIVE, session: 'b' }],
  ])
  try {
    assert.equal(readGrant({ dir, session: 'a', now: NOW }).state, 'expired')
    assert.equal(readGrant({ dir, session: 'b', now: NOW }).state, 'active')
    // Nothing of its own: others' live grants are a mismatch, not someone's expiry.
    assert.equal(readGrant({ dir, session: 'c', now: NOW }).state, 'mismatch')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("a foreign corrupt or lapsed file never hides this session's grant", () => {
  const { d, dir } = grantsWith([
    ['a.json', { ...LIVE, session: 'a' }],
    ['b.json', '{nope'],
    ['c.json', { ...LIVE, session: 'c', expiresAt: '2026-05-31T23:00:00Z' }],
  ])
  try {
    assert.equal(readGrant({ dir, session: 'a', now: NOW }).state, 'active')
    // The corrupt file is its own session's by name.
    assert.equal(readGrant({ dir, session: 'b', now: NOW }).state, 'invalid')
    assert.equal(readGrant({ dir, session: 'c', now: NOW }).state, 'expired')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('with no live grant, the newest lapsed one reads as expired, else a corrupt one as invalid', () => {
  const { d, dir } = grantsWith([
    ['a.json', { ...LIVE, session: 'a', expiresAt: '2026-05-31T20:00:00Z' }],
    ['b.json', { ...LIVE, session: 'b', expiresAt: '2026-05-31T22:00:00Z' }],
    ['x.json', '{nope'],
  ])
  try {
    const view = readGrant({ dir, session: 'c', now: NOW })
    assert.equal(view.state, 'expired')
    assert.equal(/** @type {any} */ (view).grant.session, 'b')
    rmSync(join(dir, 'a.json'))
    rmSync(join(dir, 'b.json'))
    assert.equal(readGrant({ dir, session: 'c', now: NOW }).state, 'invalid')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('the legacy one-slot file is still read, and revoked only by its own session', () => {
  const { d, dir, log } = grantsWith([])
  const legacy = `${dir}.json`
  try {
    writeFileSync(legacy, JSON.stringify({ ...LIVE, session: 'old' }))
    assert.equal(readGrant({ dir, session: 'old', now: NOW }).state, 'active')
    assert.equal(readGrant({ dir, session: 'new', now: NOW }).state, 'mismatch')
    assert.equal(revokeGrant({ dir, log, session: 'new', via: 't' }), false)
    assert.equal(existsSync(legacy), true)
    // Granting never writes it.
    writeGrant({ dir, log, reason: 'new work here', scopes: ['protected'], hours: 1, session: 'new', via: 't', now: new Date(NOW) })
    assert.equal(JSON.parse(readFileSync(legacy, 'utf8')).session, 'old')
    assert.equal(revokeGrant({ dir, log, session: 'old', via: 't' }), true)
    assert.equal(existsSync(legacy), false)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('allows: only an active grant, only its scopes', () => {
  const grant = { reason: 'r s', scopes: ['protected'], grantedAt: '', expiresAt: '', session: 's', via: 'x' }
  assert.equal(allows({ state: 'active', grant, session: 's' }, 'protected'), true)
  assert.equal(allows({ state: 'active', grant, session: 's' }, 'merge'), false)
  assert.equal(allows({ state: 'mismatch', grants: [grant], session: 't' }, 'protected'), false)
  assert.equal(allows({ state: 'expired', grant }, 'protected'), false)
  assert.equal(allows({ state: 'none' }, 'protected'), false)
})

test('validateRequest', () => {
  const ok = { reason: 'fix the ci gate', scopes: ['protected'], hours: 4, session: 's' }
  assert.equal(validateRequest(ok), null)
  assert.match(String(validateRequest({ ...ok, reason: '' })), /required/)
  assert.match(String(validateRequest({ ...ok, reason: 'status' })), /did you mean `agit maintainer status`/)
  assert.match(String(validateRequest({ ...ok, reason: '--off' })), /agit maintainer revoke/)
  assert.match(String(validateRequest({ ...ok, reason: 'fix' })), /more than one word/)
  assert.match(String(validateRequest({ ...ok, scopes: [] })), /at least one scope/)
  assert.match(String(validateRequest({ ...ok, scopes: ['everything'] })), /unknown scope everything/)
  assert.match(String(validateRequest({ ...ok, hours: 0 })), /--hours/)
  assert.match(String(validateRequest({ ...ok, hours: 25 })), /--hours/)
  assert.match(String(validateRequest({ ...ok, session: null })), /no session/)
})

test('writeGrant / revokeGrant round-trip, logged', () => {
  const d = tmp()
  const dir = join(d, 'agit', 'maintainer')
  const log = join(d, 'agit', 'maintainer.log')
  try {
    const now = new Date(NOW)
    const g = writeGrant({ dir, log, reason: 'fix the gate', scopes: ['merge', 'merge'], hours: 2, session: 's', via: 'terminal', now })
    assert.deepEqual(g.scopes, ['merge'])
    assert.equal(g.expiresAt, '2026-06-01T02:00:00.000Z')
    assert.equal(statSync(join(dir, 's.json')).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(dir), ['s.json'])
    const view = readGrant({ dir, session: 's', now: NOW + 1000 })
    assert.equal(view.state, 'active')
    assert.match(describeView(view), /ON \[merge\] for session s/)
    assert.equal(revokeGrant({ dir, log, session: 's', via: 'terminal' }), true)
    assert.equal(existsSync(join(dir, 's.json')), false)
    assert.equal(revokeGrant({ dir, log, session: 's', via: 'terminal' }), false)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    assert.match(lines[0], /GRANT merge until .* session=s via=terminal — fix the gate/)
    assert.match(lines[1], /REVOKE session=s via=terminal/)
    assert.match(lines[2], /REVOKE \(none active\) session=s/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('a second grant leaves the first; revoke removes only its own', () => {
  const { d, dir, log } = grantsWith([])
  const now = new Date(NOW)
  try {
    writeGrant({ dir, log, reason: 'work of a', scopes: ['protected'], hours: 2, session: 'a', via: 't', now })
    writeGrant({ dir, log, reason: 'work of b', scopes: ['protected'], hours: 2, session: 'b', via: 't', now })
    assert.equal(readGrant({ dir, session: 'a', now: NOW }).state, 'active')
    assert.equal(readGrant({ dir, session: 'b', now: NOW }).state, 'active')
    revokeGrant({ dir, log, session: 'a', via: 't' })
    assert.equal(readGrant({ dir, session: 'a', now: NOW }).state, 'mismatch')
    assert.equal(readGrant({ dir, session: 'b', now: NOW }).state, 'active')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('revoke goes by the grantee recorded inside, as well as the file name', () => {
  const { d, dir, log } = grantsWith([
    ['renamed.json', { ...LIVE, session: 'a' }],
    ['b.json', { ...LIVE, session: 'b' }],
  ])
  try {
    assert.equal(revokeGrant({ dir, log, session: 'a', via: 't' }), true)
    assert.deepEqual(readdirSync(dir), ['b.json'])
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('granting prunes grants lapsed over a day ago, and logs it', () => {
  const { d, dir, log } = grantsWith([
    ['old.json', { ...LIVE, session: 'old', expiresAt: '2026-05-30T23:00:00Z' }],
    ['recent.json', { ...LIVE, session: 'recent', expiresAt: '2026-05-31T12:00:00Z' }],
  ])
  try {
    writeGrant({ dir, log, reason: 'new work here', scopes: ['protected'], hours: 1, session: 'n', via: 't', now: new Date(NOW) })
    assert.deepEqual(readdirSync(dir).sort(), ['n.json', 'recent.json'])
    assert.match(readFileSync(log, 'utf8'), /PRUNED lapsed grant for old/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('a session id that is not a file name is refused', () => {
  assert.equal(isSessionId('abc-123_x.y'), true)
  for (const bad of ['', '../x', 'a/b', '.hidden', '-x', 'a b']) assert.equal(isSessionId(bad), false, bad)
  const ok = { reason: 'fix the ci gate', scopes: ['protected'], hours: 4 }
  assert.match(String(validateRequest({ ...ok, session: '../escape' })), /not a usable session id/)
  assert.throws(() => writeGrant({ dir: '/nonexistent', log: '/nonexistent/l', ...ok, session: '../x', via: 't' }), /not a usable session id/)
})

test('grantAdvice names the scope, every grantee and the asking session', () => {
  const grant = { reason: 'their work', scopes: ['protected'], grantedAt: '', expiresAt: 'later', session: 'sa', via: 'x' }
  const text = grantAdvice({ state: 'mismatch', grants: [grant], session: 'sb' }, 'protected')
  assert.match(text, /granted to session sa/)
  assert.match(text, /--scope protected --session sb/)
  assert.match(grantAdvice({ state: 'active', grant, session: 'sa' }, 'merge'), /does not include the `merge` scope/)
})

test('currentSession: Claude Code first, then AGIT_SESSION', () => {
  assert.equal(currentSession({ CLAUDE_CODE_SESSION_ID: 'c', AGIT_SESSION: 'a' }), 'c')
  assert.equal(currentSession({ AGIT_SESSION: ' a ' }), 'a')
  assert.equal(currentSession({}), null)
})

// ---------------------------------------------------------------------------
// The CLI, against a real clone: what a human types.

/**
 * Run `agit maintainer …` in a scratch clone as session `session` (or none),
 * returning what it printed.
 */
async function cli(repo, session, ...argv) {
  const saved = { c: process.env.CLAUDE_CODE_SESSION_ID, a: process.env.AGIT_SESSION, log: console.log }
  delete process.env.CLAUDE_CODE_SESSION_ID
  if (session) process.env.AGIT_SESSION = session
  else delete process.env.AGIT_SESSION
  const out = []
  console.log = (...args) => out.push(args.join(' '))
  try {
    await runMaintainer([...argv, '-C', repo])
    return out.join('\n')
  } finally {
    console.log = saved.log
    for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', saved.c], ['AGIT_SESSION', saved.a]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function clone() {
  const d = realpathSync(tmp())
  gitRun(d, ['init', '-q', '-b', 'main'])
  return d
}

test('cli: two sessions grant; status lists both; revoke is per session', async () => {
  const repo = clone()
  const dir = join(repo, '.git', 'agit', 'maintainer')
  try {
    await cli(repo, 'sa', 'grant', 'work of a', '--scope', 'protected')
    await cli(repo, 'sb', 'grant', 'work of b', '--scope', 'merge')
    assert.deepEqual(readdirSync(dir).sort(), ['sa.json', 'sb.json'])

    const status = await cli(repo, 'sa', 'status')
    assert.match(status, /ON \[protected\] for session sa/)
    assert.match(status, /active grants \(2\):\n {2}session sa \[protected\].*\n {2}session sb \[merge\]/)
    // A session with none sees every grantee in its own line, and no second list.
    const theirs = await cli(repo, 'sc', 'status')
    assert.match(theirs, /OFF for this session \(sc\) — granted to session sa .*; session sb /)
    assert.doesNotMatch(theirs, /active grants/)

    // `revoke` is only the invoking session's…
    assert.match(await cli(repo, 'sa', 'revoke'), /OFF for session sa \(revoked\)\nactive grants \(1\):\n {2}session sb/)
    assert.deepEqual(readdirSync(dir), ['sb.json'])
    // …or the one --session names.
    assert.match(await cli(repo, 'sa', 'off', '--session', 'sb'), /OFF for session sb \(revoked\)\nactive grants: none/)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('cli: revoke with no session refuses rather than revoking everyone', async () => {
  const repo = clone()
  try {
    await cli(repo, 'sa', 'grant', 'work of a')
    await assert.rejects(cli(repo, null, 'revoke'), (err) => err instanceof PublishError && /names none/.test(err.message))
    await assert.rejects(cli(repo, 'sa', 'revoke', '--session'), /--session needs a session id/)
    assert.equal(existsSync(join(repo, '.git', 'agit', 'maintainer', 'sa.json')), true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('cli: a session id that is not a file name is refused', async () => {
  const repo = clone()
  try {
    await assert.rejects(cli(repo, null, 'grant', 'work of a', '--session', '../../x'), /not a usable session id/)
    await assert.rejects(cli(repo, '../x', 'grant', 'work of a'), /not a usable session id/)
    await assert.rejects(cli(repo, 'sa', 'revoke', '--session', 'a/b'), /not a usable session id/)
    assert.equal(existsSync(join(repo, '.git', 'agit', 'maintainer')), false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
