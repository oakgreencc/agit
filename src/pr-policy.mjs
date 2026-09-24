// @ts-check
/**
 * When an agent may merge a pull request itself — the decision behind
 * `agit pr merge`, as a pure function of facts read from GitHub.
 *
 * Three rules, each with the incident that made it a rule in the harness agit
 * was ported from:
 *
 *   BASE        only into `mergeableBases` (default: the base branch agent PRs
 *               land on). A PR aimed at a promotion branch that runs no CI is
 *               a human's merge.
 *   PROTECTED   not when the diff touches a path CODEOWNERS protects on the
 *               BASE. Once agents merged their own green PRs, nothing stopped
 *               one weakening the CI gate and merging the change that weakened
 *               it; a merge guard that looked only at the base branch had no
 *               idea what the diff contained. CODEOWNERS with "require review
 *               from Code Owners" is the server-side boundary; this refuses
 *               first, by name, instead of letting the agent discover the rule
 *               from a failed merge.
 *   RED BASE    not onto a base whose required check is failing — stacking a
 *               change on a known break buries it. With ONE way out, because
 *               the rule once deadlocked a repo: the PR that fixed the break
 *               was refused because of the break. A PR whose head already
 *               CONTAINS the base's head and is green on it is direct evidence
 *               the break is fixed, and goes through.
 *
 * A maintainer grant with the `merge` scope lifts all three, and the lift is
 * printed, never silent. It lifts agit's opinion only: GitHub's rulesets still
 * apply. An `impossible` path in the diff is not liftable — no grant gives the
 * App a permission it does not hold.
 *
 * FAILURE POSTURE. A fact this cannot read about THE PR (its files) refuses:
 * a merge whose contents cannot be seen cannot be cleared. A fact about the
 * BASE's health that cannot be read allows: refusing would block every merge
 * in the repo for the length of an outage, and a stop-the-line rule that
 * cannot be un-stuck is worse than the breakage it prevents.
 */

import { judge } from './protected.mjs'

/**
 * @typedef {{ number: number, base: string, headSha: string }} PrFacts
 * @typedef {{ text: string, liftable: boolean }} Refusal
 * @typedef {{
 *   files: () => Promise<string[]>,
 *   baseRed?: () => Promise<{ conclusion: string, url?: string } | false | null>,
 *   rescue?: () => Promise<{ ok: boolean, why?: string }>,
 * }} Lookups
 */

/**
 * @param {object} input
 * @param {PrFacts} input.pr
 * @param {string[]} input.allowedBases
 * @param {import('./protected.mjs').Policy} input.policy   as of the base
 * @param {string | null} [input.policyProblem]             the base's `.agit.json` did not parse
 * @param {string | null} input.requiredCheck
 * @param {boolean} input.granted                            an active `merge` grant
 * @param {Lookups} input.lookups
 * @returns {Promise<{ ok: boolean, refusals: Refusal[], lifted: Refusal[], notes: string[] }>}
 */
