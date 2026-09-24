// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  claudeHooks,
  envToPairs,
  gitConfigEnv,
  mergeSettings,
  missingFromSettings,
} from '../src/setup/settings.mjs'

test('gitConfigEnv: the exact block, rewrites first, helper reset before agit', () => {
  assert.deepEqual(gitConfigEnv({ owners: ['acme', 'me'] }), {
    GIT_CONFIG_COUNT: '7',
    GIT_CONFIG_KEY_0: 'url.https://github.com/acme/.insteadOf',
    GIT_CONFIG_VALUE_0: 'git@github.com:acme/',
    GIT_CONFIG_KEY_1: 'url.https://github.com/me/.insteadOf',
    GIT_CONFIG_VALUE_1: 'git@github.com:me/',
    GIT_CONFIG_KEY_2: 'credential.https://github.com.useHttpPath',
    GIT_CONFIG_VALUE_2: 'true',
    GIT_CONFIG_KEY_3: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_3: '',
    GIT_CONFIG_KEY_4: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_4: '!agit credential',
    GIT_CONFIG_KEY_5: 'commit.gpgsign',
    GIT_CONFIG_VALUE_5: 'false',
    GIT_CONFIG_KEY_6: 'tag.gpgsign',
    GIT_CONFIG_VALUE_6: 'false',
  })
})

const add = () => ({ env: gitConfigEnv({ owners: ['acme'] }), hooks: claudeHooks() })

test('mergeSettings: from nothing, everything agit needs; doctor finds nothing missing', () => {
  const s = mergeSettings({}, add())
  assert.deepEqual(missingFromSettings(s), [])
  assert.ok(s.permissions.allow.includes('Bash(agit *)'))
  assert.ok(s.permissions.deny.includes('Bash(git push *)'))
  assert.ok(s.permissions.deny.includes('Bash(gh *)'))
})

test('mergeSettings: idempotent', () => {
  const once = mergeSettings({}, add())
  assert.deepEqual(mergeSettings(once, add()), once)
})

test('mergeSettings: keeps unrelated keys, hooks, permissions and non-agit git config', () => {
  const existing = {
    model: 'opus',
    env: {
      FOO: '1',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'commit.gpgsign',
      GIT_CONFIG_VALUE_1: 'true',
      GIT_CONFIG_KEY_2: 'url.https://github.com/old/.insteadOf',
      GIT_CONFIG_VALUE_2: 'git@github.com:old/',
    },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-hook' }] }],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'notify' }] }],
    },
    permissions: { allow: ['WebSearch'] },
  }
  const out = mergeSettings(existing, add())
  assert.equal(out.model, 'opus')
  assert.equal(out.env.FOO, '1')
  const pairs = envToPairs(out.env)
  assert.deepEqual(pairs.filter(([k]) => k === 'core.autocrlf'), [['core.autocrlf', 'false']])
  // agit's keys replaced wholesale: no stale gpgsign=true, no leftover rewrite.
  assert.deepEqual(pairs.filter(([k]) => k === 'commit.gpgsign'), [['commit.gpgsign', 'false']])
  assert.equal(pairs.some(([k]) => k.includes('/old/')), false)
  const bash = out.hooks.PreToolUse.filter((g) => g.matcher === 'Bash')
  assert.equal(bash.length, 1)
  assert.deepEqual(
    bash[0].hooks.map((h) => h.command),
    ['my-hook', 'agit hook guard-credentials', 'agit hook guard-pr-writes', 'agit hook guard-protected'],
  )
  assert.deepEqual(out.hooks.Stop, existing.hooks.Stop)
  assert.ok(out.permissions.allow.includes('WebSearch'))
  // The input is not mutated.
  assert.equal(existing.env.GIT_CONFIG_COUNT, '3')
})

test('missingFromSettings: names each missing piece', () => {
  const missing = missingFromSettings({})
  assert.equal(missing.length, 6)
  assert.ok(missing.some((m) => m.includes('agit credential')))
  assert.ok(missing.some((m) => m.includes('guard-protected')))
})
