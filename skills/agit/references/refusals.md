# agit refusals

Every refusal happens before anything reaches GitHub, so retrying after the fix is always safe. Find the refusal's first line below.

## `no --paths and no --all`
The publish did not say what it carries. The refusal lists every dirty path. Pass `--paths` with the ones you mean; `--all` only when every listed path belongs in the commit.

## `N paths are protected`
CODEOWNERS (or `.agit.json` `protected.extra`, or self-protection) says a human approves these. Either drop them from `--paths` and publish the rest, or ask the human for `--scope protected`. With a grant, the PR still needs the code owner's review on GitHub — say that in the PR body.

## `cannot be written by the App at all`
`protected.impossible` — by default `.github/workflows/**`. No grant exists. Leave the path out, and put the exact patch in your report for the human to apply.

## `this worktree is behind <base>, and publishing would revert N files`
Your worktree's base is older than the branch, and publishing whole files would silently undo the listed changes. Run the recipe in the message (park edits in a wip commit, rebase onto `origin/<base>`, `reset --soft`). `--allow-displacement` only when reverting those files is the intent.

## `validation ran against a different origin/<base>`
The base moved after `agit validate`. `agit advance <base-or-branch>`, then `agit validate` again. `--stale-base-ok` only when the intervening commits provably cannot touch this change; state why in the PR.

## `N paths are not something a publish carries`
A `*.log` (or another `payload.neverPublish` pattern), or a path growing by more than the ceiling in one publish. Logs and dumps stay out of git. If the path truly is source, `--allow-large <exact paths>`.

## `the <hook> hook exited N`
The repository's own git hook failed — the same hook `git commit`/`git push` would have run. Read its output above the refusal, fix the cause, publish again. Skipping hooks is `--no-verify` and needs a `no-verify` grant: a human's call.

## `the <hook> hook is required by .agit.json but is not an executable file`
A hook the project requires is missing (a bad `hooks.path`, a file without `+x`). Report it; do not work around it.

## `refusing to run: this project's .agit.json requires agit >= X`
Update agit on this machine (human task), then retry.

## `refusing to advance: N paths changed on the branch AND in this worktree`
Your uncommitted edits collide with new commits on the branch. `git merge <sha>` (the message names it), resolve, `git commit`, then `agit merge <branch>`.

## `refusing to merge: HEAD's first parent is X, but the branch head on GitHub is Y`
The merge was made on a stale worktree. `agit advance <branch>`, redo the merge, `agit merge <branch>`.

## `agit pr merge` refusals
- **base not in mergeableBases** — this project does not let agents merge into that branch; hand the PR to a human.
- **touches protected paths** — the human merges it (CODEOWNERS requires their review anyway).
- **base is red** — merging onto a known break buries it. If this PR is the fix: `agit pr update <n>`, let its required check finish green, then merge; a PR that contains the broken head and passes goes through.

A `merge` grant lifts all three locally; GitHub's rulesets still apply.

## GitHub errors
- **403 not accessible by integration** — the App lacks that permission on purpose (workflows, administration, secrets). Hand it to the human.
- **404** — wrong repo, or the App is not installed there. `agit doctor`.
- **422 on git/refs/heads** — the branch moved mid-publish; nothing changed. `agit advance <branch>` and retry.
