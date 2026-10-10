# Releasing

Every push to `main` (a merged PR) runs `.github/workflows/release.yml`. If the commits since the last `v*` tag include a releasable change, it:

1. runs the tests;
2. publishes `@oakgreencc/agit` to npm, through **trusted publishing** (OIDC, no stored token) with a provenance attestation;
3. pushes the `vX.Y.Z` tag and creates the GitHub release with generated notes.

Nothing is committed back to `main`. The `main` ruleset requires PRs and signed commits, so the version lives in the tag and in the published `package.json`. The `version` in the repo's `package.json` stays at the last hand-set value. The `minVersion` gate only ever reads an installed copy's version, so that is fine.

## What gets released

[semantic-release](https://semantic-release.gitbook.io/) reads [Conventional Commits](https://www.conventionalcommits.org/) (angular preset):

| Commit | Release |
|---|---|
| `fix: …`, `perf: …` | patch |
| `feat: …` | minor |
| `BREAKING CHANGE:` in the body | major |
| `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, merge commits | none |

It reads the commits that land on `main`. With a merge commit, those are the branch's own commits, as `agit publish` wrote them. With a **squash** merge, the only commit is the PR title, so give the PR a conventional title or nothing is released.

Versions below 1.0.0 follow the same table, so a `BREAKING CHANGE` releases 1.0.0.

## Configuration

| File | Holds |
|---|---|
| `.releaserc.json` | branch (`main`), tag format `v${version}`, plugins; no success comments or labels on PRs |
| `.github/workflows/release.yml` | test, then release; `id-token: write` for npm, `contents: write` for the tag and release, `issues: write` to open an issue if a release fails |
| `.github/workflows/ci.yml` | tests on every PR, Node 22 and 24 |

The release job runs in the `npm` environment, and npm's trusted publisher for the package is bound to this repository, `release.yml`, and that environment. A workflow anywhere else cannot publish it.

## One-time setup

Trusted publishing can only be configured for a package that already exists, so the very first version (`0.1.0`, tag `v0.1.0`) is published by hand. After that:

```sh
npm trust github @oakgreencc/agit --repo oakgreencc/agit --file release.yml --env npm --allow-publish
```

(npm ≥ 11.15, 2FA on the account.)

## When a release fails

semantic-release opens an issue titled "release failed on main" with the error. Fix the cause, then re-run the workflow (Actions → release → Run workflow). A run with nothing releasable is a no-op.
