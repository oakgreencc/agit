// @ts-check
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SUBVERBS, VERBS } from '../src/cli/verbs.mjs'
import { permissionRuleFindings } from '../src/setup/doctor.mjs'
import {
  AGENT_CALLS,
  NOT_AGENT,
  bashSpecMatches,
  describeCall,
  droppedInAutoMode,
  readSettingsLayers,
  unallowedCalls,
  verdictFor,
} from '../src/setup/permissions.mjs'
import { ALLOW, DENY, claudeHooks, gitConfigEnv, mergeSettings } from '../src/setup/settings.mjs'
import { verbsNamedIn } from '../src/verb-drift.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bash = (command) => ({ tool: 'Bash', command, why: 'test' })

/** `verb` and `verb action` for every agit call in the list. */
const covered = new Set(
  AGENT_CALLS.flatMap((c) => {
    const m = /^agit ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/.exec(c.command ?? '')
    if (!m) return []
    return Object.hasOwn(SUBVERBS, m[1]) && m[2] ? [m[1], `${m[1]} ${m[2]}`] : [m[1]]
  }),
)

/** Every verb, and every action of a noun, agit has. */
const everything = [...Object.keys(VERBS), ...Object.entries(SUBVERBS).flatMap(([noun, acts]) => acts.map((a) => `${noun} ${a}`))]

test('every verb and action is either an agent call or says why not — never both, never neither', () => {
  const neither = everything.filter((v) => !covered.has(v) && !Object.hasOwn(NOT_AGENT, v))
  const both = everything.filter((v) => covered.has(v) && Object.hasOwn(NOT_AGENT, v))
  assert.deepEqual({ neither, both }, { neither: [], both: [] })
})

test('NOT_AGENT names only verbs and actions agit has', () => {
  assert.deepEqual(Object.keys(NOT_AGENT).filter((v) => !everything.includes(v)), [])
})

test('every agit invocation the skill names is in the list or says why not', () => {
  const skill = readFileSync(join(ROOT, 'skills', 'agit', 'SKILL.md'), 'utf8')
  const missing = verbsNamedIn(skill)
    .map(({ verb, action }) => (action ? `${verb} ${action}` : verb))
    .filter((v) => v !== 'help' && !covered.has(v) && !Object.hasOwn(NOT_AGENT, v))
  assert.deepEqual([...new Set(missing)], [])
})

test('what agit setup project writes explicitly allows every call the workflow makes', () => {
  const written = mergeSettings({}, { env: gitConfigEnv({ owners: ['acme'] }), hooks: claudeHooks() })
  const gaps = unallowedCalls([written]).map((g) => `${describeCall(g.call)} → ${g.verdict}${g.rule ? ` (${g.rule})` : ''}`)
  assert.deepEqual(gaps, [])
})

test('setup allow rules survive auto mode, and none of them is denied by setup itself', () => {
  assert.deepEqual(ALLOW.filter(droppedInAutoMode), [])
  for (const call of AGENT_CALLS) assert.notEqual(verdictFor([{ permissions: { deny: DENY } }], call).verdict, 'deny', describeCall(call))
})

test('bash rule matching: prefix, bare command, word boundary, legacy :*, middle *', () => {
  assert.equal(bashSpecMatches('git status *', 'git status'), false)
  assert.equal(bashSpecMatches('git status:*', 'git status'), false)
  assert.ok(bashSpecMatches('git status *', 'git status --short'))
  assert.ok(bashSpecMatches('git status:*', 'git status --short'))
  assert.ok(bashSpecMatches('git status', 'git status'))
  assert.ok(bashSpecMatches('ls*', 'lsof'))
  assert.equal(bashSpecMatches('ls *', 'lsof'), false)
  assert.equal(bashSpecMatches('git status', 'git status --short'), false)
  assert.ok(bashSpecMatches('git * --no-commit origin/*', 'git merge --no-commit origin/main'))
  assert.equal(bashSpecMatches('git fetch *', 'git fetchx'), false)
})

test('verdict: deny beats ask beats allow, across layers; rules auto mode drops allow nothing', () => {
  const call = bash('agit validate')
  assert.equal(verdictFor([{ permissions: { allow: ['Bash(agit *)'] } }], call).verdict, 'allow')
  assert.equal(verdictFor([{ permissions: { allow: ['Bash(agit *)'] } }, { permissions: { ask: ['Bash(agit validate)'] } }], call).verdict, 'ask')
  assert.equal(verdictFor([{ permissions: { deny: ['Bash(agit:*)'], ask: ['Bash(agit *)'] } }], call).verdict, 'deny')
  for (const broad of ['Bash', 'Bash(*)', 'Bash(node *)', 'Bash(npm run *)', 'Bash(bash -c *)'])
    assert.equal(verdictFor([{ permissions: { allow: [broad] } }], bash('node x.js; agit validate')).verdict, 'none', broad)
  assert.equal(verdictFor([{ permissions: { allow: ['EnterWorktree'] } }], { tool: 'EnterWorktree', why: '' }).verdict, 'allow')
  assert.equal(verdictFor([{ permissions: { allow: ['Bash(agit *)'] } }], { tool: 'ExitWorktree', why: '' }).verdict, 'none')
})

test('doctor: one warning per call not allowed, and an ok when none is missing', () => {
  const gaps = permissionRuleFindings([{ path: 'u', settings: { permissions: { allow: ['Bash(agit *)'], deny: ['Bash(git status)'] } } }])
  assert.ok(gaps.every((f) => f.level === 'warn'))
  assert.ok(gaps.some((f) => f.label === 'Bash(git status) is denied by Bash(git status)'))
  assert.ok(gaps.some((f) => f.label === 'EnterWorktree is not explicitly allowed'))
  assert.deepEqual(permissionRuleFindings([{ path: 'p', settings: { permissions: { allow: ALLOW } } }]).map((f) => f.level), ['ok'])
})

// The live check: this checkout's settings plus this machine's user settings.
// They are not the repo's to fix in CI, so it runs on request:
//   npm run conformance
test('this machine: the settings layers allow every call the workflow makes', { skip: !process.env.AGIT_CONFORMANCE }, () => {
  const layers = readSettingsLayers({ root: ROOT })
  const gaps = unallowedCalls(layers.map((l) => l.settings)).map(
    (g) => `${describeCall(g.call)} → ${g.verdict}${g.rule ? ` (${g.rule})` : ''} — ${g.call.why}`,
  )
  assert.deepEqual(gaps, [], `read: ${layers.map((l) => l.path).join(', ')}`)
})
