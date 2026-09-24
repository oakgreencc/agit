// @ts-check
/**
 * The `jobs` verb's pure half: which jobs of a workflow run failed, on which
 * step, and what to say about it. Reads the shapes GitHub returns from
 * `/actions/runs/<id>` and `/actions/runs/<id>/jobs`; fetching, and writing the
 * logs, stays in src/cli/api.mjs.
 */

/**
 * A run id as typed, or lifted from the run's page URL — the form a failing
 * check hands you (`…/actions/runs/<id>`, optionally `/job/<n>` after it).
 *
 * @param {string} arg
 * @returns {string | null}
 */
export function runIdFrom(arg) {
  if (/^\d+$/.test(arg)) return arg
  return /\/actions\/runs\/(\d+)(?:\/|$)/.exec(arg)?.[1] ?? null
}

/**
 * @typedef {{ name: string, conclusion: string | null }} Step
 * @typedef {{ id: number, name: string, status: string, conclusion: string | null, steps?: Step[] }} Job
 */

/** @param {Job} job */
export const jobFailed = (job) => job.conclusion === 'failure'

/**
 * The steps that failed, in order. A failed job with no failed step is one
 * that died outside its steps (runner lost, timed out at the job level), and
 * an empty list says so honestly.
 *
 * @param {Job} job
 * @returns {string[]}
 */
export const failedSteps = (job) =>
  (job.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name)

/**
 * One line per job — outcome, id, name — with each failed step indented
 * beneath its job. `pass`/`FAIL` for the two outcomes that decide a run, so a
 * red one is visible in a scan; every other conclusion as GitHub names it.
 * The log path follows where one was written. Failed jobs sort
 * first so the reason a run is red is the first thing on screen.
 *
 * @param {Job[]} jobs
 * @param {Record<number, string>} [logs] job id → path written
 * @returns {string[]}
 */
export function jobLines(jobs, logs = {}) {
  const outcome = (/** @type {Job} */ j) =>
    j.status !== 'completed'
      ? j.status
      : j.conclusion === 'success'
        ? 'pass'
        : j.conclusion === 'failure'
          ? 'FAIL'
          : (j.conclusion ?? '?')
  const ordered = [...jobs].sort((a, b) => Number(jobFailed(b)) - Number(jobFailed(a)))
  const lines = []
  for (const j of ordered) {
    lines.push(`${outcome(j)}\t${j.id}\t${j.name}`)
    for (const s of failedSteps(j)) lines.push(`\tstep: ${s}`)
    if (logs[j.id]) lines.push(`\tlog: ${logs[j.id]}`)
  }
  return lines
}

/**
 * The header line for a run: what it is and where it sits, so the job list
 * below it can be read without the URL open.
 *
 * @param {{ id: number, name: string, status: string, conclusion: string | null, head_branch: string, event: string, html_url: string }} run
 */
export const runLine = (run) =>
  `run ${run.id}: ${run.name} — ${run.status}/${run.conclusion ?? '-'} — ${run.head_branch} (${run.event}) — ${run.html_url}`
