// @ts-check
/**
 * `publish`, `merge`, `advance` — the write path, and the gates in front of it.
 *
 * Gate order is cost order, and every gate runs before the first write, so a
 * refusal leaves nothing on GitHub:
 *
 *   1. scope          --paths or --all, named — before any credential is read
 *   2. no-verify      skipping the repo's hooks needs a `no-verify` grant
 *   3. protection     CODEOWNERS-protected paths need a `protected` grant;
 *                     impossible paths are refused outright
 *   4. validated base the green you are relying on is about THIS base
 *   5. displacement   a stale worktree would silently revert these paths
 *   6. payload        no *.log, no path growing by more than the ceiling
 *   7. git hooks      pre-commit → commit-msg → pre-push, on the exact tree
 *
 * Then: blobs → tree (sha checked against the local tree) → commit (no
 * author, committer or signature, so GitHub signs it) → fast-forward the ref
 * → open the PR → advance the worktree onto the commit.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { withClosingTrailers } from '../closing-refs.mjs'
import { flag, has, positionals } from '../context.mjs'
import { displacementMessage, findDisplacement } from '../gates/drift.mjs'
import {
  BOTH_SCOPES_MESSAGE,
  noPrNote,
  payloadMessage,
  payloadRefusalsInWorktree,
  sweepMessage,
} from '../gates/scope.mjs'
import { checkValidatedBase, readReceipt } from '../gates/validated-base.mjs'
import { hookRunner, previewCommit } from '../git-hooks.mjs'
import { allows, grantAdvice } from '../maintainer.mjs'
import { judge } from '../protected.mjs'
import {
  PublishError,
  advance,
  dirtyPaths,
  publishMerge,
  publishWorktree,
  resolveBranch,
} from '../publish/publish.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

export const PUBLISH_USAGE =
  'usage: agit publish <branch> <message> (--paths a,b | --all) [--base <b>] [--pr <title>] ' +
  '[--pr-body <text>|--pr-body-file <f>] [--draft] [--closes 82,196] [--no-advance] [--no-verify] ' +
  '[--allow-large a,b] [--allow-displacement] [--stale-base-ok] [-C <dir>] [--repo <owner/repo>]'

const PUBLISH_VALUE_FLAGS = [
  ...COMMON_VALUE_FLAGS,
  '--paths',
  '--base',
  '--pr',
  '--pr-body',
  '--pr-body-file',
  '--closes',
  '--allow-large',
]

/** @typedef {import('../context.mjs').Context} Context */

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/**
 * Scope gate. First of all, and the only one before a credential is read: a
 * publish naming neither --paths nor --all has not said what it carries, and
 * the sweep it would default to is how a 55k-line build log once became a
 * Verified commit. The refusal lists the sweep, so choosing takes one read.
 *
 * @returns {string[] | null} the --paths list, or null for --all
 */
function scopeGate({ git, argv }) {
  const pathsArg = flag(argv, '--paths')
  const all = has(argv, '--all')
  if (pathsArg && all) throw new PublishError(BOTH_SCOPES_MESSAGE)
  if (!pathsArg && !all) {
    let wouldSweep = []
    try {
      wouldSweep = dirtyPaths(git)
    } catch {
      // Not a worktree, or no git: the refusal stands either way.
    }
    throw new PublishError(sweepMessage(wouldSweep, { usage: PUBLISH_USAGE }))
  }
  return pathsArg ? pathsArg.split(',').filter(Boolean) : null
}

/** `--no-verify` is a human's call: it needs a grant with the `no-verify` scope. */
function noVerifyGate({ ctx, argv }) {
  if (!has(argv, '--no-verify')) return false
  const view = ctx.grant()
  if (!allows(view, 'no-verify')) {
    throw new PublishError(
      "refusing to publish: --no-verify skips this repository's git hooks, and that is a human's call.\n\n" +
        grantAdvice(view, 'no-verify'),
    )
  }
  console.log(`--no-verify: hooks skipped under maintainer grant ("${/** @type {any} */ (view).grant.reason}").`)
  return true
}

