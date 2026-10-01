// @ts-check
/**
 * Publish — the operations. Commit, merge and advance, as the seam the
 * `agit` CLI calls.
 *
 * Every function takes `git` and `client` as arguments rather than reaching
 * for a process or the network, so each one runs against a fake in
 * `publish.test.mjs`. `git(args, opts)` runs git in the worktree and returns
 * stdout (`opts.encoding: 'buffer'` for blob bytes, `opts.env` for a
 * temporary index); `client` is `createClient()` from `github.mjs`.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF A PUBLISH.
 *
 *   1. Resolve the branch head on GitHub: its commit sha and tree sha.
 *   2. Build the tree to publish, LOCALLY, with git — a temporary index for an
 *      ordinary publish, the completed merge commit's tree for a merge.
 *   3. Ship the difference: upload the blobs GitHub does not have, then
 *      `POST /git/trees` against a base tree: the head's tree for an ordinary
 *      publish, and for a merge the tree of whichever parent is nearer — see
 *      `nearerParent` (fewer differing paths, the head on a tie). The request
 *      carries one entry per differing path, and a large diff 502s the trees
 *      endpoint. GitHub answers with a tree sha, and because trees are
 *      content-addressed it must equal the local one whichever base was used.
 *      If it does not, something (a mode, a filter, a path) differs from what
 *      the agent validated, and the publish stops before any commit.
 *   4. `POST /git/commits` — message, tree, parents, nothing else. GitHub
 *      signs it; it lands Verified as the App.
 *   5. Move the ref, fast-forward only.
 *   6. Advance the worktree onto the published commit without destroying
 *      anything: never `reset --hard`, never `checkout --`.
 *
 * Step 3's equality check is what makes "the tool publishes whole file
 * contents" no longer a hazard: what lands is provably the tree the agent
 * built, and every path outside the published set is the branch's own.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PublishError } from '../errors.mjs'
import { retryServerErrors } from '../github/app.mjs'
import {
  batchByBytes,
  blobShas,
  changedPaths,
  commitBody,
  COMMIT_BODY_KEYS,
  INLINE_BUDGET_BYTES,
  INLINE_MAX_BYTES,
  inlineable,
  inScope,
  parseDiffTree,
  planTree,
} from './tree.mjs'

const isSha = (s) => /^[0-9a-f]{40}$/.test(s ?? '')

/**
 * The gap between two `POST /git/blobs`. GitHub allows ~80 content-creating
 * requests a minute; one a second stays under it with room for the tree,
 * commit and ref writes that follow.
 */
export const BLOB_PACE_MS = 1000

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const noop = () => {}

export { PublishError }

const lines = (s) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
const nulSplit = (s) => s.split('\0').filter(Boolean)

/**
 * The paths whose working-tree state differs from `HEAD`, untracked included,
 * narrowed to `paths` when given. The one question every gate and the tree
 * build ask of the worktree, so it is asked one way.
 *
 * @param {Function} git
 * @param {string[] | null} [paths]
 * @returns {string[]}
 */
export function dirtyPaths(git, paths = null) {
  return changedPaths(git(['status', '--porcelain', '-uall', '-z'])).filter(inScope(paths))
}

// ---------------------------------------------------------------------------
// Reading GitHub
// ---------------------------------------------------------------------------

/**
 * The head of a branch on GitHub as `{ sha, tree }`, or `null` when the
 * branch does not exist. Deliberately READ-ONLY: nothing is created until the
 * gates in the CLI have passed, so a refusal leaves no stray branch behind.
 */
