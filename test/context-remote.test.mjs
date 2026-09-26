// @ts-check
/**
 * agit's own reads from GitHub go as the App, whatever the session's
 * environment: never the human's SSH key, keychain or `gh` helper.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gitIn, remoteAsApp } from '../src/context.mjs'

test('remoteAsApp: fetch and ls-remote get the App config; local commands and push do not', () => {
  const { args, env } = remoteAsApp(['fetch', 'origin', 'main'])
  assert.deepEqual(args.slice(-3), ['fetch', 'origin', 'main'])
  const config = args.filter((_, i) => args[i - 1] === '-c')
  assert.ok(config.includes('url.https://github.com/.insteadOf=git@github.com:'))
  assert.ok(config.includes('url.https://github.com/.insteadOf=ssh://git@github.com/'))
  // The reset comes before agit's helper, so the human's helpers never answer.
  assert.ok(config.indexOf('credential.https://github.com.helper=') < config.indexOf('credential.https://github.com.helper=!agit credential'))
  assert.equal(env.GIT_SSH_COMMAND, 'false')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')

  assert.equal(remoteAsApp(['ls-remote', 'origin']).env.GIT_SSH_COMMAND, 'false')
  for (const local of [['status'], ['rev-parse', 'HEAD'], ['push', 'origin', 'main']])
    assert.deepEqual(remoteAsApp(local), { args: local, env: {} })
})

test('gitIn: an SSH origin resolves to HTTPS for a remote read, even with no session env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agit-remote-'))
  try {
    execFileSync('git', ['init', '-q', dir])
    const git = gitIn(dir)
    for (const url of ['git@github.com:acme/widgets.git', 'ssh://git@github.com/acme/widgets.git']) {
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url])
      // --get-url applies insteadOf and prints, without touching the network.
      assert.equal(git(['ls-remote', '--get-url', 'origin']).trim(), 'https://github.com/acme/widgets.git')
      // A plain local git still sees the remote as configured.
      assert.equal(git(['remote', 'get-url', 'origin']).trim(), url)
      execFileSync('git', ['-C', dir, 'remote', 'remove', 'origin'])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
