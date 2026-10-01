// @ts-check
/**
 * Has a code owner approved this protected-path PR, in a way GitHub counts?
 *
 * `agit pr merge` (src/pr-policy.mjs) refuses an agent's merge of a PR that
 * touches a protected path, as the tripwire in front of CODEOWNERS. Once an
 * owner's approval is one GitHub counts, that merge would succeed on GitHub,
 * so the tripwire was refusing something the boundary allows — and the human
 * had to act twice on one decision: approve, then come back and click Merge.
 * This is the exception, and it is proven from GitHub's own records, never
 * asserted.
 *
 * Pure: the caller fetches CODEOWNERS (from the BASE branch, which only an owner
 * review can change — never the worktree copy the agent can edit), the head sha,
 * the reviews and the base branch's rules, and hands them here.
 *
 * It is deliberately no weaker than GitHub:
 *
 *   - the owners of a path are those on the LAST matching CODEOWNERS line, and a
 *     line with no owners un-owns it — GitHub's rule, via src/codeowners.mjs;
 *   - only an individual `@login` counts. A `@org/team` or an email owner cannot
 *     be verified here (team membership needs a permission the App lacks), so a
 *     path owned only that way is never cleared;
 *   - every path needs an approving owner of its own;
 *   - the approval must be on the current head sha — UNLESS the base branch's
 *     rules provably keep stale approvals (`stalePolicy` below). That is
 *     GitHub's policy, read live, not ours: with `dismiss_stale_reviews_on_push:
 *     false` GitHub counts an approval after a push, and a guard that refused it
 *     anyway re-imposes a setting the maintainer turned off. agit's own setup
 *     ruleset keeps stale approvals, so this is the common case. An unreadable
 *     or ambiguous ruleset keeps the same-head rule;
 *   - each reviewer's LATEST decisive review (APPROVED / CHANGES_REQUESTED /
 *     DISMISSED — not COMMENTED) is the one that counts, and any owner whose
 *     latest is CHANGES_REQUESTED blocks — on any commit, stale policy or not;
 *   - a bot — the App above all — is never an approver.
 *
 * Anything it cannot evaluate is a refusal: an unknown head, unreadable reviews.
 *
 * WHY THE RULESET, NOT GRAPHQL `reviewDecision`. With
 * `required_approving_review_count: 0` in a ruleset (not classic branch
 * protection), `reviewDecision` is `null` whether or not a code owner approved,
 * so it cannot tell an approved PR from an unreviewed one. The rules from
 * `GET /repos/{o}/{r}/rules/branches/{base}` are readable by the App and are
 * the thing GitHub enforces.
 */

import { decidingRule, parseCodeowners } from './codeowners.mjs'

/** Review states that change a reviewer's standing. COMMENTED and PENDING do not. */
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])

/** A `@login` owner as a lower-cased login; `null` for a team or an email. */
function userLogin(token) {
  return /^@[A-Za-z0-9-]+$/.test(token) ? token.slice(1).toLowerCase() : null
}

/**
 * @typedef {{ user?: { login?: string, type?: string } | null, state?: string,
 *   commit_id?: string, submitted_at?: string }} Review
 */

/**
 * Whether an approval on an earlier commit still counts, and the words that say
 * why. `keepsStale` is true only when it is proven.
 *
 * @typedef {{ keepsStale: boolean, basis: string }} StalePolicy
 */

/**
 * What is assumed when nothing was read: the strict, same-head rule.
 *
 * @param {string} [base]
 * @returns {StalePolicy}
 */
export const strict = (base = 'base') => ({
  keepsStale: false,
  basis: `the \`${base}\` ruleset could not be read to tell whether stale approvals count`,
})

/**
 * Do the base branch's rules keep an approval across a push?
 *
 * `rules` is `GET /repos/{o}/{r}/rules/branches/{base}` as returned — every
 * active rule from every ruleset that applies, one entry per rule, so there may
 * be several `pull_request` rules and GitHub enforces the strictest of them.
 * Stale approvals count only when EVERY `pull_request` rule says so, each with
 * the literal booleans:
 *
 *   - `dismiss_stale_reviews_on_push: false` — the push does not discard it;
 *   - `require_last_push_approval: false` — otherwise the latest push must
 *     itself be approved, which an approval on an earlier commit is not.
 *
 * No `pull_request` rule, a missing field or anything unreadable is the strict
 * rule: fail closed.
 *
 * @param {unknown} rules
 * @param {string} [base]
 * @returns {StalePolicy}
 */
