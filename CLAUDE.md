# Working in this repo

Every change goes through a worktree, lands as commits made by agit, ships as a PR, and leaves nothing behind.

## 1. Work in a worktree

- Never edit files in the main checkout. Start every task with `EnterWorktree` (name it after the topic). It creates `.claude/worktrees/<name>/` (gitignored), and the `sync-worktree` hook fast-forwards it onto the base.
- Without that tool: `git worktree add --detach .claude/worktrees/<topic> origin/main`, then work only inside that path.
- Scratch files (PR bodies, helper scripts) go in the scratchpad or the worktree's git dir, never in tracked paths.

## 2. Commit with agit, from the worktree

- `agit validate`, then `agit publish agent/<topic> "<message>" --paths <a,b>`. One publish per logical commit; later publishes to the same branch advance the worktree automatically.
- Never `git commit`, `git push`, `git fetch` or `git pull`: raw network git reaches the owner's SSH key, and commits are signed by the owner's biometric key. Read remote state with `agit api GET …`.
- Commit messages must not name GitHub's merge mutations (the PR-write hook blocks the command). Paraphrase.

## 3. Open the PR from there

- Add `--pr "<title>" --pr-body-file <f>` to the first or last publish. The body ends with the Claude Code attribution line.
- Report the PR URL and the commit list.

## 4. Always clean up

Clean up before reporting done, and also when the task fails or is abandoned. The work lives on GitHub; nothing local needs keeping.

- `ExitWorktree` with `action: "remove"` (or `git worktree remove <path>` plus `git branch -D <branch>` for a manual one).
- Delete every scratch file you made.
- Done means `git worktree list` shows only the main checkout, and `git status` in the main checkout is clean.
- If something must stay (unpublished work, a refusal needing a human), say exactly what and where instead of leaving it silently.
