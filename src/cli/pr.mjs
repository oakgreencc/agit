// @ts-check
/**
 * `agit pr` — the pull-request writes that carry policy.
 *
 *   agit pr merge <n> [--method merge|squash|rebase] [--auto] [--repo o/r]
 *   agit pr update <n> [--repo o/r]
 *
 * `merge` applies src/pr-policy.mjs before it asks GitHub to merge; the raw
 * API forms are refused by `agit hook guard-pr-writes` so this is the one way
 * in. `--auto` arms auto-merge instead — a deferred merge is still a merge,
 * and it is judged the same way, at arm time. (Its green therefore ages until
 * the merge lands; the base's own post-merge CI is the backstop.)
 *
 * `update` brings a PR up to date with its base (`update-branch`). It lands
 * nothing on the base, so it carries no policy — and it is the first step of
 * the red-base rescue, so it must stay reachable while the line is stopped.
 *
 * Opening a PR is `agit publish … --pr "<title>"`: a PR without a commit is
 * nothing.
 */

import { mergeableBases } from '../config.mjs'
import { flag, has, positionals } from '../context.mjs'
import { allows, grantAdvice } from '../maintainer.mjs'
import { baseHealth, mergeVerdict, rescueFacts } from '../pr-policy.mjs'
import { policyFrom, snapshot } from '../protected.mjs'
import { PublishError } from '../errors.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

const USAGE = `usage: agit pr merge <n> [--method merge|squash|rebase] [--auto] [--repo <owner/repo>]
       agit pr update <n> [--repo <owner/repo>]`

const METHODS = ['merge', 'squash', 'rebase']

/**
 * A file's text on `ref` through the contents API, or `null` when absent.
 *
 * @param {import('../github/app.mjs').Client} client
 */
async function fileAt(client, owner, repo, path, ref) {
  const f = await client.getOrNull(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`)
  return f && typeof f.content === 'string' ? Buffer.from(f.content, 'base64').toString('utf8') : null
}

/**
 * The protection policy as GitHub will enforce it: CODEOWNERS and `.agit.json`
 * read from the BASE branch, not the worktree (which is what an agent could
 * have edited) and not a local `origin/<base>` (which may be stale). Nothing
 * in it comes from the worktree — not even when the base has no `.agit.json`.
 */
export async function policyOnBase({ client, owner, repo, base }) {
  return policyFrom(await snapshot((p) => fileAt(client, owner, repo, p, base)))
}

/**
 * @param {string[]} argv
 * @param {{ client?: import('../github/app.mjs').Client }} [deps]
 */
export async function run(argv, { client: given } = {}) {
  const [sub, numberArg] = positionals(argv, [...COMMON_VALUE_FLAGS, '--method'])
  const number = Number(numberArg)
  if (!['merge', 'update'].includes(sub) || !Number.isInteger(number) || number <= 0) throw new PublishError(USAGE)
  const ctx = contextFrom(argv, { needRoot: false, client: given })
  const { owner, repo, full } = ctx.repo()
  const client = await ctx.client()
  const pr = await client.api(`/repos/${owner}/${repo}/pulls/${number}`)
  if (pr.state !== 'open') throw new PublishError(`${full}#${number} is ${pr.merged ? 'already merged' : pr.state}.`)

  if (sub === 'update') {
    await client.json(`/repos/${owner}/${repo}/pulls/${number}/update-branch`, 'PUT', {
      expected_head_sha: pr.head.sha,
    })
    console.log(`updating ${full}#${number} from ${pr.base.ref} (GitHub merges it asynchronously; CI re-runs on the new head)`)
    return
  }

  const method = flag(argv, '--method') ?? 'merge'
  if (!METHODS.includes(method)) throw new PublishError(`--method must be one of ${METHODS.join(', ')}`)

  const base = pr.base.ref
  const policy = await policyOnBase({ client, owner, repo, base })
  const baseConfig = policy.config
  const check = baseConfig.requiredCheck
  const get = (path) => client.api(path)
  const grant = ctx.grant()
  const granted = allows(grant, 'merge')

  const out = await mergeVerdict({
    pr: { number, base, headSha: pr.head.sha },
    // The base's own `baseBranch`, else GitHub's default — never the worktree's.
    allowedBases: mergeableBases(baseConfig, baseConfig.baseBranch ?? (await ctx.defaultBranch())),
    policy,
    policyProblem: policy.configProblem,
    requiredCheck: check,
    granted,
    lookups: {
      files: async () => (await client.paginate(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`)).map((f) => f.filename),
      baseRed: check ? () => baseHealth({ get, owner, repo, base, check }) : undefined,
      rescue: check ? () => rescueFacts({ get, owner, repo, base, headSha: pr.head.sha, check }) : undefined,
    },
  })

  if (!out.ok) {
    const liftable = out.refusals.every((r) => r.liftable)
    throw new PublishError(
      `refusing to merge ${full}#${number}:\n\n${out.refusals.map((r) => r.text).join('\n\n')}\n\n` +
        (liftable ? grantAdvice(grant, 'merge') : 'No grant lifts this; a human merges it.'),
    )
  }
  for (const r of out.lifted)
    console.log(`maintainer grant (merge) lifts: ${r.text.split('\n')[0]} — "${/** @type {any} */ (grant).grant.reason}"`)
  for (const n of out.notes) console.log(n)

  if (has(argv, '--auto')) {
    await client.graphql(
      'mutation($id:ID!,$m:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m}){clientMutationId}}',
      { id: pr.node_id, m: method.toUpperCase() },
    )
    console.log(`auto-merge armed on ${full}#${number} (${method}) — lands when its required checks pass`)
    return
  }
  // `sha` pins the head the policy judged: a push in between is refused (409).
  const merged = await client.json(`/repos/${owner}/${repo}/pulls/${number}/merge`, 'PUT', {
    merge_method: method,
    sha: pr.head.sha,
  })
  console.log(`merged ${full}#${number} into ${base}: ${merged.sha?.slice(0, 7) ?? '?'} (${method})`)
}
