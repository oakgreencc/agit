// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allows,
  currentSession,
  describe as describeView,
  grantAdvice,
  readGrant,
  revokeGrant,
  validateRequest,
  writeGrant,
} from '../src/maintainer.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'agit-mm-'))
const NOW = Date.parse('2026-06-01T00:00:00Z')

test('readGrant: every state', () => {
  const d = tmp()
  const path = join(d, 'g.json')
  try {
    assert.deepEqual(readGrant({ path, session: 's', now: NOW }), { state: 'none', session: 's' })
    writeFileSync(path, '{nope')
    assert.equal(readGrant({ path, session: 's', now: NOW }).state, 'invalid')
    writeFileSync(path, JSON.stringify({ reason: 'x y' }))
    assert.equal(readGrant({ path, session: 's', now: NOW }).state, 'invalid')
    const g = { reason: 'fix the gate', scopes: ['protected'], expiresAt: '2026-06-01T04:00:00Z', session: 's' }
    writeFileSync(path, JSON.stringify({ ...g, expiresAt: 'soon' }))
    assert.equal(readGrant({ path, session: 's', now: NOW }).state, 'invalid')
    writeFileSync(path, JSON.stringify({ ...g, expiresAt: '2026-05-31T00:00:00Z' }))
    assert.equal(readGrant({ path, session: 's', now: NOW }).state, 'expired')
    writeFileSync(path, JSON.stringify(g))
    assert.equal(readGrant({ path, session: 's', now: NOW }).state, 'active')
    assert.equal(readGrant({ path, session: 'other', now: NOW }).state, 'mismatch')
    assert.equal(readGrant({ path, session: null, now: NOW }).state, 'mismatch')
    // A grant naming no session unlocks nothing — not even a sessionless asker.
    writeFileSync(path, JSON.stringify({ ...g, session: '' }))
    assert.equal(readGrant({ path, session: '', now: NOW }).state, 'mismatch')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('allows: only an active grant, only its scopes', () => {
  const grant = { reason: 'r s', scopes: ['protected'], grantedAt: '', expiresAt: '', session: 's', via: 'x' }
  assert.equal(allows({ state: 'active', grant, session: 's' }, 'protected'), true)
  assert.equal(allows({ state: 'active', grant, session: 's' }, 'merge'), false)
  assert.equal(allows({ state: 'mismatch', grant, session: 't' }, 'protected'), false)
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
  const path = join(d, 'agit', 'maintainer.json')
  const log = join(d, 'agit', 'maintainer.log')
  try {
    const now = new Date(NOW)
    const g = writeGrant({ path, log, reason: 'fix the gate', scopes: ['merge', 'merge'], hours: 2, session: 's', via: 'terminal', now })
    assert.deepEqual(g.scopes, ['merge'])
    assert.equal(g.expiresAt, '2026-06-01T02:00:00.000Z')
    const view = readGrant({ path, session: 's', now: NOW + 1000 })
    assert.equal(view.state, 'active')
    assert.match(describeView(view), /ON \[merge\] for session s/)
    assert.equal(revokeGrant({ path, log, via: 'terminal' }), true)
    assert.equal(existsSync(path), false)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0], /GRANT merge until .* session=s via=terminal — fix the gate/)
    assert.match(lines[1], /REVOKE via=terminal/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('grantAdvice names the scope, the grantee and the asking session', () => {
  const grant = { reason: 'their work', scopes: ['protected'], grantedAt: '', expiresAt: 'later', session: 'sa', via: 'x' }
  const text = grantAdvice({ state: 'mismatch', grant, session: 'sb' }, 'protected')
  assert.match(text, /granted to session sa/)
  assert.match(text, /--scope protected --session sb/)
  assert.match(grantAdvice({ state: 'active', grant, session: 'sa' }, 'merge'), /does not include the `merge` scope/)
})

test('currentSession: Claude Code first, then AGIT_SESSION', () => {
  assert.equal(currentSession({ CLAUDE_CODE_SESSION_ID: 'c', AGIT_SESSION: 'a' }), 'c')
  assert.equal(currentSession({ AGIT_SESSION: ' a ' }), 'a')
  assert.equal(currentSession({}), null)
})
