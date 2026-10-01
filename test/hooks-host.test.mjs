// @ts-check
/**
 * The hook host (hooks/index.mjs) — stdin, the fail-open posture, the answer's
 * envelope — and the shell reading every Bash guard shares (shell-text.mjs's
 * `executedCommands`), through the guards that use them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as credentials from '../src/hooks/guard-credentials.mjs'
import * as prWrites from '../src/hooks/guard-pr-writes.mjs'
import * as protectedGuard from '../src/hooks/guard-protected.mjs'
import { HOOKS, envelope, respond } from '../src/hooks/index.mjs'
import { executedCommands } from '../src/hooks/shell-text.mjs'

const bash = (command, extra = {}) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, ...extra })

test('host: every hook module has the shape the host runs', async () => {
  for (const [name, load] of Object.entries(HOOKS)) {
    const mod = await load()
    assert.ok(['PreToolUse', 'PostToolUse', 'SessionStart'].includes(mod.event), name)
    assert.equal(typeof mod.decide, 'function', name)
  }
})

test('host: a guard\'s message is a deny; a notice\'s is shown as context', () => {
  assert.deepEqual(envelope('PreToolUse', 'no'), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
  })
  assert.deepEqual(envelope('PostToolUse', 'synced'), {
    systemMessage: 'synced',
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'synced' },
  })
})

test('host: fails OPEN — unreadable input, a throwing hook, or no opinion all answer nothing', async () => {
  const throws = { event: /** @type {const} */ ('PreToolUse'), decide: () => { throw new Error('bug') } }
  const quiet = { event: /** @type {const} */ ('PreToolUse'), decide: () => null }
  assert.equal(await respond(credentials, '{not json'), null)
  assert.equal(await respond(throws, bash('anything')), null)
  assert.equal(await respond(quiet, bash('anything')), null)
  assert.equal(await respond(credentials, ''), null) // no stdin at all
})

test('host: guard-pr-writes denies a merge write; an ordinary command passes', async () => {
  const merge = await respond(prWrites, bash('agit api PUT /repos/o/r/pulls/12/merge'))
  assert.match(JSON.parse(String(merge)).hookSpecificOutput.permissionDecisionReason, /agit pr merge 12/)
  assert.equal(await respond(prWrites, bash('agit api GET /repos/o/r/pulls/12/merge')), null)
})

// ---------------------------------------------------------------------------
// executedCommands: one command set, every depth, for every guard
// ---------------------------------------------------------------------------

test('executedCommands: the line, and each sh -c payload to any depth, raw and masked', () => {
  const got = executedCommands(`bash -c "sh -c 'gh pr list'"`)
  assert.deepEqual(got.map((c) => c.raw), [`bash -c "sh -c 'gh pr list'"`, `sh -c 'gh pr list'`, 'gh pr list'])
  // Masking blanks quoted spans, so a payload's quotes are data one level up.
  assert.equal(got[1].masked, `sh -c '\0\0\0\0\0\0\0\0\0\0'`)
  assert.equal(got[2].masked, 'gh pr list')
})

test('executedCommands: escaped quotes inside a double-quoted payload are undone', () => {
  const got = executedCommands(`bash -c "git commit -m \\"wip\\""`)
  assert.equal(got[1].raw, 'git commit -m "wip"')
})

test('guard-protected: nesting no longer hides a self-grant', () => {
  assert.equal(protectedGuard.grantsItself(`bash -c "sh -c 'agit maintainer grant a b'"`), true)
  assert.equal(protectedGuard.grantsItself(`bash -c "sh -c 'agit maintainer status'"`), false)
})

test('guard-protected: a bare root filename is a write target — CODEOWNERS, Makefile', () => {
  assert.deepEqual(protectedGuard.writeTargets('echo x > CODEOWNERS'), ['CODEOWNERS'])
  assert.deepEqual(protectedGuard.writeTargets('rm CODEOWNERS'), ['CODEOWNERS'])
  assert.deepEqual(protectedGuard.writeTargets('cp /tmp/m Makefile'), ['Makefile'])
  assert.deepEqual(protectedGuard.writeTargets(`bash -c "sh -c 'rm Dockerfile'"`), ['Dockerfile'])
  // Reading is still not writing.
  assert.deepEqual(protectedGuard.writeTargets('cat CODEOWNERS'), [])
  assert.deepEqual(protectedGuard.writeTargets('echo x 2>&1'), [])
})

// ---------------------------------------------------------------------------
// guard-protected end to end: the host, a real checkout, the session's grant
// ---------------------------------------------------------------------------

test('guard-protected through the host: `rm CODEOWNERS` in a real checkout is denied, naming this session', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agit-host-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'CODEOWNERS'), '/ci/ @alice\n')

  const env = { AGIT_SESSION: 'from-env' }
  const denied = await respond(protectedGuard, bash('rm CODEOWNERS', { cwd: dir, session_id: 'from-event' }), { env })
  const reason = JSON.parse(String(denied)).hookSpecificOutput.permissionDecisionReason
  assert.match(reason, /`CODEOWNERS` is protected — defines the protection itself/)
  assert.match(reason, /--session from-event/) // the event's session, not the environment's

  // No event session: AGIT_SESSION is the session (it used to be ignored here).
  const viaEnv = await respond(protectedGuard, bash('rm CODEOWNERS', { cwd: dir }), { env })
  assert.match(JSON.parse(String(viaEnv)).hookSpecificOutput.permissionDecisionReason, /--session from-env/)

  assert.equal(await respond(protectedGuard, bash('rm src/x.ts', { cwd: dir }), { env }), null)
})
