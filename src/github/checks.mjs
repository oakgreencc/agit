// @ts-check
/**
 * One check on one ref, and its verdict: `green`, `red` or `unknowable`.
 *
 * Keyed on the CHECK RUN for this ref, never on "the newest workflow run
 * finished": a waiter that polls for a fresh run livelocks when runs keep
 * arriving, and one that takes any finished run reads a cancelled or nightly
 * run as the answer. Only `success` is green. A cancelled, skipped, stale or
 * neutral run did not answer, and neither did a timeout or a read that kept
 * failing — each is `unknowable`, which no caller may treat as green.
 *
 * `agit ci wait` is the shell's way in; the exit code carries the verdict
 * (see {@link VERDICT_EXIT}).
 */

/**
 * The conclusions that are a genuine "this run failed".
 *
 * Everything else GitHub can conclude with — `cancelled`, `skipped`, `stale`,
 * `neutral`, `action_required` — means the run did not answer the question.
 * GitHub cancels an in-flight run when a newer commit pushes to the same
 * concurrency group, so with several agents pushing, a `cancelled` run at the
 * top of the list is the steady state, not an incident.
 */
export const RUN_FAILED = Object.freeze(new Set(['failure', 'timed_out', 'startup_failure']))

/** @typedef {'green' | 'red' | 'unknowable'} Verdict */

/**
 * The exit code `agit ci wait` leaves for each verdict. A usage error also
 * exits 1, but prints no JSON — never 0.
 *
 * @type {Readonly<Record<Verdict, number>>}
 */
export const VERDICT_EXIT = Object.freeze({ green: 0, red: 1, unknowable: 2 })

/** Consecutive unreadable polls after which the wait gives up. */
export const MAX_READ_FAILURES = 3

/** @param {unknown} err  what the client threw — `<path>: <status> <body>` */
export const oneLine = (err) =>
  String(/** @type {any} */ (err)?.message ?? err)
    .replace(/\s+/g, ' ')
    .slice(0, 300)

/**
 * @typedef {object} CheckVerdict
 * @property {Verdict | null} verdict   `null` while the check has not concluded
 * @property {{ name: string, status: string, conclusion: string | null, url: string | null } | null} run
 */

/**
 * The verdict one poll's check runs give for `check` — pure. Re-runs of the
 * same check coexist on a ref; the newest (highest id) is the answer.
 *
 * @param {any[] | null | undefined} checkRuns  `check_runs` as the API lists them
 * @param {string} check
 * @returns {CheckVerdict}
 */
export function checkVerdict(checkRuns, check) {
  const named = (Array.isArray(checkRuns) ? checkRuns : []).filter((r) => r?.name === check)
  const newest = named.reduce((a, r) => (a && (a.id ?? 0) >= (r.id ?? 0) ? a : r), null)
  if (!newest) return { verdict: null, run: null }
  const run = {
    name: newest.name,
    status: newest.status,
    conclusion: newest.conclusion ?? null,
    url: newest.html_url ?? null,
  }
  if (newest.status !== 'completed') return { verdict: null, run }
  if (newest.conclusion === 'success') return { verdict: 'green', run }
  if (RUN_FAILED.has(newest.conclusion)) return { verdict: 'red', run }
  return { verdict: 'unknowable', run }
}

/**
 * @typedef {object} WaitResult
 * @property {Verdict} verdict
 * @property {string} ref
 * @property {string} check
 * @property {CheckVerdict['run']} run
 * @property {string | null} reason   why it is `unknowable`; `null` otherwise
 * @property {number} polls
 */

/**
 * Poll `ref`'s check runs until `check` concludes, `timeoutMs` passes, or
 * {@link MAX_READ_FAILURES} reads in a row fail. Never throws for GitHub's
 * sake: every way of not knowing is the `unknowable` verdict with a reason.
 *
 * @param {{ client: import('./app.mjs').Client, owner: string, repo: string, ref: string, check: string,
 *   intervalMs?: number, timeoutMs?: number, sleep?: (ms: number) => Promise<void>,
 *   now?: () => number, report?: (line: string) => void }} input
 * @returns {Promise<WaitResult>}
 */
export async function pollCheckRunsUntilVerdict({
  client,
  owner,
  repo,
  ref,
  check,
  intervalMs = 30_000,
  timeoutMs = 45 * 60_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  report = () => {},
}) {
  const deadline = now() + timeoutMs
  const path = `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?check_name=${encodeURIComponent(check)}&per_page=100`
  /** @type {CheckVerdict['run']} */
  let last = null
  let failed = 0
  let polls = 0
  /** @param {Verdict} verdict @param {string | null} reason @returns {WaitResult} */
  const done = (verdict, reason) => ({ verdict, ref, check, run: last, reason, polls })
  for (;;) {
    polls++
    try {
      const got = await client.api(path)
      failed = 0
      const { verdict, run } = checkVerdict(got?.check_runs, check)
      last = run ?? last
      if (verdict === 'unknowable') return done(verdict, `${check} concluded ${run?.conclusion}, which is not an answer`)
      if (verdict) return done(verdict, null)
      report(run ? `${check} on ${ref}: ${run.status}` : `${check} on ${ref}: no run yet`)
    } catch (err) {
      failed++
      report(`${check} on ${ref}: read failed (${failed}/${MAX_READ_FAILURES}): ${oneLine(err)}`)
      if (failed >= MAX_READ_FAILURES) return done('unknowable', `check runs unreadable ${failed} times: ${oneLine(err)}`)
    }
    if (now() + intervalMs > deadline)
      return done(
        'unknowable',
        last
          ? `timed out after ${Math.round(timeoutMs / 1000)}s with ${check} ${last.status}`
          : `timed out after ${Math.round(timeoutMs / 1000)}s with no ${check} run`,
      )
    await sleep(intervalMs)
  }
}
