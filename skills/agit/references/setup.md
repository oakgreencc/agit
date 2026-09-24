# Setting up agit

Setup creates a GitHub App in a browser and stores its private key on this machine, so the **human** runs it. Give them these commands; in Claude Code the `!` prefix runs a command as them.

## 1. Install the CLI (once per machine)

```
npm install -g github:<owner>/agit      # or: git clone … && npm link
agit --version
```

`agit` must be on `PATH`: the Claude hooks and the git credential helper call it by name. Node ≥ 22, no other dependencies.

## 2. Create the App (once per GitHub owner)

```
! agit setup app                  # --org <org> for an organization; --manual to register an existing App
```

Opens GitHub's "create App from manifest" page with the permissions pre-filled (contents, pull requests, issues: write; actions, checks, statuses: read; no workflows, no administration). After creation it saves the key to `~/.config/agit/apps/<slug>/`, then opens the install page — install it on the repositories agents should work in.

## 3. Bootstrap the repository (once per repo)

```
! agit setup project
```

Writes `.agit.json` (base branch, validation command, hooks path, merge policy), seeds or extends CODEOWNERS so the policy files are owned, and merges into `.claude/settings.json`: the git env block (HTTPS rewrite + `agit credential` helper + local signing off), the agit hooks, and permissions. Review the diff it shows, then commit those files the normal human way.

## 4. Turn on the GitHub side

`agit setup project` prints the checklist and the rulesets URL. The load-bearing one: on the base branch, **require review from Code Owners** — that is what makes CODEOWNERS a boundary rather than a tripwire. Details and the rest: `docs/github-setup.md` in the agit repo.

## 5. Check

```
agit doctor
```

Every ✗ names its fix. `!` lines are warnings worth reading (e.g. a base branch without required signatures).
