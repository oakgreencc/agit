# agit

Let a coding agent work a GitHub project **as a GitHub App**, with the local `git` binary kept read-only toward GitHub.

- **Verified commits, not pushes.** `agit publish` builds the tree locally with git, ships only the missing blobs, and has GitHub *create* the commit through the Git Database API. GitHub signs it: it lands **Verified** as the App — never unsigned, never authored as whichever human `user.name` resolved to. Merges too (`agit merge`).
- **Your git hooks still run.** A publish never runs `git commit` or `git push`, so agit runs `pre-commit`, `prepare-commit-msg`, `commit-msg` and `pre-push` itself, at the equivalent moments, on the exact tree that ships.
- **CODEOWNERS is the manifest.** Whatever CODEOWNERS assigns an owner is *protected*: the agent's editor hooks refuse the edit, `agit publish` refuses the path, and `agit pr merge` refuses the PR — all before the work, not at review. With "require Code Owner review" on the base branch, GitHub enforces the same list as a hard boundary.
- **Maintainer mode.** A human lifts part of the protective layer with a scoped (`protected`, `no-verify`, `merge`), session-bound, expiring grant — `! agit maintainer grant "why" --scope protected`. agit stays in the loop; only that gate moves, for that session.
- **Gates that come from incidents.** Scope (`--paths` or `--all`, never an implied sweep), payload (no `*.log`, no path growing by >512 KiB), displacement (a stale worktree silently reverting work), validated base (a green run about a different base), version floor.

Zero dependencies, Node ≥ 22.

## Quick start

```sh
npm install -g @oakgreencc/agit      # the CLI; must be on PATH
npx skills add oakgreencc/agit -g    # the agent skill (or: /plugin marketplace add oakgreencc/agit)
agit setup app                       # in a repo: creates the GitHub App for origin's owner, stores its key
cd your-repo && agit setup project   # .agit.json, CODEOWNERS, .claude/settings.json, base-branch ruleset
agit doctor
```

Then, as the agent:

```sh
agit validate
agit publish agent/fix-login "fix: login redirect" --paths src/auth --pr "Fix login redirect" --closes 42
```

Full walkthrough: [skills/agit/references/setup.md](skills/agit/references/setup.md). GitHub-side configuration: [docs/github-setup.md](docs/github-setup.md).

## Pieces

| | |
|---|---|
| `bin/agit.mjs` | the CLI; `agit help` |
| `skills/agit/` | the agent skill (also installable as a Claude Code plugin from this repo) |
| `src/publish/` | the primitive: tree build, blob shipping, signed commit, fast-forward ref, safe advance |
| `src/gates/` | scope, payload, displacement, validated base, version |
| `src/git-hooks.mjs` | runs the repository's git hooks during a publish |
| `src/codeowners.mjs`, `src/protected.mjs` | CODEOWNERS parsed with GitHub's semantics → the protection policy |
| `src/maintainer.mjs` | scoped, session-bound grants in `.git/agit/` |
| `src/hooks/` | Claude Code hooks: credential guard, protected-path guard, PR-write guard, worktree sync |
| `src/setup/` | `agit setup` (App manifest flow, project bootstrap) and `agit doctor` |

Design notes: [docs/design.md](docs/design.md). The one invariant everything rests on: [docs/verified-commits.md](docs/verified-commits.md).

## Configuration

`.agit.json` at the repo root (tracked, and itself protected). Every field optional:

```json
{
  "baseBranch": "develop",
  "mergeableBases": ["develop"],
  "requiredCheck": "ci",
  "validate": { "command": "npm run ci" },
  "hooks": { "path": ".githooks", "required": ["pre-push"] },
  "protected": { "owners": ["@you"], "extra": [], "impossible": [".github/workflows/**"] },
  "payload": { "ceilingBytes": 524288, "neverPublish": ["*.log"] },
  "minVersion": "0.1.0"
}
```

Defaults and the reasoning behind each: [src/config.mjs](src/config.mjs). Machine identity (which App acts for which owner) lives in `~/.config/agit/`, never in the repo.

## Tests

```sh
npm test
```

The publish primitive is tested against a fake GitHub backed by a bare repository, so the tree-sha equality check, merges, and the hook runner are exercised with real git.

## License

AGPL-3.0-only.
