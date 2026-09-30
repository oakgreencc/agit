---
name: agit
description: Write to GitHub through agit, a GitHub App, instead of git push or gh. Use when committing, pushing, opening or merging a PR, reading, filing, commenting on or closing an issue, waiting for or reading CI, or when agit refuses a publish; and when setting up agit (App, credentials, repo bootstrap).
allowed-tools: Bash(agit *), Bash(echo *)
---

# agit

Local git is **read-only** toward GitHub: fetch, diff, merge, stash, run tests. Every **write** — commit, branch, PR, merge, comment — goes through `agit`, which has GitHub create the commit through the API so it lands **Verified** as the App. `git push`, `gh`, and personal tokens are refused by hooks; reach for the matching verb below instead.

Installed: !`agit --version 2>/dev/null || echo "NO — agit is not on PATH"`

If that line shows anything but a version number, check with `agit --version`; if that fails too, agit is not installed and nothing below works yet: the hooks and the credential helper call `agit` by name. Ask the human to install it and run setup — see [Setup](#setup).

Every verb takes `-C <dir>` and `--repo <owner/repo>` (default: the `origin` remote). `agit <verb> --help` is the source of truth for flags.

## Publishing work

1. **Branch.** Pick a fresh branch name (`agent/<topic>`). The base comes from `.agit.json` `baseBranch`, else the repo's default branch; `--base <b>` stacks on another branch.
2. **Validate.** `agit validate` runs the project's check and records the base it was green on. Done when it exits 0.
3. **Publish.** Uncommitted changes in the worktree → one Verified commit:
   ```
   agit publish agent/<topic> "<message>" --paths a,b --pr "<title>" --pr-body-file <f> --closes 12
   ```
   Name every path with `--paths`; `--all` means every dirty path, untracked included, on purpose. The repo's git hooks (pre-commit, commit-msg, pre-push) run before anything is sent. Done when the output shows `commit: … [Verified]` and, with `--pr`, a `pr:` URL.
4. **Follow up.** Later commits to the same branch: same `publish` command without `--pr`. The worktree advances onto each published commit automatically.

## Other writes

| Need | Verb |
|---|---|
| Branch moved under you / follow someone's branch | `agit advance <branch>` — never `reset --hard` |
| Merge conflict | `git fetch origin <base>`, `git merge --no-commit origin/<base>`, resolve, `git add`, then `agit merge <branch>` (no local commit) |
| Merge a PR | `agit pr merge <n>` (`--auto` to queue) |
| Update a PR from its base | `agit pr update <n>` |
| Read an issue | `agit issue read <n>` — JSON, with the `etag` an edit needs |
| Open an issue | `agit issue create --title "<t>" --body-file <f> [--labels a,b]` |
| Comment on an issue or PR | `agit issue comment <n> --body-file <f>` |
| Close an issue | `agit issue close <n> --body-file <f> [--reason completed\|not_planned\|duplicate]` — comments, then closes |
| Edit an issue body | `agit issue read <n>`, edit, `agit issue edit <n> --body-file <f> --etag <etag>` — refused if it changed since the read |
| Assign / label | `agit issue assign <n> --login <l>`; `agit issue label <n> --add a,b --remove c` (added labels must exist) |
| Wait for CI | `agit ci wait <sha\|branch> [--check <name>]` — exit 0 green, 1 red, 2 unknowable (never treat 2 as green) |
| Any read | `agit api GET <path>` — add `--paginate` on every list |
| Why CI failed | `agit jobs <run URL> --logs <dir>`, then read the failed job's log |
| Projects v2 | `agit graphql '<query>'` |
| Anything else (reviews, …) | `agit api <METHOD> <path> --body-file <f>` |

Bodies always come from a file (`--body-file -` reads stdin); an inline `--body` on `agit issue` is refused, because the shell eats backticks. Write the body with your file tool, or `echo … | agit issue comment <n> --body-file -`.

## Refusals

agit refuses before writing anything, and each refusal ends with the exact next command. Run that command. Overrides (`--allow-displacement`, `--stale-base-ok`, `--allow-large <paths>`) exist for the case the message describes; pass one only when that case is true, and say so in your report.

**Protected paths** — anything CODEOWNERS assigns an owner, plus `.agit.json`, CODEOWNERS itself, and `.claude/settings.json`. Editing or publishing one needs a human's **grant**. Stop, tell the human what you need and why, and relay the command from the refusal:

```
! agit maintainer grant "<why this session needs it>" --scope protected
```

The human runs it; a grant you run yourself is refused. Scopes: `protected` (edit/publish protected paths), `no-verify` (skip git hooks), `merge` (self-merge past local merge policy). `agit maintainer status` shows what this session holds. `.github/workflows/**` has no grant: the App cannot write it — describe the patch for the human.

For what a specific refusal means, read [references/refusals.md](references/refusals.md).

## Setup

When `agit` is missing, credentials are absent, or `agit doctor` reports ✗, read [references/setup.md](references/setup.md). Setup opens a browser and creates a GitHub App, so a human runs it.
