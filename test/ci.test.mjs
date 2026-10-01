// @ts-check
/**
 * `agit ci wait` and the check verdict under it: only `success` is green,
 * a genuine failure is red, and every way of not knowing — a cancelled run,
 * a timeout, reads that keep failing — is `unknowable`, never green.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as ci } from '../src/cli/ci.mjs'
import { PublishError } from '../src/errors.mjs'
import { checkVerdict, MAX_READ_FAILURES, pollCheckRunsUntilVerdict, RUN_FAILED, VERDICT_EXIT } from '../src/github/checks.mjs'
import { emptyDir, github, sequence } from './routes.mjs'

const check = (conclusion, status = 'completed', id = 1, name = 'ci') => ({
  id,
  name,
  status,
  conclusion,
  html_url: `https://github.com/o/r/runs/${id}`,
})

test('checkVerdict: only success is green; failures are red; every other conclusion is unknowable', () => {
  assert.equal(checkVerdict([check('success')], 'ci').verdict, 'green')
  for (const c of ['failure', 'timed_out', 'startup_failure']) assert.equal(checkVerdict([check(c)], 'ci').verdict, 'red', c)
  for (const c of ['cancelled', 'skipped', 'stale', 'neutral', 'action_required', null])
    assert.equal(checkVerdict([check(c)], 'ci').verdict, 'unknowable', String(c))
  assert.deepEqual([...RUN_FAILED].sort(), ['failure', 'startup_failure', 'timed_out'])
})

test('checkVerdict: not concluded yet, or no run of that name, is no verdict', () => {
  assert.equal(checkVerdict([check(null, 'in_progress')], 'ci').verdict, null)
  assert.equal(checkVerdict([check('success', 'completed', 1, 'lint')], 'ci').verdict, null)
  assert.equal(checkVerdict(undefined, 'ci').verdict, null)
})

test('checkVerdict: the newest re-run of a check is the answer, whatever the list order', () => {
  assert.equal(checkVerdict([check('failure', 'completed', 1), check('success', 'completed', 2)], 'ci').verdict, 'green')
  assert.equal(checkVerdict([check('success', 'completed', 2), check('failure', 'completed', 1)], 'ci').verdict, 'green')
})

test('the exit codes distinguish all three verdicts, and only green is 0', () => {
  assert.deepEqual(VERDICT_EXIT, { green: 0, red: 1, unknowable: 2 })
  assert.equal(MAX_READ_FAILURES, 3)
})

const RUNS = 'GET /repos/o/r/commits/abc/check-runs?check_name=ci&per_page=100'

/** A clock that advances by each sleep, so timeouts are exact and instant. */
function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (/** @type {number} */ ms) => {
      t += ms
    },
  }
}

const poll = (client, over = {}) =>
  pollCheckRunsUntilVerdict({ client, owner: 'o', repo: 'r', ref: 'abc', check: 'ci', ...clock(), ...over })

test('pollCheckRunsUntilVerdict polls through pending until the check concludes', async () => {
  const { client } = github({
    [RUNS]: sequence([{ check_runs: [] }, { check_runs: [check(null, 'in_progress')] }, { check_runs: [check('success')] }]),
  })
  const got = await poll(client)
  assert.equal(got.verdict, 'green')
  assert.equal(got.polls, 3)
  assert.equal(got.reason, null)
  assert.equal(got.run?.url, 'https://github.com/o/r/runs/1')
})

test('a red check is red', async () => {
  const { client } = github({ [RUNS]: { check_runs: [check('failure')] } })
  assert.equal((await poll(client)).verdict, 'red')
})

test('a cancelled check is unknowable, with the conclusion named', async () => {
  const { client } = github({ [RUNS]: { check_runs: [check('cancelled')] } })
  const got = await poll(client)
  assert.equal(got.verdict, 'unknowable')
  assert.match(String(got.reason), /cancelled/)
})

