// @ts-check
/**
 * What raw git in THIS process would authenticate as (session-env.mjs), and
 * the two places that ask: `agit doctor` and the SessionStart hook.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sessionCheck from '../src/hooks/session-check.mjs'
import { respond } from '../src/hooks/index.mjs'
import { effectiveHelpers, readRawGit, sessionFindings } from '../src/session-env.mjs'
import { claudeHooks, gitConfigEnv, missingFromSettings } from '../src/setup/settings.mjs'

const levels = (fs) => fs.map((f) => f.level)
const agitEnv = gitConfigEnv({ owners: ['o'] })
const entry = (key, value, scope = 'command') => ({ key, value, scope })

// ---------------------------------------------------------------------------
// effectiveHelpers: git's own list, resets included
// ---------------------------------------------------------------------------

test('effectiveHelpers: an empty value resets the list; later helpers accumulate', () => {
  const entries = [
    entry('credential.helper', 'osxkeychain', 'system'),
    entry('credential.https://github.com.helper', ''),
    entry('credential.https://github.com.helper', '!agit credential'),
  ]
  assert.deepEqual(effectiveHelpers(entries, 'https://github.com/o/r.git'), [entry('credential.https://github.com.helper', '!agit credential')])
})

test('effectiveHelpers: only helpers whose URL matches; a foreign helper after agit is kept', () => {
  const entries = [
    entry('credential.https://gitlab.com.helper', 'store'),
    entry('credential.https://github.com.helper', ''),
    entry('credential.https://github.com.helper', '!agit credential'),
    entry('credential.https://github.com/.helper', '!node bot.mjs credential'),
  ]
  assert.deepEqual(
    effectiveHelpers(entries, 'https://github.com/o/r.git').map((h) => h.value),
    ['!agit credential', '!node bot.mjs credential'],
  )
})

// ---------------------------------------------------------------------------
// sessionFindings: pure verdict
// ---------------------------------------------------------------------------

test('sessionFindings: agit alone over HTTPS, env matching settings → all ok', () => {
  const fs = sessionFindings({
    url: 'https://github.com/o/r.git',
    helpers: [entry('credential.https://github.com.helper', '!agit credential')],
    processEnv: agitEnv,
    settingsEnv: agitEnv,
  })
  assert.deepEqual(levels(fs), ['ok', 'ok'])
  assert.match(fs[0].label, /authenticates as the App/)
})

test('sessionFindings: an SSH origin fails — that is the human key', () => {
  const fs = sessionFindings({ url: 'git@github.com:o/r.git', helpers: [], processEnv: {}, settingsEnv: agitEnv })
  assert.equal(fs[0].level, 'fail')
  assert.match(fs[0].label, /SSH/)
  assert.match(fs[0].detail ?? '', /restart/i)
})

test('sessionFindings: a helper other than agit fails, naming it and where it came from', () => {
  const fs = sessionFindings({
    url: 'https://github.com/o/r.git',
    helpers: [entry('credential.helper', 'osxkeychain', 'global')],
    processEnv: {},
    settingsEnv: null,
  })
  assert.equal(fs[0].level, 'fail')
  assert.match(fs[0].label, /osxkeychain \(global\)/)
})

test('sessionFindings: no helper at all warns — nothing answers, nothing leaks', () => {
  const fs = sessionFindings({ url: 'https://github.com/o/r.git', helpers: [], processEnv: {}, settingsEnv: null })
  assert.deepEqual(levels(fs), ['warn'])
})

test('sessionFindings: a block that differs from .claude/settings.json warns and names the foreign keys', () => {
  const foreign = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'url.https://github.com/other/.insteadOf',
    GIT_CONFIG_VALUE_0: 'git@github.com:other/',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!node bot.mjs credential',
  }
  const fs = sessionFindings({
    url: 'https://github.com/o/r.git',
    helpers: [entry('credential.https://github.com.helper', '!node bot.mjs credential')],
    processEnv: foreign,
    settingsEnv: agitEnv,
  })
  assert.deepEqual(levels(fs), ['fail', 'warn'])
  assert.match(fs[1].label, /differs from \.claude\/settings\.json/)
  assert.match(fs[1].detail ?? '', /credential\.https:\/\/github\.com\.helper=!node bot\.mjs credential/)
})

test('effectiveHelpers: a prefix matches on a URL boundary, not mid-host', () => {
  const entries = [entry('credential.https://github.com.helper', 'x'), entry('credential.https://github.co.helper', 'y')]
  assert.deepEqual(effectiveHelpers(entries, 'https://github.com.evil/o/r.git'), [])
  assert.deepEqual(effectiveHelpers(entries, 'https://github.com/o/r.git').map((h) => h.value), ['x'])
})

test('sessionFindings: an origin off github.com is out of scope, but a foreign block is still named', () => {
  const fs = sessionFindings({ url: 'https://gitlab.com/o/r.git', helpers: [], processEnv: {}, settingsEnv: null })
  assert.deepEqual(levels(fs), ['ok'])
  const mismatch = sessionFindings({ url: 'https://gitlab.com/o/r.git', helpers: [], processEnv: {}, settingsEnv: agitEnv })
  assert.deepEqual(levels(mismatch), ['ok', 'warn'])
})

// ---------------------------------------------------------------------------
// readRawGit and the hook, over a real repository
// ---------------------------------------------------------------------------

const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: process.env.PATH ?? '' }

/** A repo whose origin is SSH, with (optionally) `.claude/settings.json` carrying agit's block. */
function repo(t, { settings = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agit-session-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', dir], { env: ISOLATED })
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:o/r.git'], { env: ISOLATED })
  if (settings) {
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: agitEnv }))
  }
  return dir
}