/**
 * Protection gate. The policy is read from the BASE as GitHub will enforce it
 * (the worktree's CODEOWNERS is exactly what an agent could have edited) and
 * from the worktree too; a path either one protects is protected.
 *
 * @param {{ ctx: Context, base: string, paths: string[] }} input
 */
function protectionGate({ ctx, base, paths }) {
  if (!paths.length) return
  const policies = [ctx.localPolicy()]
  try {
    ctx.git(['rev-parse', '--verify', '--quiet', `origin/${base}^{commit}`])
    policies.unshift(ctx.policyAt(`origin/${base}`))
  } catch {
    // Base not fetched: the worktree's policy is all there is to go on.
  }
  const view = ctx.grant()
  const { impossible, protected: all, lifted } = judge({ paths, policies, grant: view })
  if (impossible.length) {
    throw new PublishError(
      `refusing to publish: ${impossible.length} path${impossible.length === 1 ? '' : 's'} cannot be written by the App at all:\n\n` +
        impossible.map((h) => `  ${h.path} — ${h.why}`).join('\n') +
        '\n\nNo grant unlocks these: the App does not hold the permission. Describe the exact\n' +
        'change and hand it to a human to apply. Leave these paths out of --paths.',
    )
  }
  if (!all.length) return
  if (lifted) {
    console.log(
      `protected paths published under maintainer grant ("${/** @type {any} */ (view).grant.reason}"): ` +
        `${all.map((h) => h.path).join(', ')} — the PR still needs the code owners' review.`,
    )
    return
  }
  throw new PublishError(
    `refusing to publish: ${all.length} path${all.length === 1 ? ' is' : 's are'} protected — they decide what the gates\n` +
      'catch, what an agent may do, or what reaches production, so a human approves them:\n\n' +
      all.map((h) => `  ${h.path} — ${h.why}`).join('\n') +
      '\n\n' +
      grantAdvice(view, 'protected') +
      '\nOr leave them out of --paths and publish the rest.',
  )
}

/** Validated-base gate. See gates/validated-base.mjs. */
function validatedBaseGate({ ctx, base, argv }) {
  const receipt = readReceipt({ gitDir: ctx.gitDir() })
  if (has(argv, '--stale-base-ok')) {
    // Said out loud: an escape hatch nobody can see is a silent default.
    if (receipt) console.log('--stale-base-ok: publishing without checking the validated base.')
    return
  }
  let publishBaseSha = null
  try {
    publishBaseSha = ctx.git(['rev-parse', `origin/${base}`]).trim()
  } catch {
    publishBaseSha = null // unresolvable base: no opinion
  }
  const refusal = checkValidatedBase({ receipt, publishBaseSha, ref: `origin/${base}` })
  if (refusal) throw new PublishError(refusal)
}

/**
 * Displacement gate. See gates/drift.mjs. Fetches the target branch first so
 * its head exists locally, which the tree build needs anyway. Fails closed: an
 * unverifiable base is exactly the case that produced the incidents.
 */
function displacementGate({ ctx, base, branch, head, paths, argv }) {
  const { git } = ctx
  try {
    git(['fetch', 'origin', head.branch])
  } catch {
    // Reported below if the object is genuinely missing.
  }
  try {
    git(['cat-file', '-e', `${head.sha}^{commit}`])
  } catch {
    throw new PublishError(
      `refusing to publish: could not fetch ${head.sha.slice(0, 7)} (${head.branch}) to verify this worktree is up to date.\n` +
        'Check that `git fetch origin` works here (agit doctor), or pass --allow-displacement if you accept\n' +
        'the risk of reverting files.',
    )
  }
  if (has(argv, '--allow-displacement')) return
  let worktreeBase
  try {
    worktreeBase = git(['rev-parse', 'HEAD']).trim()
  } catch {
    return // a worktree with no commits has nothing to be stale against
  }
  const displaced = findDisplacement({ git, worktreeBase, branchHead: head.sha, paths })
  if (displaced.length)
    throw new PublishError(displacementMessage(displaced, { base, branch, worktreeBase, branchHead: head.sha }))
}