export function stalePolicy(rules, base = 'base') {
  if (!Array.isArray(rules)) return strict(base)
  const prRules = rules.filter((r) => r?.type === 'pull_request')
  if (prRules.length === 0) {
    return {
      keepsStale: false,
      basis: `the \`${base}\` ruleset has no pull_request rule saying stale approvals count`,
    }
  }
  for (const r of prRules) {
    const p = r?.parameters ?? {}
    if (p.dismiss_stale_reviews_on_push !== false)
      return { keepsStale: false, basis: `the \`${base}\` ruleset dismisses stale approvals on push` }
    if (p.require_last_push_approval !== false)
      return { keepsStale: false, basis: `the \`${base}\` ruleset requires the last push itself to be approved` }
  }
  return {
    keepsStale: true,
    basis: `the \`${base}\` ruleset keeps stale approvals (\`dismiss_stale_reviews_on_push: false\`)`,
  }
}

/**
 * The individual owners GitHub would require for `path`: the `@login`s on the
 * deciding (last matching) CODEOWNERS line, lower-cased. `[]` when no line
 * matches, the line lists nobody, or it lists only teams and emails.
 *
 * @param {import('./codeowners.mjs').Rule[]} rules
 * @param {string} path
 */
export function individualOwners(rules, path) {
  const rule = decidingRule(rules, path)
  return (rule?.owners ?? []).map(userLogin).filter((l) => l !== null)
}

/**
 * `approvals` names, per approver, the commit they approved and whether that is
 * the head — so a caller can say which rule let the merge through. `stale` is
 * the policy's basis when any approval used is not on the head, else `null`.
 *
 * @param {{ paths: string[], codeowners: string, head: string, reviews: Review[], policy?: StalePolicy }} facts
 * @returns {{ ok: true, approvers: string[], approvals: Array<{ login: string, commit: string, onHead: boolean }>, stale: string | null }
 *   | { ok: false, why: string }}
 */
export function codeOwnerApproval({ paths, codeowners, head, reviews, policy = strict() }) {
  if (!head) return { ok: false, why: 'its head commit could not be read' }
  const short = head.slice(0, 7)
  if (!Array.isArray(reviews)) return { ok: false, why: 'its reviews could not be read' }

  // Each human reviewer's latest decisive review, in submission order.
  /** @type {Map<string, Review>} */
  const latest = new Map()
  const ordered = reviews
    .map((r, i) => ({ r, i }))
    .sort((a, b) => String(a.r.submitted_at ?? '').localeCompare(String(b.r.submitted_at ?? '')) || a.i - b.i)
  for (const { r } of ordered) {
    const login = r.user?.login
    if (!login || r.user?.type === 'Bot' || login.endsWith('[bot]')) continue
    if (!DECISIVE.has(String(r.state))) continue
    latest.set(login.toLowerCase(), r)
  }

  const rules = parseCodeowners(codeowners)
  /** @type {Set<string>} */
  const approvers = new Set()
  for (const path of paths) {
    const owners = individualOwners(rules, path)
    if (owners.length === 0)
      return { ok: false, why: `CODEOWNERS on the base branch names no individual owner for ${path}` }

    const blocker = owners.find((o) => latest.get(o)?.state === 'CHANGES_REQUESTED')
    if (blocker) return { ok: false, why: `code owner @${blocker} requested changes` }

    // An approval on the head always counts; one on an earlier commit only
    // when the ruleset keeps it. Prefer the head, so the note names the
    // strongest reason there is.
    const onHead = owners.find((o) => latest.get(o)?.state === 'APPROVED' && latest.get(o)?.commit_id === head)
    const stale = owners.find((o) => latest.get(o)?.state === 'APPROVED')
    if (onHead) approvers.add(onHead)
    else if (stale && policy.keepsStale) approvers.add(stale)
    else {
      return {
        ok: false,
        why: stale
          ? `@${stale}'s approval is on ${String(latest.get(stale)?.commit_id).slice(0, 7)}, not the current head ${short}, and ${policy.basis}`
          : `no approval from a code owner of ${path} (${owners.map((o) => `@${o}`).join(', ')})`,
      }
    }
  }
  const approvals = [...approvers].sort().map((login) => {
    const commit = String(latest.get(login)?.commit_id ?? '')
    return { login, commit, onHead: commit === head }
  })
  return {
    ok: true,
    approvers: approvals.map((a) => a.login),
    approvals,
    stale: approvals.every((a) => a.onHead) ? null : policy.basis,
  }
}
