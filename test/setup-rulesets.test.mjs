// @ts-check
/**
 * The base ruleset: detected from the rules in force, written as the human,
 * only ever added to — and a file to import when the human's access fails.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPrompter } from '../src/setup/prompt.mjs'
import { ADMIN_BYPASS, addRules, ensureBaseRuleset, ghAdmin, missingRules, wantedRules } from '../src/setup/rulesets.mjs'

const types = (rules) => rules.map((r) => r.type)
const quiet = () => {}
const prompt = () => createPrompter({ interactive: false })

/** A fake human `gh`: canned GET answers, every call recorded. */
function fakeAdmin(answers = {}, { fail = null } = {}) {
  const calls = []
  return {
    calls,
    who: 'test',
    async api(method, path, body) {
      calls.push({ method, path, body })
      if (fail) throw new Error(fail)
      return answers[`${method} ${path}`] ?? null
    },
  }
}

test('wantedRules: status checks only when a required check is named', () => {
  assert.deepEqual(types(wantedRules()), ['pull_request', 'required_signatures', 'non_fast_forward', 'deletion'])
  assert.equal(wantedRules({ requiredCheck: 'ci' }).at(-1).parameters.required_status_checks[0].context, 'ci')
})

test('missingRules: a PR rule without code owner review, or without the check, is not enough', () => {
  const effective = [
    { type: 'pull_request', parameters: { require_code_owner_review: false } },
    { type: 'required_signatures' },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint' }] } },
  ]
  assert.deepEqual(types(missingRules(effective, wantedRules({ requiredCheck: 'ci' }))), [
    'pull_request',
    'non_fast_forward',
    'deletion',
    'required_status_checks',
  ])
})

test('addRules: tightens and appends, never drops a rule or a check', () => {
  const existing = [
    { type: 'pull_request', parameters: { require_code_owner_review: false, required_approving_review_count: 2 } },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint' }] } },
    { type: 'creation' },
  ]
  const out = addRules(existing, wantedRules({ requiredCheck: 'ci' }))
  const pr = out.find((r) => r.type === 'pull_request')
  assert.equal(pr.parameters.require_code_owner_review, true)
  assert.equal(pr.parameters.required_approving_review_count, 2, 'a stricter review count stays')
  assert.deepEqual(
    out.find((r) => r.type === 'required_status_checks').parameters.required_status_checks.map((c) => c.context),
    ['lint', 'ci'],
  )
  assert.ok(out.some((r) => r.type === 'creation'))
  assert.equal(existing[0].parameters.require_code_owner_review, false, 'the input is not mutated')
})

test('ensureBaseRuleset: already protected — no call as the human at all', async () => {
  const admin = fakeAdmin()
  const out = await ensureBaseRuleset({
    owner: 'o', repo: 'r', base: 'main', effective: wantedRules(), admin, prompt: prompt(), say: quiet,
  })
  assert.equal(out.state, 'ok')
  assert.equal(admin.calls.length, 0)
})

test('ensureBaseRuleset: none yet — creates "agit: main" with admin bypass through PRs, no App bypass', async () => {
  const admin = fakeAdmin({ 'GET /repos/o/r/rulesets': [{ id: 1, name: 'other', target: 'branch' }] })
  const out = await ensureBaseRuleset({
    owner: 'o', repo: 'r', base: 'main', effective: [], admin, prompt: prompt(), say: quiet,
  })
  assert.equal(out.state, 'created')
  const post = admin.calls.at(-1)
  assert.equal(post.method, 'POST')
  assert.equal(post.path, '/repos/o/r/rulesets')
  assert.equal(post.body.name, 'agit: main')
  assert.equal(post.body.enforcement, 'active')
  assert.deepEqual(post.body.conditions.ref_name.include, ['refs/heads/main'])
  assert.deepEqual(post.body.bypass_actors, ADMIN_BYPASS)
  assert.deepEqual(types(post.body.rules), types(wantedRules()))
})

test('ensureBaseRuleset: an existing "agit: main" is extended in place — its bypass list and rules kept', async () => {
  const existing = {
    id: 9,
    name: 'agit: main',
    target: 'branch',
    enforcement: 'evaluate',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
    rules: [{ type: 'required_signatures' }, { type: 'creation' }],
  }
  const admin = fakeAdmin({
    'GET /repos/o/r/rulesets': [{ id: 9, name: 'agit: main', target: 'branch' }],
    'GET /repos/o/r/rulesets/9': existing,
  })
  const out = await ensureBaseRuleset({
    owner: 'o', repo: 'r', base: 'main', effective: [{ type: 'required_signatures' }], admin, prompt: prompt(), say: quiet,
  })
  assert.equal(out.state, 'updated')
  const put = admin.calls.at(-1)
  assert.equal(put.method, 'PUT')
  assert.equal(put.path, '/repos/o/r/rulesets/9')
  assert.equal(put.body.enforcement, 'active')
  assert.deepEqual(put.body.conditions, existing.conditions)
  assert.deepEqual(put.body.bypass_actors, existing.bypass_actors)
  assert.deepEqual(types(put.body.rules), ['required_signatures', 'creation', 'pull_request', 'non_fast_forward', 'deletion'])
})

test('ensureBaseRuleset: the human cannot apply it — the ruleset is left in a file to import', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agit-home-'))
  const lines = []
  try {
    const out = await ensureBaseRuleset({
      owner: 'o', repo: 'r', base: 'main', effective: [],
      admin: fakeAdmin({}, { fail: 'gh is not installed' }),
      prompt: prompt(), say: (l = '') => lines.push(l), env: { AGIT_HOME: home },
    })
    assert.equal(out.state, 'file')
    const body = JSON.parse(readFileSync(/** @type {string} */ (out.file), 'utf8'))
    assert.equal(body.name, 'agit: main')
    assert.match(lines.join('\n'), /gh is not installed/)
    assert.match(lines.join('\n'), /settings\/rules → New ruleset → Import a ruleset/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ghAdmin: gh api with the body on stdin; a failure throws with gh\'s message', async () => {
  const seen = []
  const ok = ghAdmin({
    run: /** @type {any} */ ((cmd, args, opts) => {
      seen.push({ cmd, args, input: opts.input })
      return { status: 0, stdout: '{"id":3}', stderr: '' }
    }),
  })
  assert.deepEqual(await ok.api('POST', '/repos/o/r/rulesets', { a: 1 }), { id: 3 })
  assert.equal(seen[0].cmd, 'gh')
  assert.deepEqual(seen[0].args.slice(0, 4), ['api', '-X', 'POST', 'repos/o/r/rulesets'])
  assert.ok(seen[0].args.includes('--input'))
  assert.equal(seen[0].input, '{"a":1}')

  const denied = ghAdmin({ run: /** @type {any} */ (() => ({ status: 1, stdout: '', stderr: 'HTTP 403: Must have admin rights' })) })
  await assert.rejects(denied.api('GET', '/repos/o/r/rulesets'), /403: Must have admin rights/)
  const missing = ghAdmin({ run: /** @type {any} */ (() => ({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) })) })
  await assert.rejects(missing.api('GET', '/x'), /gh is not installed/)
})
