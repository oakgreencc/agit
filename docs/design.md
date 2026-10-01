# Design

## The boundary and the tripwires

Only one control here is a boundary: **GitHub**, configured so that CODEOWNERS review is required on the base branch and the App holds no Workflows or Administration permission. The agent cannot reach it.

Everything local — editor hooks, publish gates, maintainer grants — is a **tripwire** in front of that boundary. An agent with a shell can step over any of it. What the tripwires buy is *intent*: a protected file is never changed by accident, a gate is never skipped silently, and every deliberate exception is a grant a human made with a reason and an expiry, logged in `.git/agit/maintainer.log`. Discovery moves from review time to the first keystroke.

That is why CODEOWNERS is the manifest: the tripwire and the boundary read the same list, so they cannot drift.

## Where things live

| State | Location | Why |
|---|---|---|
| Project policy | `.agit.json` (tracked, protected) | reviewed like code |
| Protected paths | CODEOWNERS (tracked, protected) | GitHub enforces it too |
| App identity + key | `~/.config/agit/apps/<slug>/` (0600) | machine, never repo |
| Token cache | `~/.config/agit/cache/` (0600) | the credential helper runs on every fetch |
| Maintainer grants (`maintainer/<session>.json`) + log | `<git-common-dir>/agit/` | untracked, shared by worktrees of a clone |
| Validation receipt | `<git-dir>/agit/validated-base.json` | per worktree, untracked |

## Port map from SeKtor

| SeKtor | agit | Change |
|---|---|---|
| `packages/publish/bin/bot-commit.mjs` | `bin/agit.mjs`, `src/cli/*` | verbs split; repo/base from config and `origin` instead of positional + hard-coded map |
| `src/publish/{tree,publish,github}.mjs` | `src/publish/`, `src/github/app.mjs` | hook points in the publish; App chosen per owner; token cache |
| `publish-scope`, `publish-drift` | `src/gates/` | payload patterns and ceiling configurable |
| `publish-freshness` (vendored-copy check) | `src/gates/version.mjs` | agit is installed, not vendored: a `minVersion` floor replaces it |
| `packages/ci/src/validated-base.mjs` | `src/gates/validated-base.mjs` + `agit validate` | receipt moves into the git dir; any validation command |
| `packages/agent-env/src/control-paths.mjs` | `src/codeowners.mjs`, `src/protected.mjs` | the hand-kept list and its drift check are gone: CODEOWNERS *is* the list |
| `maintainer-mode.mjs` | `src/maintainer.mjs`, `agit maintainer` | scopes; one grant per session in `.git/agit/`; agent self-grant refused by the guard hook |
| `hooks/block-agent-credentials.mjs` | `src/hooks/guard-credentials.mjs` | generic owners and guidance |
| `hooks/guard-control-files.mjs` | `src/hooks/guard-protected.mjs` | repo located from the file path, so any worktree layout works |
| `hooks/guard-pr-writes.mjs` | `src/hooks/guard-pr-writes.mjs` + `agit pr merge` | policy moves into the verb; the hook only routes raw merges to it |
| `hooks/sync-worktree-base.mjs` | `src/hooks/sync-worktree.mjs` | base from config |
| `.githooks/*` never ran for publishes | `src/git-hooks.mjs` | agit runs them |
| `release.mjs`, `backport*.mjs` | — | CI-specific; not ported |

### Second sync (SeKtor `8266359e..e875e6a5`, 2026-09-30)

| SeKtor | agit | Change |
|---|---|---|
| `code-owner-approval.mjs` (#1801, stale rule) | `src/code-owner-approval.mjs`, `agit pr merge` | owners from agit's CODEOWNERS parser (wildcards work); stale basis names the configured base |
| `pull-request.mjs` raw-write guard (#1845) | `src/raw-merge.mjs`, `agit api`/`graphql` | refuses and points at `agit pr merge` instead of re-judging |
| `primitives/ci.mjs`, `develop.mjs` `RUN_FAILED` | `src/github/checks.mjs`, `agit ci wait`, `baseHealth` | only a real failure is red, on the base too |
| `primitives/issue.mjs` (#1842, #1844) | `src/github/issues.mjs`, `agit issue` | no Broker or label taxonomy; `resolve/patch/claim` are `close/edit/assign` |
| `primitives/verb-drift.mjs` (#1850) | `src/verb-drift.mjs`, `src/cli/verbs.mjs` | sweeps the skill, README and docs/ |
| Broker, Ledger, tracker-rules, `--unbrokered`, `develop`/`search`/`pr count` verbs, sync-central, Ready grants | — | SeKtor's tracker, daemon and fleet; not ported |