/** Payload gate. See gates/scope.mjs. */
function payloadGate({ ctx, head, paths, argv }) {
  const refused = payloadRefusalsInWorktree({
    git: ctx.git,
    worktree: /** @type {string} */ (ctx.root),
    head: head.sha,
    paths,
    allow: flag(argv, '--allow-large')?.split(',') ?? [],
    ceiling: ctx.config.payload.ceilingBytes,
    neverPublish: ctx.config.payload.neverPublish,
  })
  if (refused.length) throw new PublishError(payloadMessage(refused, { ceiling: ctx.config.payload.ceilingBytes }))
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** The branch head on GitHub, or where the branch would start. */
async function resolveTarget({ client, owner, repo, branch, base }) {
  const head = await resolveBranch({ client, owner, repo, branch })
  if (head) return { head: { ...head, branch }, baseHead: null }
  const baseHead = await resolveBranch({ client, owner, repo, branch: base })
  if (!baseHead) throw new PublishError(`base branch ${base} does not exist on GitHub`)
  return { head: null, baseHead: { ...baseHead, branch: base } }
}

/** Whether `branch` has an open PR. A failure to find out counts as no — the note is advice. */
async function hasOpenPr({ client, owner, repo, branch }) {
  try {
    const prs = await client.api(
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    )
    return Array.isArray(prs) && prs.length > 0
  } catch {
    return false
  }
}

function reportAdvance(out, branch) {
  if (!out.advanced) {
    console.log(`worktree NOT advanced: ${out.reason}`)
    return
  }
  const bits = []
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`
  if (out.restored.length) bits.push(`${n(out.restored.length, 'path')} brought up to the branch`)
  if (out.recorded.length) bits.push(`${n(out.recorded.length, 'published path')} recorded`)
  console.log(`worktree advanced to ${out.to.slice(0, 7)} (${branch})${bits.length ? `: ${bits.join(', ')}` : ''}`)
}

/** The Verified line — the whole point, so it is printed every time. */
function reportCommit(commit) {
  const state =
    commit.verified === true ? 'Verified' : commit.verified === false ? `NOT verified (${commit.reason})` : 'existing'
  console.log(`commit: ${commit.url ?? commit.sha}  [${state}]`)
}

/** The hook runner, wired to the publish primitive's three moments. */
function publishHooks({ ctx, skip, branch, remoteSha }) {
  const runner = hookRunner({
    git: ctx.git,
    root: /** @type {string} */ (ctx.root),
    config: ctx.config,
    skip,
    report: (line) => console.error(line),
  })
  return {
    runner,
    hooks: {
      preCommit: (env) => runner.preCommit(env),
      commitMessage: (message) => runner.commitMessage(message),
      prePush: ({ tree, parents, message }) =>
        runner.prePush({ branch, localSha: previewCommit({ git: ctx.git, tree, parents, message }), remoteSha }),
    },
  }
}

// ---------------------------------------------------------------------------
// `publish`
// ---------------------------------------------------------------------------

export async function runPublish(argv) {
  if (has(argv, '--help')) {
    console.log(PUBLISH_USAGE)
    return 0
  }
  const [branch, message] = positionals(argv, PUBLISH_VALUE_FLAGS)
  if (!branch || !message) throw new PublishError(PUBLISH_USAGE)
  if (branch.startsWith('-')) throw new PublishError(`refusing to publish: "${branch}" is not a branch name.\n\n${PUBLISH_USAGE}`)

  const ctx = contextFrom(argv)
  const { git } = ctx

  // Before anything else, and before any credential is read: what is this
  // publish carrying?
  const paths = scopeGate({ git, argv })
  const skipHooks = noVerifyGate({ ctx, argv })

  const prTitle = flag(argv, '--pr')
  const prBodyFile = flag(argv, '--pr-body-file')
  const prBody = prBodyFile ? readFileSync(resolve(prBodyFile), 'utf8') : flag(argv, '--pr-body')

  const client = await ctx.client()
  const { owner, repo, full } = ctx.repo()
  const base = flag(argv, '--base') ?? (await ctx.baseBranch())

  // A closing keyword in a PR body fires only when the PR merges into the
  // DEFAULT branch. When PRs land elsewhere (develop → main), only a keyword in
  // a COMMIT message ever closes anything — so lift the body's refs into it.
  const {
    message: commitMessage,
    added: closing,
    skipped: notClosing,
  } = withClosingTrailers({ message, prBody: prBody ?? undefined, closes: flag(argv, '--closes') ?? undefined })

  try {
    git(['fetch', 'origin', base])
  } catch {
    // The gates below fail closed on what they cannot see.
  }
  protectionGate({ ctx, base, paths: dirtyPaths(git, paths) })
  validatedBaseGate({ ctx, base, argv })

  // READ-ONLY until every gate has passed: a refusal leaves nothing on GitHub.
  const { head, baseHead } = await resolveTarget({ client, owner, repo, branch, base })
  const target = /** @type {any} */ (head ?? baseHead)
  displacementGate({ ctx, base, branch, head: target, paths, argv })
  payloadGate({ ctx, head: target, paths, argv })
  const noPr = !prTitle && !(head && (await hasOpenPr({ client, owner, repo, branch })))

  const { runner, hooks } = publishHooks({ ctx, skip: skipHooks, branch, remoteSha: head?.sha ?? null })
  const out = await publishWorktree({
    git,
    client,
    owner,
    repo,
    branch,
    head,
    base: baseHead,
    message: commitMessage,
    paths,
    report: (line) => console.error(line),
    hooks,
  })
  if (runner.ran.length) console.log(`hooks: ${runner.ran.join(', ')}`)
  if (out.created && baseHead) console.log(`created ${branch} from ${base} @ ${baseHead.sha.slice(0, 7)}`)
  console.log(`published ${out.changed.length} path${out.changed.length === 1 ? '' : 's'} to ${full}@${branch}`)
  reportCommit(out.commit)
  if (closing.length)
    // Say WHEN: "closes" reads as "closes now", and it does not — the keyword
    // fires when this commit reaches the repository's default branch.
    console.log(`closing when this commit reaches the default branch: ${closing.join(', ')}`)
  if (notClosing.length)
    console.log(`quoted, so NOT closing: ${notClosing.join(', ')} — use --closes if you meant it`)
  if (noPr) console.log(noPrNote({ branch, base }))

  if (prTitle) {
    // The body falls back to the commit message, not a bare "automated work"
    // line, which told a reviewer nothing.
    const pr = await client.json(`/repos/${owner}/${repo}/pulls`, 'POST', {
      title: prTitle,
      head: branch,
      base,
      body: prBody ?? message,
      draft: has(argv, '--draft'),
    })
    console.log('pr:', pr.html_url)
  }

  // The worktree follows the publish. The fetch runs over HTTPS as the App,
  // through the credential helper.
  if (!has(argv, '--no-advance')) {
    git(['fetch', 'origin', branch])
    reportAdvance(advance({ git, target: out.commit.sha }), branch)
  }
  return 0
}

// ---------------------------------------------------------------------------
// `merge`
// ---------------------------------------------------------------------------

const MERGE_USAGE =
  'usage: agit merge <branch> [--message <text>] [--base <b>] [--no-advance] [--no-verify] [--stale-base-ok] [-C <dir>] [--repo <owner/repo>]\n\n' +
  'Publishes the worktree\'s completed local merge (git fetch → git merge origin/<x> → resolve →\n' +
  'git commit) as a two-parent commit GitHub creates, Verified as the App.'

export async function runMerge(argv) {
  if (has(argv, '--help')) {
    console.log(MERGE_USAGE)
    return 0
  }
  const [branch] = positionals(argv, [...COMMON_VALUE_FLAGS, '--message', '--base'])
  if (!branch) throw new PublishError(MERGE_USAGE)
  const ctx = contextFrom(argv)
  const { git } = ctx
  const skipHooks = noVerifyGate({ ctx, argv })
  const client = await ctx.client()
  const { owner, repo, full } = ctx.repo()
  const base = flag(argv, '--base') ?? (await ctx.baseBranch())

  try {
    git(['fetch', 'origin', base])
  } catch {
    // see publish
  }
  // A merge of the base in is exactly when the receipt matters: a receipt
  // older than the merge means the merged tree was never validated here.
  validatedBaseGate({ ctx, base, argv })

  const head = await resolveBranch({ client, owner, repo, branch })
  if (!head) throw new PublishError(`branch ${branch} does not exist on GitHub; merge publishes onto an existing branch`)
  try {
    git(['fetch', 'origin', branch])
  } catch {
    // localMerge() reports a stale first parent with the fix.
  }

  // Protection: the paths whose merged content is NEITHER side's — the
  // agent's own resolution. Content taken whole from either parent was
  // reviewed where it came from.
  let parents = []
  try {
    parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).slice(1)
  } catch {
    parents = []
  }
  if (parents.length === 2) {
    const names = (a) =>
      new Set(
        git(['diff', '--name-only', '-z', a, 'HEAD'])
          .split('\0')
          .filter(Boolean),
      )
    const fromFirst = names(parents[0])
    const resolved = [...names(parents[1])].filter((p) => fromFirst.has(p))
    protectionGate({ ctx, base, paths: resolved })
  }

  const { runner } = publishHooks({ ctx, skip: skipHooks, branch, remoteSha: head.sha })
  // The local merge commit ran the commit hooks when it was made; pre-push is
  // the one left, on HEAD itself.
  runner.prePush({ branch, localSha: git(['rev-parse', 'HEAD']).trim(), remoteSha: head.sha })

  const out = await publishMerge({
    git,
    client,
    owner,
    repo,
    branch,
    head,
    message: flag(argv, '--message') ?? undefined,
    report: (line) => console.error(line),
  })
  if (out.kind === 'fast-forward') {
    console.log(`fast-forwarded ${full}@${branch} to ${out.commit.sha.slice(0, 7)}`)
  } else {
    const n = out.shipped.uploaded.length
    console.log(
      `merged ${out.parents[1].slice(0, 7)} into ${full}@${branch} (${n} resolved blob${n === 1 ? '' : 's'} shipped)`,
    )
    reportCommit(out.commit)
  }
  if (!has(argv, '--no-advance')) {
    git(['fetch', 'origin', branch])
    reportAdvance(advance({ git, target: out.commit.sha }), branch)
  }
  return 0
}

// ---------------------------------------------------------------------------
// `advance`
// ---------------------------------------------------------------------------

export async function runAdvance(argv) {
  const [branch] = positionals(argv, COMMON_VALUE_FLAGS)
  if (!branch || has(argv, '--help')) {
    console.log(
      'usage: agit advance <branch> [-C <dir>] [--repo <owner/repo>]\n\n' +
        "Moves the worktree's HEAD onto the branch head on GitHub without discarding uncommitted work —\n" +
        'the replacement for `git fetch && git reset --hard`.',
    )
    return branch ? 0 : 1
  }
  const ctx = contextFrom(argv)
  const { owner, repo } = ctx.repo()
  const head = await resolveBranch({ client: await ctx.client(), owner, repo, branch })
  if (!head) throw new PublishError(`branch ${branch} does not exist on GitHub`)
  ctx.git(['fetch', 'origin', branch])
  reportAdvance(advance({ git: ctx.git, target: head.sha }), branch)
  return 0
}
