// @ts-check
/**
 * The publish plan's gates: what a publish or merge WOULD land, judged as a
 * whole, after the tree is built and before anything is sent.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CANDIDATE AND NOT THE PATH LIST.
 *
 * The gates used to judge the worktree's dirty-path list, and the tree was
 * built afterwards. But the pre-commit hook runs INSIDE the build, and what it
 * stages is what ships (git-hooks.mjs) — so a formatter touching a second
 * file, or a codegen step writing a protected one, landed a path no gate had
 * seen. Judging the candidate — `diff-tree base..tree` of the tree as built —
 * closes that: every gate sees exactly the paths the commit changes.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, in code rather than prose:
 *
 *   1. protection     CODEOWNERS-protected paths need a `protected` grant;
 *                     impossible paths are refused outright (Protection's `judge`)
 *   2. displacement   a publish whose worktree is behind the branch would
 *                     revert the paths it lands (gates/drift.mjs) — worktree
 *                     publishes only; a merge checks its first parent instead
 *   3. payload        no *.log, no path growing by more than the ceiling,
 *                     measured in the tree (gates/scope.mjs)
 *
 * A merge's candidate paths are its RESOLUTION — content that is neither
 * parent's. What came whole from either side was reviewed where it came from.
 */

import { PublishError } from '../errors.mjs'
import { displacementMessage, findDisplacement } from '../gates/drift.mjs'
import { payloadMessage, payloadRefusalsInTree } from '../gates/scope.mjs'
import { grantAdvice } from '../maintainer.mjs'
import { judge } from '../protected.mjs'

/**
 * @typedef {import('./publish.mjs').Candidate} Candidate
 * @typedef {import('../protected.mjs').Policy & { configProblem?: string | null }} Policy
 */

/**
 * Judge a candidate. Throws a PublishError for the first gate that refuses;
 * returns the notes — what went through, and on whose say-so — to print.
 *
 * @param {object} input
 * @param {(args: string[]) => string} input.git      runs in the worktree
 * @param {Candidate} input.candidate
 * @param {Policy[]} input.policies                   the base's first, then the worktree's
 * @param {import('../maintainer.mjs').GrantView} input.grant
 * @param {{ ceilingBytes: number, neverPublish: string[] }} input.payload   `.agit.json`'s `payload`
 * @param {{ allowLarge?: string[], allowDisplacement?: boolean }} [input.overrides]
 * @param {{ base: string, branch: string }} input.names   for the messages
 * @returns {string[]}
 */
export function judgeCandidate({ git, candidate, policies, grant, payload, overrides = {}, names }) {
  const notes = []
  for (const p of policies)
    if (p.configProblem) notes.push(`note: ${p.configProblem} — that policy was judged by the defaults.`)

  notes.push(...protection({ paths: candidate.paths, policies, grant }))
  if (candidate.kind === 'worktree' && !overrides.allowDisplacement) displacement({ git, candidate, names })

  const refused = payloadRefusalsInTree({
    git,
    base: candidate.base.sha,
    tree: candidate.tree,
    paths: candidate.paths,
    allow: overrides.allowLarge ?? [],
    ceiling: payload.ceilingBytes,
    neverPublish: payload.neverPublish,
  })
  if (refused.length) throw new PublishError(payloadMessage(refused, { ceiling: payload.ceilingBytes }))
  return notes
}

/** Gate 1. The policy is read from the BASE as GitHub will enforce it, and from the worktree too. */
function protection({ paths, policies, grant }) {
  const v = judge({ paths, policies, grant })
  if (v.impossible.length) {
    const n = v.impossible.length
    throw new PublishError(
      `refusing to publish: ${n} path${n === 1 ? '' : 's'} cannot be written by the App at all:\n\n` +
        v.impossible.map((h) => `  ${h.path} — ${h.why}`).join('\n') +
        '\n\nNo grant unlocks these: the App does not hold the permission. Describe the exact\n' +
        'change and hand it to a human to apply. Leave these paths out of --paths.',
    )
  }
  if (!v.protected.length) return []
  if (v.lifted)
    return [
      `protected paths published under maintainer grant ("${/** @type {any} */ (grant).grant.reason}"): ` +
        `${v.protected.map((h) => h.path).join(', ')} — the PR still needs the code owners' review.`,
    ]
  const n = v.protected.length
  throw new PublishError(
    `refusing to publish: ${n} path${n === 1 ? ' is' : 's are'} protected — they decide what the gates\n` +
      'catch, what an agent may do, or what reaches production, so a human approves them:\n\n' +
      v.protected.map((h) => `  ${h.path} — ${h.why}`).join('\n') +
      '\n\n' +
      grantAdvice(grant, 'protected') +
      '\nOr leave them out of --paths and publish the rest. (A path the pre-commit hook\n' +
      'staged is judged too: it ships like any other.)',
  )
}

/** Gate 2. Compare the worktree's base with the branch head over exactly the landed paths. */
function displacement({ git, candidate, names }) {
  let worktreeBase
  try {
    worktreeBase = git(['rev-parse', 'HEAD']).trim()
  } catch {
    return // a worktree with no commits has nothing to be stale against
  }
  if (!candidate.paths.length) return
  const branchHead = candidate.base.sha
  const displaced = findDisplacement({ git, worktreeBase, branchHead, paths: candidate.paths })
  if (displaced.length)
    throw new PublishError(displacementMessage(displaced, { ...names, worktreeBase, branchHead }))
}
