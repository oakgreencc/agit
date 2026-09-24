// @ts-check
/**
 * Refuse a publish that would silently revert someone else's work.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS FOR.
 *
 * `agit publish` publishes the worktree's **file contents**, not a diff. That
 * is what lets it commit uncommitted work through the API, and it is also a
 * loaded gun: any file whose committed base in the worktree is older than the
 * branch it lands on gets rewritten to the older version. No conflict, green
 * CI, "Pull Request successfully merged".
 *
 * It fired twice in the harness agit was ported from.
 *
 *   - 2026-08-15 — two PRs branched from an integration branch that
 *     predated each other's merge; the second clobbered the first.
 *   - 2026-08-18 — a worktree created by the `EnterWorktree` tool, which
 *     branches from `origin/<default-branch>`. The default branch here is
 *     `main`, so the worktree was stale by *everything not yet promoted*. It
 *     deleted the ADMIN-7.7 bullet from `apps/admin/CLAUDE.md` — content that
 *     was on `develop` but not yet on `main`. Restored by hand.
 *
 * Both were caught by a human reading a diff. Nothing else could have: the
 * result is valid content, so no check that looks at the *result* can tell.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CHECKS, AND WHY THAT IS THE RIGHT QUESTION.
 *
 * Not "did the author's edit break something" — CI answers that. The question
 * here is **what does this publish overwrite that the author never saw?**
 *
 * A whole-file publish carries `base + edits`. The edits are intended; `base`
 * is not, and is invisible in every artifact the author reviews. So compare the
 * two bases — the worktree's `HEAD` against the head of the branch being
 * published onto — over exactly the paths being published. Anything that
 * differs is content the publish will displace.
 *
 * This deliberately ignores the working tree. Uncommitted edits are the point
 * of the publish; it is the ground they sit on that has to match.
 */

/**
 * Paths whose committed base differs between the worktree and the branch.
 *
 * `git` is injected rather than imported so this stays a pure function of its
 * inputs and can be tested without a repository.
 *
 * @param {object} input
 * @param {(args: string[]) => string} input.git  runs git in the worktree, returns stdout
 * @param {string} input.worktreeBase             the worktree's HEAD commit
 * @param {string} input.branchHead               the commit the publish lands on
 * @param {string[] | null} [input.paths]         repo-relative paths being published;
 *                                                omitted or empty means every path
 * @returns {string[]} displaced paths, sorted
 */
export function findDisplacement({ git, worktreeBase, branchHead, paths }) {
  // No pathspec when nothing is scoped: an unscoped publish sweeps the whole
  // worktree, so the whole tree is what it can displace.
  const args = ['diff', '--name-only', worktreeBase, branchHead]
  if (paths?.length) args.push('--', ...paths)

  return git(args)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
}

/**
 * The refusal text.
 *
 * Written to be actionable at 3am: what is about to be lost, why the tool can
 * see it and the author cannot, and the exact two commands that fix it. A gate
 * that only says "refused" gets worked around.
 *
 * @param {string[]} displaced
 * @param {{ base?: string, branch?: string, worktreeBase?: string | null, branchHead?: string | null }} [context]
 * @returns {string}
 */
export function displacementMessage(
  displaced,
  { base = 'main', worktreeBase, branchHead } = {},
) {
  const n = displaced.length
  const short = (sha) => (sha ? String(sha).slice(0, 7) : '?')

  return [
    `refusing to publish: this worktree is behind ${base}, and publishing would revert ${n} file${n === 1 ? '' : 's'}.`,
    '',
    `  worktree base : ${short(worktreeBase)}`,
    `  branch head   : ${short(branchHead)}`,
    '',
    'These paths changed on the branch after your worktree was created, and',
    "Publish lands the worktree's copy of each path — so your older base would",
    'overwrite them, with no conflict and green CI:',
    '',
    ...displaced.map((p) => `  ${p}`),
    '',
    'Bring the worktree up to date without discarding your edits, then publish',
    'again. Park the edits in a local commit, rebase it onto the branch, and',
    'unpack it (none of these touch GitHub, and none of them destroy work):',
    '',
    '  git add -A && git commit -qm wip',
    `  git fetch origin ${base}`,
    `  git rebase origin/${base}        # resolve if it stops, then --continue`,
    `  git reset --soft origin/${base}  # back to uncommitted edits on the current base`,
    '',
    'If you genuinely mean to revert these files, pass --allow-displacement.',
  ].join('\n')
}