export async function mergeVerdict({ pr, allowedBases, policy, policyProblem = null, requiredCheck, granted, lookups }) {
  /** @type {Refusal[]} */
  const found = []
  /** @type {string[]} */
  const notes = []
  const label = `#${pr.number}`

  // --- base -----------------------------------------------------------------
  if (!allowedBases.includes(pr.base)) {
    found.push({
      liftable: true,
      text: allowedBases.length
        ? `${label} targets \`${pr.base}\`; agents merge only into ${allowedBases.map((b) => `\`${b}\``).join(', ')} (mergeableBases in .agit.json).`
        : `${label}: this project lets no agent merge (mergeableBases is empty in .agit.json).`,
    })
  }

  // --- protected paths --------------------------------------------------------
  let files = null
  try {
    files = await lookups.files()
  } catch (err) {
    found.push({
      liftable: false,
      text: `cannot read the files ${label} changes (${/** @type {Error} */ (err).message}); a merge whose contents cannot be seen cannot be cleared.`,
    })
  }
  if (policyProblem) {
    found.push({
      liftable: true,
      text:
        `the policy on \`${pr.base}\` does not parse (${policyProblem}), so ${label} was judged by the defaults — ` +
        'a policy nobody wrote. Fix .agit.json on the base first.',
    })
  }
  if (files) {
    const { impossible, protected: guarded } = judge({ paths: files, policies: [policy] })
    if (impossible.length)
      found.push({
        liftable: false,
        text:
          `${label} changes ${impossible.map((h) => `\`${h.path}\``).join(', ')}, which the App cannot write ` +
          '(protected.impossible). A human merges it.',
      })
    if (guarded.length) {
      const list = guarded.slice(0, 5).map((h) => `  ${h.path} — ${h.why}`)
      if (guarded.length > 5) list.push(`  … and ${guarded.length - 5} more`)
      found.push({
        liftable: true,
        text:
          `${label} changes ${guarded.length} protected path${guarded.length === 1 ? '' : 's'}:\n${list.join('\n')}\n` +
          "These are the code owners' to approve; hand the PR over rather than retrying.",
      })
    }
  }

  // --- stop the line ------------------------------------------------------------
  if (requiredCheck && lookups.baseRed) {
    let red = null
    try {
      red = await lookups.baseRed()
    } catch {
      red = null // unreadable base health allows — see FAILURE POSTURE
    }
    if (red) {
      let rescued = { ok: false, why: 'the rescue check is unavailable' }
      try {
        if (lookups.rescue) rescued = await lookups.rescue()
      } catch (err) {
        rescued = { ok: false, why: `that could not be checked: ${/** @type {Error} */ (err).message}` }
      }
      if (rescued.ok) {
        notes.push(
          `\`${pr.base}\` is red (\`${requiredCheck}\`: ${red.conclusion}), but ${label} contains its head and is green on it — allowed through as the fix.`,
        )
      } else {
        found.push({
          liftable: true,
          text:
            `\`${pr.base}\` is red — its \`${requiredCheck}\` check concluded \`${red.conclusion}\`${red.url ? ` (${red.url})` : ''}.\n` +
            `Merging onto a known break buries it, and ${label} is not the cure: ${rescued.why}.\n\n` +
            'If this PR DOES fix the break, that is reachable from here:\n' +
            `  1. agit pr update ${pr.number}      # put the broken head underneath this branch\n` +
            `  2. let its own \`${requiredCheck}\` check finish green on the updated head\n` +
            `  3. agit pr merge ${pr.number}       # a branch that carries the break and passes goes through`,
        })
      }
    }
  }

  const blocking = found.filter((r) => !r.liftable || !granted)
  const lifted = granted ? found.filter((r) => r.liftable) : []
  return { ok: blocking.length === 0, refusals: blocking, lifted, notes }
}

/**
 * The rescue facts, read: does `headSha` contain the base's head, and is its
 * required check green? Pure over an injected `get`.
 *
 * @param {{ get: (path: string) => Promise<any>, owner: string, repo: string, base: string, headSha: string, check: string }} input
 */
export async function rescueFacts({ get, owner, repo, base, headSha, check }) {
  const short = headSha.slice(0, 7)
  const cmp = await get(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${headSha}`)
  if (cmp?.behind_by !== 0) {
    const behind = typeof cmp?.behind_by === 'number' ? ` — ${cmp.behind_by} commit(s) behind` : ''
    return { ok: false, why: `${short} does not contain \`${base}\`'s current head${behind}` }
  }
  const run = (await get(checkRunsPath({ owner, repo, ref: headSha, check })))?.check_runs?.[0]
  if (run?.status !== 'completed') return { ok: false, why: `its \`${check}\` check has not completed on ${short}` }
  if (run.conclusion !== 'success')
    return { ok: false, why: `its \`${check}\` check on ${short} concluded \`${run.conclusion}\`` }
  return { ok: true }
}

/**
 * Is `base` red? `false` green, `null` unknown, else the failing run.
 *
 * @param {{ get: (path: string) => Promise<any>, owner: string, repo: string, base: string, check: string }} input
 */
export async function baseHealth({ get, owner, repo, base, check }) {
  const run = (await get(checkRunsPath({ owner, repo, ref: base, check })))?.check_runs?.[0]
  if (!run || run.status !== 'completed') return null
  if (['success', 'neutral', 'skipped'].includes(run.conclusion)) return false
  return { conclusion: run.conclusion, url: run.html_url }
}

// `filter=latest` collapses re-runs to the one that counts, so an old green
// cannot outvote a newer red on the same commit.
const checkRunsPath = ({ owner, repo, ref, check }) =>
  `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?check_name=${encodeURIComponent(check)}&filter=latest&per_page=100`
