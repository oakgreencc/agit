// @ts-check
/**
 * The prompter without a terminal behaves as if `--yes` were given: defaults
 * are taken, confirmations are yes, and only a question with no default
 * refuses — naming the flag that answers it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPrompter } from '../src/setup/prompt.mjs'

test('no terminal: a question with a default takes it, no --yes needed', async () => {
  const p = createPrompter({ interactive: false })
  assert.equal(await p.ask('App name', { default: 'acme-agents', flag: '--name' }), 'acme-agents')
})

test('no terminal: a confirmation is a yes', async () => {
  const p = createPrompter({ interactive: false })
  assert.equal(await p.confirm('write .agit.json?', { default: false }), true)
})

test('no terminal: a question without a default refuses, naming its flag', async () => {
  const p = createPrompter({ interactive: false })
  await assert.rejects(p.ask('Owner', { flag: '--owner or --org' }), /no terminal to ask on\. Pass --owner or --org\./)
})
