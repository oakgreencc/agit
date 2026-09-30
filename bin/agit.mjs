#!/usr/bin/env node
// @ts-check
/**
 * agit — an agent's way to work a GitHub project, as a GitHub App.
 *
 * The local git binary stays READ-ONLY toward GitHub: it fetches (over HTTPS,
 * authenticated as the App through `agit credential`), diffs, merges and runs
 * hooks. Every write — commit, merge, branch, PR, comment — goes through the
 * verbs here, which have GitHub CREATE the commit through the API, so it lands
 * Verified as the App instead of unsigned and authored as whichever human
 * `user.name` resolved to.
 *
 * Around that write path sit the gates: scope and payload (what a publish may
 * carry), protection (CODEOWNERS as the manifest of what needs a human),
 * displacement (a stale worktree silently reverting work), validated base (a
 * green run about a different base), and the repository's own git hooks, run
 * at the moments git would have run them. A human lifts a gate with a scoped,
 * session-bound, expiring maintainer grant — never by taking agit out of the
 * loop.
 *
 * `agit help` for the verbs.
 */

import { PublishError } from '../src/errors.mjs'
import { VERSION } from '../src/gates/version.mjs'
import { explain } from '../src/cli/explain.mjs'
import { VERBS } from '../src/cli/verbs.mjs'

const HELP = `agit ${VERSION} — work a GitHub project as a GitHub App

Write path (every write is a Verified commit created by GitHub):
  agit publish <branch> <message> (--paths a,b | --all) [--pr <title>] [...]
  agit merge <branch>                 publish a local merge (git merge --no-commit → resolve → git add)
  agit advance <branch>               move HEAD onto the branch head, keeping work
  agit pr merge <n> [--auto]          merge a PR, if policy allows
  agit pr update <n>                  bring a PR up to date with its base
  agit issue <action> ...             create, comment, close, edit, assign, label (--body-file)

Read path:
  agit api <METHOD> <path> [--body <json>|--body-file <f>] [--paginate] [--raw] [--out <f>]
  agit graphql '<query>' [--vars <json>|--vars-file <f>]
  agit jobs <run-id | run URL> [--logs <dir>] [--all]
  agit ci wait <sha|ref> [--check c]  one check's verdict: exit 0 green, 1 red, 2 unknowable
  agit issue read <n>                 an issue as JSON (with the etag \`issue edit\` needs)
  agit credential get                 git credential helper (git runs this)

Gates and grants:
  agit validate [-- <command>]        run the project's validation, record the base it was green on
  agit protected [paths...] [--changed]   what CODEOWNERS protects, and why
  agit maintainer status|grant|revoke     scoped, session-bound human override

Setup:
  agit setup [app|project]            create the GitHub App, bootstrap a repository
  agit doctor                         check this machine and repository
  agit hook <name>                    Claude Code hook entry points (settings.json runs these)

Common flags: -C <dir> (run as if in <dir>), --repo <owner/repo>.
Run \`agit <verb> --help\` for a verb's flags. Docs: skills/agit/SKILL.md.`


const [verb, ...argv] = process.argv.slice(2)

if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
  console.log(HELP)
  process.exit(0)
}
if (verb === 'version' || verb === '--version' || verb === '-v') {
  console.log(VERSION)
  process.exit(0)
}
if (!(verb in VERBS)) {
  console.error(`agit: unknown verb "${verb}"\n\n${HELP}`)
  process.exit(1)
}

try {
  const run = await VERBS[/** @type {keyof typeof VERBS} */ (verb)]()
  const code = await run(argv)
  if (typeof code === 'number') process.exitCode = code
} catch (err) {
  if (err instanceof PublishError) {
    console.error(err.message)
    process.exit(1)
  }
  console.error(`agit ${verb}: ${/** @type {Error} */ (err)?.message ?? err}`)
  const hint = explain(err)
  if (hint) console.error(`\n${hint}`)
  process.exit(1)
}
