// @ts-check
/**
 * PreToolUse/Bash hook — a PR is merged through `agit pr merge`, or not at all.
 *
 *   agit hook guard-pr-writes
 *
 * `agit pr merge <n>` is where the merge policy lives: the base must be one
 * the project lets agents merge into, the diff must touch nothing CODEOWNERS
 * protects, and the base must not be red (unless this PR is the fix). A merge
 * sent any other way — `agit api PUT …/pulls/<n>/merge`, `curl`, the GraphQL
 * `enablePullRequestAutoMerge` mutation — would walk straight past all of it.
 * So this hook refuses those forms and names the verb.
 *
 * WHY A HOOK AND NOT A PERMISSION RULE. `permissions.deny` matches a command
 * string, and a merge can be spelled many ways; this matches the ENDPOINT
 * wherever it appears — in a chained command, a quoted argument, a `sh -c`
 * payload — and needs no network, so it never fails for want of one.
 *
 * WHY THE POLICY IS NOT HERE. In the harness agit was ported from, this hook
 * resolved the PR's base itself, which made a hook spend API calls and made the
 * policy reachable only through Claude Code. As a verb it applies to any agent
 * runner, and a maintainer grant with the `merge` scope can lift it there, in
 * the open, with the reason printed.
 *
 * WHAT PASSES. `GET …/pulls/<n>/merge` ("is it merged?") is a read.
 * `PUT …/update-branch` lands nothing on the base, and bringing a stale PR up
 * to date is routine under a strict required-check policy. `agit pr …` itself.
 *
 * Deliberately blunt about quoting: a merge endpoint named in a quoted argument
 * is still a merge. The cost is a false positive on a command that merely
 * mentions one, which is a denial with a readable reason.
 */
import { readFileSync } from 'node:fs'

/** A merge expressed as a REST path. The number is loose so `$N` is caught too. */
const PR_MERGE = /\/repos\/([^/\s'"`]+)\/([^/\s'"`]+)\/pulls\/([^/\s'"`]+)\/merge\b/g

/** The GraphQL mutation that arms a merge for later. */
const AUTO_MERGE = /enablePullRequestAutoMerge/

/**
 * The HTTP method a path match belongs to: the LAST method token in a short
 * window before it. `null` — cannot tell — is treated as a write.
 */
function methodFor(command, index) {
  const before = command.slice(Math.max(0, index - 60), index)
  const found = before.match(/\b(GET|PUT|POST|PATCH|DELETE)\b/g)
  return found ? found[found.length - 1] : null
}

/**
 * Every merge write in a command that bypasses `agit pr`. Empty: no opinion.
 *
 * @param {string} command
 * @returns {{ kind: 'rest' | 'graphql', repo: string | null, number: string | null }[]}
 */
export function findTargets(command) {
  const targets = []
  for (const m of command.matchAll(PR_MERGE)) {
    if (methodFor(command, m.index) === 'GET') continue // reading merge state
    targets.push({ kind: 'rest', repo: `${m[1]}/${m[2]}`, number: m[3] })
  }
  if (AUTO_MERGE.test(command)) targets.push({ kind: 'graphql', repo: null, number: null })
  return /** @type {any} */ (targets)
}

/** The denial text for a set of targets. */
export function reasonFor(targets) {
  const t = targets[0]
  const n = t.number && /^\d+$/.test(t.number) ? t.number : '<n>'
  const how = t.kind === 'graphql' ? 'arms auto-merge through GraphQL' : `merges ${t.repo}#${t.number} through the REST API`
  return (
    `Blocked: this command ${how}, which skips the project's merge policy.\n\n` +
    'Merge through agit, which checks the base, the protected paths in the diff, and\n' +
    'whether the base is red — and says why when it refuses:\n\n' +
    `    agit pr merge ${n}             # [--method merge|squash|rebase]\n` +
    `    agit pr merge ${n} --auto      # arm auto-merge instead\n\n` +
    'If the policy refuses and a human agrees it should go in anyway, the override is a\n' +
    'maintainer grant with the `merge` scope — theirs to give, not a different spelling.'
  )
}

export async function main() {
  let command = ''
  try {
    command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? ''
  } catch {
    return // unparseable payload, nothing matched yet — fail open
  }
  let targets = []
  try {
    targets = findTargets(command)
  } catch {
    return // a parser bug must not wedge every Bash call
  }
  if (!targets.length) return
  // From here the command IS a merge write, so every path ends in a denial.
  let reason
  try {
    reason = reasonFor(targets)
  } catch (err) {
    reason = `Blocked: guard failed while checking this PR write: ${/** @type {Error} */ (err).message}`
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
}