test('readRawGit: git applies the env block — insteadOf and the helper reset', (t) => {
  const dir = repo(t)
  const bare = readRawGit({ cwd: dir, env: ISOLATED })
  assert.equal(bare.url, 'git@github.com:o/r.git')
  const bound = readRawGit({ cwd: dir, env: { ...ISOLATED, ...agitEnv } })
  assert.equal(bound.url, 'https://github.com/o/r.git')
  assert.deepEqual(bound.helpers.map((h) => [h.value, h.scope]), [['!agit credential', 'command']])
})

test('session-check hook: quiet in a bound session; warns in one that is not', async (t) => {
  const dir = repo(t)
  const event = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: dir })
  assert.equal(await respond(sessionCheck, event, { env: { ...ISOLATED, ...agitEnv } }), null)

  const out = await respond(sessionCheck, event, { env: ISOLATED })
  const parsed = JSON.parse(String(out))
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(parsed.hookSpecificOutput.additionalContext, /SSH/)
  assert.match(parsed.hookSpecificOutput.additionalContext, /agit/)
  assert.equal(parsed.systemMessage, parsed.hookSpecificOutput.additionalContext)
})

test('readRawGit: no origin remote → no URL (git would echo the name back)', (t) => {
  const dir = repo(t, { settings: false })
  execFileSync('git', ['-C', dir, 'remote', 'remove', 'origin'], { env: ISOLATED })
  assert.equal(readRawGit({ cwd: dir, env: ISOLATED }).url, '')
})

test('session-check hook: a malformed settings.json still gets the git verdict', async (t) => {
  const dir = repo(t)
  writeFileSync(join(dir, '.claude', 'settings.json'), '{ not json')
  const event = JSON.stringify({ hook_event_name: 'SessionStart', cwd: dir })
  const out = await respond(sessionCheck, event, { env: ISOLATED })
  assert.match(JSON.parse(String(out)).hookSpecificOutput.additionalContext, /SSH/)
})

test('session-check hook: outside a repository, no opinion', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agit-norepo-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const event = JSON.stringify({ hook_event_name: 'SessionStart', cwd: dir })
  assert.equal(await respond(sessionCheck, event, { env: { ...ISOLATED, GIT_CEILING_DIRECTORIES: tmpdir() } }), null)
})

// ---------------------------------------------------------------------------
// setup wires it; doctor misses it
// ---------------------------------------------------------------------------

test('claudeHooks wires session-check at SessionStart; missingFromSettings notices its absence', () => {
  const start = claudeHooks().SessionStart
  assert.ok(start.some((g) => g.hooks.some((h) => h.command === 'agit hook session-check')))
  const without = { env: agitEnv, hooks: { ...claudeHooks(), SessionStart: [] } }
  assert.deepEqual(missingFromSettings(without), ['hooks: agit hook session-check'])
  assert.deepEqual(missingFromSettings({ env: agitEnv, hooks: claudeHooks() }), [])
})