test('no conclusive run before the timeout is unknowable, not green', async () => {
  for (const reply of [{ check_runs: [] }, { check_runs: [check(null, 'queued')] }]) {
    const { client } = github({ [RUNS]: reply })
    const got = await poll(client, { timeoutMs: 60_000, intervalMs: 10_000 })
    assert.equal(got.verdict, 'unknowable')
    assert.match(String(got.reason), /timed out/)
    assert.ok(got.polls >= 6 && got.polls <= 7, String(got.polls))
  }
})

test('reads that keep failing are unknowable after three in a row; one blip is retried', async () => {
  const gone = await poll(github({}).client)
  assert.equal(gone.verdict, 'unknowable')
  assert.equal(gone.polls, 3)
  assert.match(String(gone.reason), /unreadable 3 times/)

  const { client } = github({
    [RUNS]: sequence([{ status: 502, body: { message: 'bad gateway' } }, { check_runs: [check('success')] }]),
  })
  assert.equal((await poll(client)).verdict, 'green')
})

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/** Run `agit ci wait` with stdout/stderr captured and an instant clock. */
async function go(argv, client, dir = emptyDir()) {
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const err = []
  const code = await ci([...argv, '-C', dir, '--repo', 'o/r'], {
    client,
    ...clock(),
    say: (l) => out.push(l),
    report: (l) => err.push(l),
  })
  return { code, out, err }
}

test('ci wait exits 0 green, 1 red, 2 unknowable — and prints the verdict JSON either way', async () => {
  for (const [conclusion, code] of /** @type {const} */ ([
    ['success', 0],
    ['failure', 1],
    ['cancelled', 2],
  ])) {
    const { client } = github({ [RUNS]: { check_runs: [check(conclusion)] } })
    const got = await go(['wait', 'abc', '--check', 'ci'], client)
    assert.equal(got.code, code, conclusion)
    assert.equal(got.out.length, 1)
    assert.equal(JSON.parse(got.out[0]).verdict, Object.keys(VERDICT_EXIT)[code])
  }
})

test('ci wait: progress goes to stderr, the JSON alone to stdout', async () => {
  const { client } = github({ [RUNS]: sequence([{ check_runs: [] }, { check_runs: [check('success')] }]) })
  const got = await go(['wait', 'abc', '--check', 'ci', '--interval', '1'], client)
  assert.equal(got.code, 0)
  assert.deepEqual(got.err, ['ci on abc: no run yet'])
  assert.equal(JSON.parse(got.out[0]).polls, 2)
})

test('ci wait --timeout and --interval are whole seconds', async () => {
  const { client } = github({ [RUNS]: { check_runs: [] } })
  const got = await go(['wait', 'abc', '--check', 'ci', '--timeout', '60', '--interval', '10'], client)
  assert.equal(got.code, 2)
  assert.match(JSON.parse(got.out[0]).reason, /timed out after 60s/)
  await assert.rejects(go(['wait', 'abc', '--check', 'ci', '--timeout', '1m'], client), PublishError)
})

test('ci wait --check defaults to the project requiredCheck', async () => {
  const dir = emptyDir()
  writeFileSync(join(dir, '.agit.json'), JSON.stringify({ requiredCheck: 'build' }))
  const { client, calls } = github({
    'GET /repos/o/r/commits/abc/check-runs?check_name=build&per_page=100': { check_runs: [check('success', 'completed', 1, 'build')] },
  })
  const got = await go(['wait', 'abc'], client, dir)
  assert.equal(got.code, 0)
  assert.equal(calls.length, 1)
})

test('ci wait with no check to ask about, or a malformed line, is a usage error with no JSON and no request', async () => {
  const { client, calls } = github({})
  for (const argv of [['wait', 'abc'], ['wait'], ['watch', 'abc', '--check', 'ci'], ['wait', 'a', 'b', '--check', 'ci']]) {
    /** @type {string[]} */
    const out = []
    await assert.rejects(
      ci([...argv, '-C', emptyDir(), '--repo', 'o/r'], { client, say: (l) => out.push(l) }),
      (e) => e instanceof PublishError && /usage: agit ci wait/.test(e.message),
      argv.join(' '),
    )
    assert.deepEqual(out, [])
  }
  assert.equal(calls.length, 0)
})
