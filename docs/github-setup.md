# GitHub setup — what a human configures, and why

agit's local layer (hooks, gates, maintainer mode) is a set of tripwires. An
agent with a shell can step over any of them. What it can't step over is
GitHub: an App permission it doesn't hold, or a ruleset it can't edit. This
page covers those. `agit setup` does both for you: the App, and the base
branch's ruleset — which it writes as *you*, through `gh`, because the App
deliberately can't touch rulesets. `agit doctor` checks all of it.

## 1. The App

`agit setup app` creates it through GitHub's manifest flow. You review the
pre-filled form and click Create. Then you install the App.

| Permission | Level | Why |
|---|---|---|
| Contents | write | the Git Database API: blobs, trees, commits, refs |
| Pull requests | write | open, update and merge PRs |
| Issues | write | comments, labels, closing references |
| Metadata | read | mandatory. It also lets `doctor` read branch rules |
| Actions | read | `agit jobs`: run and job logs |
| Checks, Statuses | read | the required check, for the stop-the-line rule |
| Organization projects | write | only with `--projects` on an org (Projects v2 is GraphQL-only) |

The App deliberately doesn't get these:

- **Workflows.** Without it, GitHub rejects any App write that touches
  `.github/workflows/**`. CI judges the agent's work, and an agent that could
  edit CI could make itself green. Workflow changes are described by the agent
  and applied by a human.
- **Administration.** Rulesets, branch protection, required checks and
  code-owner enforcement all sit behind it. The App mustn't be able to loosen
  the rules it's held to.
- **Secrets.** Nothing an agent does needs them.

No webhooks. The App is private.

**Install scope.** Install it only on the repositories agents should work in
("Only select repositories"). An installation token covers the whole
installation, so the installation is the blast radius.

Commits the App creates through the API are signed by GitHub and show as
**Verified** as `<app>[bot]`. No key material touches git, and nothing is
attributed to you.

## 2. The base-branch ruleset

`agit setup project` handles this. It reads the rules in force on the base
(`baseBranch` in `.agit.json`) as the App, and if any of the ones below are
missing, it creates a ruleset named `agit: <base>` — or adds the missing rules
to the one that exists — through `gh api`, as you. It only ever adds: other
rulesets, and the rest of `agit: <base>`, are left as you set them.
Repository admins may bypass it, through pull requests only (so a solo
maintainer can merge their own PR); the App never can.

Without `gh` logged in as a repository admin, setup writes the ruleset to
`~/.config/agit/rulesets/<owner>-<repo>-<base>.json` instead: import it at
Settings → Rules → New ruleset → **Import a ruleset**
(`https://github.com/<owner>/<repo>/settings/rules`).

What it contains, and why:

- **Require a pull request before merging.**
- **Require review from Code Owners.** This is what makes CODEOWNERS binding.
  Without it, CODEOWNERS is documentation. agit reads CODEOWNERS as its
  manifest of protected paths and refuses to edit or publish them without your
  grant. This rule is what stops a PR that touches them from merging without
  you, whatever happened locally.
- **Require status checks to pass** — once there is CI:
  `agit setup project --required-check <job>`. If agents merge their own PRs,
  CI is the acceptance gate, and `requiredCheck` in `.agit.json` lets
  `agit pr merge` stop the line when the base is red.
- **Require signed commits.** agit's commits are Verified. This keeps out
  anything pushed with the local git binary, which is unsigned and attributed
  to whoever `user.name` says.
- **Block force pushes and deletion.**

Don't add the App to the bypass list.

## 3. Optional: a branch-name ruleset for the App

To confine the App to its own namespace, add a second ruleset. Target all
branches except `agent/**` and restrict creations and updates. With this in
place, a mangled command can't create a branch named `--api` or write to `main`
directly.

## 4. Optional: auto-merge

To let agents use `agit pr merge --auto`, turn on Settings → General → **Allow
auto-merge**. The merge still waits for the ruleset's required checks and
reviews.

## 5. Check

```
agit doctor
```

`✗` lines are broken. `!` lines work, but give you less protection than it
looks like.