export async function resolveBranch({ client, owner, repo, branch }) {
  const ref = await client.getOrNull(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  return ref ? commitOnGitHub({ client, owner, repo, sha: ref.object.sha }) : null
}

/** `{ sha, tree }` for a commit GitHub holds, or `null` when it does not. */
export async function commitOnGitHub({ client, owner, repo, sha }) {
  const c = await client.getOrNull(`/repos/${owner}/${repo}/git/commits/${sha}`)
  return c ? { sha: c.sha, tree: c.tree.sha } : null
}

// ---------------------------------------------------------------------------
// Building the tree locally
// ---------------------------------------------------------------------------

/**
 * The tree an ordinary publish lands: the branch head's tree with the
 * worktree's current content for every changed, in-scope path.
 *
 * Built with git in a throwaway index rather than by reading files: `git
 * update-index` applies the same modes, symlink handling and clean filters
 * `git add` would, and `--add --remove` turns a path that is gone from disk
 * into a deletion. `base` must exist locally (the caller fetches the branch
 * first). Returns the tree sha and the paths it changed relative to `HEAD`.
 *
 * `beforeWrite(env)` runs after the index is built and before its tree is
 * written, with `env.GIT_INDEX_FILE` naming that index — see git-hooks.mjs.
 *
 * @param {{ git: Function, base: string, paths?: string[]|null, indexFile?: string, beforeWrite?: (env: Record<string, string>) => void }} opts
 */
export function worktreeTree({ git, base, paths = null, indexFile, beforeWrite }) {
  const changed = dirtyPaths(git, paths)
  if (!changed.length) return { tree: null, changed }

  const dir = indexFile ? null : mkdtempSync(join(tmpdir(), 'publish-index-'))
  const env = { GIT_INDEX_FILE: indexFile ?? join(/** @type {string} */ (dir), 'index') }
  try {
    git(['read-tree', base], { env })
    git(['update-index', '--add', '--remove', '--', ...changed], { env })
    // The pre-commit hook's moment: the index holds exactly what is being
    // published, and whatever the hook stages into it is what ships.
    beforeWrite?.(env)
    return { tree: git(['write-tree'], { env }).trim(), changed }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The commit a merge in progress is merging in — `MERGE_HEAD`, which `git
 * merge --no-commit` (or a conflicted merge) leaves behind — or `null` when no
 * merge is in progress. Asked of git rather than stat'ed, so it is right in a
 * linked worktree, whose `MERGE_HEAD` is not under `.git/`.
 *
 * @param {Function} git
 * @returns {string | null}
 */
export function mergeHead(git) {
  try {
    return git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).trim() || null
  } catch {
    return null // exit 1: no merge in progress
  }
}

/** @param {Function} git @param {string} a @param {string} b */
const isAncestorOf = (git, a, b) => {
  try {
    git(['merge-base', '--is-ancestor', a, b])
    return true
  } catch {
    return false
  }
}

const staleMerge = (firstParent, branchHead) =>
  new PublishError(
    `refusing to merge: HEAD's first parent is ${firstParent.slice(0, 7)}, but the branch head on GitHub is ` +
      `${branchHead.slice(0, 7)}.\n\nThe merge was made on a worktree that is behind the branch. Bring it up ` +
      'to date and redo the merge:\n\n' +
      '  git merge --abort   # only if a merge is still in progress\n' +
      '  agit advance <branch>\n' +
      '  git merge --no-commit <what you merged>\n',
  )

/**
 * What a `merge` publishes: the worktree's local merge — in progress, or
 * committed.
 *
 * The contract is "finish the merge locally, short of the commit" — `git
 * fetch`, `git merge --no-commit`, resolve, `git add` — and then publish it as
 * the App. No local commit is needed: the commit GitHub creates is the only
 * one, and making a scratch one first only runs the signing path for an
 * object nobody reads. Three shapes are recognised:
 *
 *   - a merge in progress (`MERGE_HEAD` exists): parents `[HEAD, MERGE_HEAD]`,
 *     the tree of the real index (`git write-tree` — the resolved index IS the
 *     merge), and `MERGE_MSG` with its `# Conflicts:` comments stripped. An
 *     index that still has unmerged paths is refused, naming them — a stronger
 *     guard than a committed merge gets, where `git add .` over conflict
 *     markers passes unseen. `beforeWrite` (the pre-commit hook) runs on that
 *     real index before its tree is written, as `git commit` would run it;
 *     the result is marked `uncommitted` so the message hooks run too.
 *   - `HEAD` has two parents and the first is the branch head on GitHub: a
 *     committed merge. Its tree and message are published as a two-parent
 *     commit with the same parents, in the same order (`[head, merged-in]`,
 *     which is what `update-branch` produces, so history reads the same
 *     either way). The local commit is left behind for its Verified twin.
 *   - `HEAD` has one parent: git fast-forwarded. There is nothing to create;
 *     the ref moves to `HEAD` if GitHub already has it.
 *
 * A first parent that is NOT the branch head means the merge was made on a
 * stale worktree, and publishing it would drop whatever landed in between —
 * refused, with the fetch-and-redo instruction.
 */
export function localMerge({ git, branchHead, readFile = (p) => readFileSync(p, 'utf8'), beforeWrite }) {
  const merging = mergeHead(git)
  if (merging) {
    const head = git(['rev-parse', 'HEAD']).trim()
    if (head !== branchHead) throw staleMerge(head, branchHead)
    const unmerged = nulSplit(git(['diff', '--name-only', '--diff-filter=U', '-z']))
    if (unmerged.length) {
      throw new PublishError(
        `refusing to merge: ${unmerged.length} unmerged path${unmerged.length === 1 ? '' : 's'} in the index:\n\n` +
          `${unmerged.map((p) => `  ${p}`).join('\n')}\n\n` +
          'Resolve each one, `git add <file>`, and run the merge verb again. Nothing was published.',
      )
    }
    // The pre-commit hook's moment: the real index holds the resolved merge,
    // and whatever the hook stages into it is what ships.
    beforeWrite?.({})
    const msgPath = git(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_MSG']).trim()
    return {
      kind: 'merge',
      tree: git(['write-tree']).trim(),
      parents: [head, merging],
      // stripspace, not a regex: it honours core.commentChar.
      message: git(['stripspace', '--strip-comments'], { input: readFile(msgPath) }).replace(/\n+$/, ''),
      uncommitted: true,
    }
  }

  const [head, ...parents] = lines(git(['rev-list', '--parents', '-n', '1', 'HEAD']))[0].split(
    /\s+/,
  )
  if (parents.length === 1) return { kind: 'fast-forward', sha: head, parents }
  if (parents.length !== 2) {
    throw new PublishError(
      `refusing to merge: HEAD has ${parents.length} parents; Publish merges exactly two.`,
    )
  }
  if (parents[0] !== branchHead) throw staleMerge(parents[0], branchHead)
  return {
    kind: 'merge',
    sha: head,
    tree: git(['rev-parse', 'HEAD^{tree}']).trim(),
    parents,
    message: git(['log', '-1', '--format=%B', 'HEAD']).replace(/\n+$/, ''),
  }
}

// ---------------------------------------------------------------------------
// Writing GitHub
// ---------------------------------------------------------------------------

/**
 * Make `tree` exist on GitHub, given that `base.tree` already does.
 *
 * Ships only the difference: the blobs that changed and are not already in
 * `known` (the blob shas of every commit GitHub holds that the caller can name
 * — both parents of a merge, the base of a publish). Then creates the tree
 * against `base_tree` and checks GitHub's sha against the local one. Trees are
 * content-addressed, so a mismatch means the published tree is NOT the tree
 * the agent validated, and nothing further is created.
 *
 * How the blobs get there is the rate-limit question. A blob that
 * `inlineable()` accepts — UTF-8 text, which is nearly everything an agent
 * publishes — rides as `content` on its tree entry, so any number of them
 * cost one request; more than `inlineBudget` bytes of them are spread over
 * several tree requests, each built on the previous one's sha. Only what
 * cannot ride inline is posted to `/git/blobs`, one at a time, `pace` ms
 * apart, and a rate-limited refusal is waited out by the client. Every path
 * is still checked: each posted blob's sha, and the final tree's.
 *
 * Should GitHub ever store inline content differently from the local blob,
 * the final tree would not match. Rather than refusing outright — this is the
 * fleet's one write path, and a refusal here would block the fix from being
 * published — the inline paths are re-shipped as posted blobs and the tree
 * rebuilt from shas alone. A mismatch after THAT is the real refusal.
 *
 * `report` is called with one line per event a person waiting on a long
 * publish would want to see; the default says nothing.
 *
 * @param {object} input
 * @param {Function} input.git
 * @param {any} input.client
 * @param {string} input.owner
 * @param {string} input.repo
 * @param {{ sha: string, tree: string }} input.base
 * @param {string} input.tree
 * @param {Set<string>} [input.known]
 * @param {(line: string) => void} [input.report]
 * @param {(ms: number) => Promise<void>} [input.sleep]
 * @param {number} [input.pace]           ms between blob POSTs
 * @param {number} [input.inlineMax]      largest blob that rides inline
 * @param {number} [input.inlineBudget]   inline bytes per tree request
 * @returns {Promise<{ tree: string, entries: object[], uploaded: string[], inline: string[], posted: string[] }>}
 */
export async function publishTree({
  git,
  client,
  owner,
  repo,
  base,
  tree,
  known = new Set(),
  report = noop,
  sleep = defaultSleep,
  pace = BLOB_PACE_MS,
  inlineMax = INLINE_MAX_BYTES,
  inlineBudget = INLINE_BUDGET_BYTES,
}) {
  if (!isSha(base?.sha) || !isSha(base?.tree))
    throw new Error(`publish: base must be { sha, tree }, got ${JSON.stringify(base)}`)
  if (!isSha(tree)) throw new Error(`publish: tree is not a sha: ${tree}`)
  if (tree === base.tree)
    throw new PublishError('nothing to publish: the tree is identical to the branch head.')

  const entries = parseDiffTree(git(['diff-tree', '-r', '--no-renames', '-z', base.sha, tree]))
  const plan = planTree(entries, { known })

  // Sort what has to be shipped into the two forms.
  /** @type {{ path: string, mode: string, sha: string, bytes: Buffer }[]} */
  const inline = []
  /** @type {{ path: string, mode: string, sha: string, bytes: Buffer }[]} */
  const posted = []
  for (const u of plan.uploads) {
    const bytes = Buffer.from(git(['cat-file', 'blob', u.sha], { encoding: 'buffer' }))
    ;(inlineable(bytes, u.mode, { max: inlineMax }) ? inline : posted).push({ ...u, bytes })
  }
  const batches = batchByBytes(inline, (i) => i.bytes.length, inlineBudget)
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`
  if (plan.uploads.length) {
    report(
      `shipping ${n(plan.uploads.length, 'blob')}: ${inline.length} inline in ${n(batches.length, 'tree request')}, ` +
        `${posted.length} posted one by one`,
    )
  }

  // Blob and tree writes are content-addressed — the answer is a sha fixed by
  // the body — so a 5xx is safe to repeat. Commit and ref writes are not (a
  // 5xx does not say whether GitHub made the commit or moved the ref, and a
  // repeat could make a second commit), so they are never wrapped.
  const blobsPath = `/repos/${owner}/${repo}/git/blobs`
  const postBlobs = async (blobs) => {
    for (const [i, { path, sha, bytes }] of blobs.entries()) {
      if (i > 0 && pace > 0) await sleep(pace)
      report(`blob ${i + 1}/${blobs.length} ${path}`)
      const made = await retryServerErrors(
        `POST ${blobsPath}`,
        () => client.json(blobsPath, 'POST', { content: bytes.toString('base64'), encoding: 'base64' }),
        { sleep, report },
      )
      if (made.sha !== sha) {
        throw new PublishError(
          `refusing to publish: ${path} uploaded as ${made.sha.slice(0, 7)} but is ${sha.slice(0, 7)} locally.`,
        )
      }
    }
  }
  const treesPath = `/repos/${owner}/${repo}/git/trees`
  const postTree = (baseTree, treeEntries) =>
    retryServerErrors(
      `POST ${treesPath}`,
      () => client.json(treesPath, 'POST', { base_tree: baseTree, tree: treeEntries }),
      { sleep, report },
    )
  const inlineEntry = ({ path, mode, bytes }) => ({
    path,
    mode,
    type: 'blob',
    content: bytes.toString('utf8'),
  })

  await postBlobs(posted)

  // Every batch but the last is a stepping stone: a tree carrying only its
  // own inline content, built on the one before. The last request adds the
  // sha entries (deletions, posted and already-known blobs) in diff order,
  // and is the one whose sha must equal the local tree.
  let baseTree = base.tree
  for (const [i, batch] of batches.slice(0, -1).entries()) {
    report(`tree request ${i + 1}/${batches.length}: ${n(batch.length, 'path')}`)
    baseTree = (await postTree(baseTree, batch.map(inlineEntry))).sha
  }
  const last = new Map((batches.at(-1) ?? []).map((i) => [i.path, i]))
  const earlier = new Set(
    batches
      .slice(0, -1)
      .flat()
      .map((i) => i.path),
  )
  let made = await postTree(
    baseTree,
    plan.tree
      .filter((e) => !earlier.has(e.path))
      .map((e) => (last.has(e.path) ? inlineEntry(/** @type {any} */ (last.get(e.path))) : e)),
  )

  let shippedInline = inline.map((i) => i.path)
  let shippedPosted = posted.map((i) => i.path)
  if (made.sha !== tree && inline.length) {
    report(
      `GitHub built tree ${made.sha.slice(0, 7)} from inline content, but the local tree is ${tree.slice(0, 7)}; ` +
        `re-shipping ${n(inline.length, 'path')} as posted blobs`,
    )
    await postBlobs(inline)
    made = await postTree(base.tree, plan.tree)
    shippedInline = []
    shippedPosted = plan.uploads.map((u) => u.path)
  }
  if (made.sha !== tree) {
    throw new PublishError(
      `refusing to publish: GitHub built tree ${made.sha.slice(0, 7)} from these changes, but the local tree is ` +
        `${tree.slice(0, 7)}.\n\nThe tree that would land is not the tree that was validated here. Nothing was committed.`,
    )
  }
  return {
    tree,
    entries,
    uploaded: plan.uploads.map((u) => u.path),
    inline: shippedInline,
    posted: shippedPosted,
  }
}

/**
 * `POST /git/commits` — and the guard on its body. The body is
 * `commitBody()`'s three keys and nothing else; an `author`, `committer` or
 * `signature` in `extra` is refused rather than forwarded, because that is
 * the exact input that makes GitHub skip signing (research §3).
 */
export async function createCommit({ client, owner, repo, message, tree, parents, ...extra }) {
  const forbidden = Object.keys(extra).filter((k) => !COMMIT_BODY_KEYS.includes(k))
  if (forbidden.length) {
    throw new Error(
      `publish: a commit body may carry only ${COMMIT_BODY_KEYS.join(', ')}; refusing ${forbidden.join(', ')}`,
    )
  }
  const body = commitBody({ message, tree, parents })
  const made = await client.json(`/repos/${owner}/${repo}/git/commits`, 'POST', body)
  return {
    sha: made.sha,
    url: made.html_url,
    verified: made.verification?.verified === true,
    reason: made.verification?.reason ?? null,
  }
}

/**
 * Point `refs/heads/<branch>` at `sha`. Creates the ref when `create` is set;
 * otherwise a fast-forward update, which GitHub refuses (422) if the branch
 * moved since the head was resolved. That refusal is the concurrency guard.
 */
export async function moveRef({ client, owner, repo, branch, sha, create = false }) {
  if (create) {
    await client.json(`/repos/${owner}/${repo}/git/refs`, 'POST', {
      ref: `refs/heads/${branch}`,
      sha,
    })
    return { created: true }
  }
  await client.json(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'PATCH', {
    sha,
    force: false,
  })
  return { created: false }
}

// ---------------------------------------------------------------------------
// Advancing the worktree
// ---------------------------------------------------------------------------

/**
 * Move the worktree's `HEAD` to `target` — the commit just published, or the
 * branch head someone else published — WITHOUT destroying work.
 *
 * `reset --hard` and `checkout --` are the two commands this replaces; both
 * discard uncommitted edits, and the first is what the classifier refuses.
 * The sequence here touches three disjoint sets of paths, each with the one
 * command that is safe for it:
 *
 *   - paths that changed between `HEAD` and `target` and are NOT modified
 *     locally: brought to `target` with `git restore --source`, index and
 *     worktree. There is no local work here to lose — this is what a
 *     fast-forward merge would do to them.
 *   - paths modified locally whose content already equals `target`'s — the
 *     paths just published: only the index needs to catch up, so
 *     `git update-index` records what is on disk. Deleted-and-published
 *     paths drop out of the index the same way.
 *   - paths modified locally whose content differs from `target`'s: a real
 *     collision, refused before anything moves. The fix is a local merge,
 *     which the `merge` verb then publishes.
 *
 * `HEAD` itself moves with `reset --soft`, which touches neither index nor
 * worktree. It is refused when `HEAD` holds local commits the branch does not
 * — moving past them would orphan them — which means: `HEAD` is not an
 * ancestor of `target`, is not the just-republished equivalent of `target`
 * (same tree, first parent on the branch), and is not on any remote ref.
 * That is reported, not forced.
 *
 * Returns what was done so the CLI can say it.
 *
 * @param {{ git: Function, target: string }} input
 * @returns {{ advanced: boolean, from: string, to: string, restored?: string[], recorded?: string[], reason?: string }}
 */
export function advance({ git, target }) {
  if (!isSha(target)) throw new Error(`publish: advance target is not a sha: ${target}`)
  const old = git(['rev-parse', 'HEAD']).trim()
  if (old === target) return { advanced: true, from: old, to: target, restored: [], recorded: [] }

  // A merge in progress. `reset --soft` refuses to run in the middle of one,
  // and once `target` contains `MERGE_HEAD` the merge has landed — the
  // `merge` verb just published it — so its state is cleared with `merge
  // --quit`, which leaves index and worktree alone (`reset --merge` would
  // touch the worktree, which this function never does). A merge the target
  // does NOT contain is someone's unfinished work: reported, not quit.
  const merging = mergeHead(git)
  if (merging && !isAncestorOf(git, merging, target)) {
    return {
      advanced: false,
      from: old,
      to: target,
      reason:
        `a merge in progress (of ${merging.slice(0, 7)}) is not on the branch; not clearing it. ` +
        'Publish it with the merge verb, or `git merge --abort` it first.',
    }
  }

  const isAncestor = (a, b) => isAncestorOf(git, a, b)
  // A local commit is safe to move past when the branch holds its equivalent:
  // same tree, and its first parent on the branch. That is exactly the local
  // merge commit the `merge` verb has just republished as the App — different
  // sha, identical content — and nothing is lost by leaving it behind.
  const equivalent = () => {
    const sameTree =
      git(['rev-parse', `${old}^{tree}`]).trim() === git(['rev-parse', `${target}^{tree}`]).trim()
    if (!sameTree) return false
    const [, firstParent] = lines(git(['rev-list', '--parents', '-n', '1', old]))[0].split(/\s+/)
    return Boolean(firstParent) && isAncestor(firstParent, target)
  }
  // …and a HEAD that any remote-tracking ref already contains is not local
  // work at all — the stacking case, where a worktree at the base's tip moves
  // onto an agent branch cut from an older base.
  const onOrigin = () =>
    lines(git(['for-each-ref', `--contains=${old}`, 'refs/remotes/'])).length > 0
  if (!isAncestor(old, target) && !equivalent() && !onOrigin()) {
    return {
      advanced: false,
      from: old,
      to: target,
      reason:
        `HEAD (${old.slice(0, 7)}) has commits that are not on the branch; not moving it past them. ` +
        'Merge the branch locally and publish that with the merge verb.',
    }
  }

  const dirty = new Set(dirtyPaths(git))
  const changed = nulSplit(git(['diff', '--name-only', '-z', old, target]))
  const untouched = changed.filter((p) => !dirty.has(p))
  const collide = changed.filter((p) => dirty.has(p))

  // A colliding path is fine when the worktree already holds target's content
  // — which is every path this publish just wrote. Anything else is a real
  // conflict between local edits and the branch.
  const targetBlob = new Map(
    (collide.length ? nulSplit(git(['ls-tree', '-r', '-z', target, '--', ...collide])) : [])
      .map((rec) => /^\d{6} blob ([0-9a-f]{40})\t(.*)$/s.exec(rec))
      .filter(Boolean)
      .map((m) => [m[2], m[1]]),
  )
  const conflicts = collide.filter((p) => {
    const want = targetBlob.get(p) ?? null // null: absent in target
    let have = null
    try {
      have = git(['hash-object', '--', p]).trim()
    } catch {
      have = null // absent on disk
    }
    return want !== have
  })
  if (conflicts.length) {
    throw new PublishError(
      `refusing to advance: ${conflicts.length} path${conflicts.length === 1 ? '' : 's'} changed on the branch AND ` +
        `in this worktree, with different content:\n\n${conflicts.map((p) => `  ${p}`).join('\n')}\n\n` +
        'Nothing was moved. Merge the branch into the worktree, resolve and `git add`, then publish the merge:\n\n' +
        `  git merge --no-commit ${target}\n  agit merge <branch>\n`,
    )
  }

  if (merging) git(['merge', '--quit'])
  git(['reset', '--soft', target])
  if (untouched.length)
    git(['restore', `--source=${target}`, '--staged', '--worktree', '--', ...untouched])
  if (collide.length) git(['update-index', '--add', '--remove', '--', ...collide])
  return { advanced: true, from: old, to: target, restored: untouched, recorded: collide }
}

// ---------------------------------------------------------------------------
// The two publishes, composed
// ---------------------------------------------------------------------------

/**
 * What a publish WOULD land, after the tree is built and before anything is
 * sent: the tree, the commit it builds on, and the paths it changes. For a
 * merge, `paths` is only the resolution — content that is neither parent's.
 *
 * @typedef {{ kind: 'worktree' | 'merge', base: Head, tree: string, parents: string[], paths: string[] }} Candidate
 */

/** The paths `tree` changes relative to `from`, as diff-tree reports them. */
function changedBetween(git, from, tree) {
  return parseDiffTree(git(['diff-tree', '-r', '--no-renames', '-z', from, tree]))
}

/**
 * Publish the worktree's uncommitted, in-scope changes as one commit on
 * `branch`, creating the branch from `base` when it does not exist.
 *
 * The caller has fetched the branch so `head.sha` exists locally. `gate`, when
 * given, judges the CANDIDATE — the tree as built, pre-commit hook included —
 * and throws to refuse; it runs before the message hooks and before anything
 * reaches GitHub. Returns the created commit and the paths it changed — or,
 * when the branch already holds this content, its head with `noop: true` and
 * nothing written.
 *
 * @typedef {{ sha: string, tree: string, branch?: string }} Head
 * @typedef {{
 *   preCommit?: (env: Record<string, string>) => void,
 *   commitMessage?: (message: string) => string,
 *   prePush?: (commit: PushedCommit) => void | Promise<void>,
 * }} PublishHooks
 * @typedef {{ sha: string } | { tree: string, parents: string[], message: string, sha?: string }} PushedCommit
 *   `sha`: a local commit that already IS what lands (a fast-forward, an
 *   unchanged merge); otherwise the hook is shown a twin made from the rest.
 *
 * @param {object} input
 * @param {Function} input.git
 * @param {any} input.client
 * @param {string} input.owner
 * @param {string} input.repo
 * @param {string} input.branch
 * @param {Head | null} input.head      the branch head, or `null` when the branch does not exist yet
 * @param {Head | null} input.base      the base head, needed only when `head` is null
 * @param {string} input.message
 * @param {string[] | null} [input.paths]
 * @param {string} [input.indexFile]
 * @param {(line: string) => void} [input.report]   progress, see `publishTree`
 * @param {(ms: number) => Promise<void>} [input.sleep]
 * @param {number} [input.pace]
 * @param {PublishHooks} [input.hooks]   the repository's git hooks, see git-hooks.mjs
 * @param {(candidate: Candidate) => void | Promise<void>} [input.gate]   see plan.mjs
 */
export async function publishWorktree({
  git,
  client,
  owner,
  repo,
  branch,
  head,
  base,
  message,
  paths,
  indexFile,
  report,
  sleep,
  pace,
  hooks,
  gate,
}) {
  const target = /** @type {Head} */ (head ?? base)
  const { tree } = worktreeTree({
    git,
    base: target.sha,
    paths,
    indexFile,
    beforeWrite: hooks?.preCommit,
  })
  // The branch already has exactly this content — nothing in scope is dirty,
  // or the dirty paths already equal the head's. That is the retry after a
  // lost response: the first run's commit landed and its reply did not, so
  // the worktree was never advanced. A fact, not a failure: answer with the
  // head, write nothing, and let the caller open the PR and advance. With no
  // branch yet there is no head to answer with, and an empty publish stays a
  // refusal.
  if (head && (!tree || tree === head.tree)) {
    return {
      commit: { sha: head.sha, url: null, verified: null },
      changed: [],
      shipped: null,
      created: false,
      noop: true,
      message,
    }
  }
  if (!tree) throw new PublishError('no changes in worktree')
  if (tree === target.tree)
    throw new PublishError('nothing to publish: the tree is identical to the branch head.')
  // The gates judge what would land — the tree as built, whatever the
  // pre-commit hook staged into it — not the list of paths that went in.
  if (gate) {
    const changed = changedBetween(git, target.sha, tree).map((e) => e.path)
    await gate({ kind: 'worktree', base: target, tree, parents: [target.sha], paths: changed })
  }
  // Everything local happens before anything is sent: the message hooks, then
  // pre-push against a local twin of the commit GitHub will create.
  const finalMessage = hooks?.commitMessage ? hooks.commitMessage(message) : message
  await hooks?.prePush?.({ tree, parents: [target.sha], message: finalMessage })
  const known = blobShas(git(['ls-tree', '-r', '-z', target.sha]))
  const shipped = await publishTree({
    git,
    client,
    owner,
    repo,
    base: target,
    tree,
    known,
    report,
    sleep,
    pace,
  })
  const commit = await createCommit({
    client,
    owner,
    repo,
    message: finalMessage,
    tree,
    parents: [target.sha],
  })
  await moveRef({ client, owner, repo, branch, sha: commit.sha, create: !head })
  return {
    commit,
    changed: shipped.entries.map((e) => e.path),
    shipped,
    created: !head,
    noop: false,
    message: finalMessage,
  }
}

/**
 * The parent to build a merge's tree on: whichever the resolved tree differs
 * from by fewer paths, the head winning a tie. The tree request carries one
 * entry per differing path, and building a stale branch's merge on its head
 * sends every path the merge brought in — enough, on a long-stale branch, for
 * GitHub to answer 502 every time. Only the base of the tree request changes;
 * the commit's parents, and the tree it must equal, do not.
 *
 * @param {{ git: Function, head: Head, mergedIn: Head, tree: string, report?: (line: string) => void }} input
 * @returns {Head}
 */
function nearerParent({ git, head, mergedIn, tree, report = noop }) {
  const fromHead = changedBetween(git, head.sha, tree).length
  const fromMergedIn = changedBetween(git, mergedIn.sha, tree).length
  if (fromMergedIn >= fromHead) return head
  const paths = (k) => `${k} path${k === 1 ? '' : 's'}`
  report(`building the merge tree on the merged-in parent (${paths(fromMergedIn)}, vs ${fromHead} from the head)`)
  return mergedIn
}

/**
 * Publish the worktree's local merge — in progress (`git merge --no-commit`)
 * or committed — onto `branch` as a two-parent commit created by GitHub —
 * Verified as the App, with the agent's resolved tree. See `localMerge`.
 *
 * The same moments as a publish, where they apply: `hooks.preCommit` runs on
 * the real index of a merge in progress, before its tree is written; `gate`
 * judges the candidate (its `paths` are the resolution — content that is
 * neither parent's; what came whole from a side was reviewed where it came
 * from); `hooks.commitMessage` runs on a `message` override, and on the
 * message of a merge in progress (a committed merge already ran it on its
 * own); `hooks.prePush` runs before anything is sent.
 *
 * @param {{ git: Function, client: any, owner: string, repo: string, branch: string, head: Head, message?: string | null, report?: (line: string) => void, sleep?: (ms: number) => Promise<void>, pace?: number, hooks?: PublishHooks, gate?: (candidate: Candidate) => void | Promise<void>, readFile?: (path: string) => string }} input
 * @returns {Promise<{ kind: 'fast-forward', commit: { sha: string, verified: null } } | { kind: 'merge', commit: any, shipped: any, parents: string[] }>}
 */
export async function publishMerge({
  git,
  client,
  owner,
  repo,
  branch,
  head,
  message,
  report,
  sleep,
  pace,
  hooks,
  gate,
  readFile,
}) {
  const local = localMerge({ git, branchHead: head.sha, readFile, beforeWrite: hooks?.preCommit })

  if (local.kind === 'fast-forward') {
    if (local.sha === head.sha)
      throw new PublishError('nothing to merge: the branch is already at HEAD.')
    const onGitHub = await commitOnGitHub({ client, owner, repo, sha: local.sha })
    if (!onGitHub) {
      throw new PublishError(
        `refusing to merge: HEAD (${local.sha.slice(0, 7)}) is a single-parent commit GitHub does not have. ` +
          'Publish merges a completed local merge, or fast-forwards to a commit already on GitHub.',
      )
    }
    await hooks?.prePush?.({ sha: local.sha })
    await moveRef({ client, owner, repo, branch, sha: local.sha })
    return { kind: 'fast-forward', commit: { sha: local.sha, verified: null } }
  }

  if (gate) {
    const fromTheirs = new Set(changedBetween(git, local.parents[1], local.tree).map((e) => e.path))
    const resolved = changedBetween(git, head.sha, local.tree)
      .map((e) => e.path)
      .filter((p) => fromTheirs.has(p))
    await gate({ kind: 'merge', base: head, tree: local.tree, parents: local.parents, paths: resolved })
  }
  // A committed merge already ran the message hooks on its own message; an
  // override, or the MERGE_MSG of a merge in progress, has not.
  const unhooked = message || (local.uncommitted ? local.message : null)
  const finalMessage = unhooked
    ? hooks?.commitMessage
      ? hooks.commitMessage(unhooked)
      : unhooked
    : local.message
  // The local merge commit IS the twin when its message stands; a merge in
  // progress has no local commit, so pre-push is shown a twin.
  await hooks?.prePush?.({
    tree: local.tree,
    parents: local.parents,
    message: finalMessage,
    ...(unhooked || !local.sha ? {} : { sha: local.sha }),
  })

  const mergedIn = await commitOnGitHub({ client, owner, repo, sha: local.parents[1] })
  if (!mergedIn) {
    throw new PublishError(
      `refusing to merge: the merged-in commit ${local.parents[1].slice(0, 7)} is not on GitHub. ` +
        'Merge a fetched ref (origin/<branch>), not a local-only commit.',
    )
  }
  // A merge whose resolved tree equals either parent's is legal — one side
  // brought nothing the other did not already have — and that tree already
  // exists on GitHub, so there is nothing to ship.
  const shipped =
    local.tree === head.tree || local.tree === mergedIn.tree
      ? { tree: local.tree, entries: [], uploaded: [], inline: [], posted: [] }
      : await publishTree({
          git,
          client,
          owner,
          repo,
          base: nearerParent({ git, head, mergedIn, tree: local.tree, report }),
          tree: local.tree,
          known: new Set([
            ...blobShas(git(['ls-tree', '-r', '-z', head.sha])),
            ...blobShas(git(['ls-tree', '-r', '-z', mergedIn.sha])),
          ]),
          report,
          sleep,
          pace,
        })
  const commit = await createCommit({
    client,
    owner,
    repo,
    message: finalMessage,
    tree: local.tree,
    parents: local.parents,
  })
  await moveRef({ client, owner, repo, branch, sha: commit.sha })
  return { kind: 'merge', commit, shipped, parents: local.parents }
}
