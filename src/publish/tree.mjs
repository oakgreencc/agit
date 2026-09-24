// @ts-check
/**
 * The pure half of Publish: turning git's own descriptions of a tree into the
 * request bodies the Git Database API wants, and pinning the one shape that
 * decides whether GitHub signs the result.
 *
 * Nothing in here touches git, the filesystem or the network. The functions
 * take strings git printed and return objects to POST, so every branch is
 * testable from a fixture — and the fixtures are the shapes recorded in
 * GitHub's Git Database API contract, as probed live (see docs/verified-commits.md).
 *
 * ---------------------------------------------------------------------------
 * WHY THE GIT DATABASE API, AND NOT `createCommitOnBranch`.
 *
 * The GraphQL mutation `createCommitOnBranch` takes file contents and
 * produces one single-parent commit. It cannot express a merge, so a
 * conflicted PR needs a handoff and, in the end, a human push. The Git Database
 * sequence — blobs → tree with `base_tree` → `POST /git/commits` → move the
 * ref — makes any commit shape: one parent for an ordinary publish, two for a
 * merge whose tree the agent resolved locally. One primitive covers both, and
 * it is not specific to one App: a release job can drive it with its own token.
 *
 * The concurrency guarantee is the same as before. `createCommitOnBranch`
 * refused when `expectedHeadOid` had moved; here the ref update is a
 * fast-forward (`force: false`), which GitHub refuses with 422 unless the new
 * commit's parent is the current head. A branch that moved under the publish
 * cannot be overwritten.
 */

/**
 * Paths whose working-tree state differs from `HEAD`, from
 * `git status --porcelain -uall -z`.
 *
 * NUL-separated so paths with spaces and newlines survive. Renames are the
 * sharp edge: `git status -z` emits them as TWO records — `R  <new>\0<old>\0`
 * — with the old path as a bare entry carrying no status code. Consuming that
 * entry as a normal record parsed `<old>` as a status code and silently
 * published a garbage path, so renames are handled explicitly: both paths are
 * returned, and the caller's `update-index --add --remove` sees the old one
 * missing from disk and drops it.
 *
 * @param {string} porcelainZ  raw stdout of `git status --porcelain -uall -z`
 * @returns {string[]} unique paths, in the order git listed them
 */
export function changedPaths(porcelainZ) {
  const records = porcelainZ.split('\0')
  const paths = []
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    const code = rec.slice(0, 2)
    const file = rec.slice(3)
    if (!file) continue
    paths.push(file)
    if (code.includes('R') || code.includes('C')) {
      const oldPath = records[++i] // the paired record, consumed here
      if (code.includes('R') && oldPath) paths.push(oldPath)
    }
  }
  return [...new Set(paths)]
}

/**
 * `--paths a,b` scoping: a path is in scope when it is one of the named paths
 * or lives under one of them as a directory.
 */
export function inScope(paths) {
  if (!paths?.length) return () => true
  return (f) => paths.some((p) => f === p || f.startsWith(p.replace(/\/?$/, '/')))
}

/**
 * One line of `git diff-tree -r --no-renames -z <base> <new>`:
 * `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0`.
 *
 * `--no-renames` on purpose: the API tree has no notion of a rename, only of
 * a path that is now absent and a path that is now present.
 *
 * @returns {{ path: string, srcMode: string, dstMode: string, srcSha: string, dstSha: string, status: string }[]}
 */
export function parseDiffTree(rawZ) {
  const fields = rawZ.split('\0')
  const entries = []
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i]
    if (!head?.startsWith(':')) continue
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])/.exec(head)
    if (!m) throw new Error(`publish: unparseable diff-tree record: ${JSON.stringify(head)}`)
    const path = fields[++i]
    if (path === undefined)
      throw new Error(`publish: diff-tree record without a path: ${JSON.stringify(head)}`)
    entries.push({ srcMode: m[1], dstMode: m[2], srcSha: m[3], dstSha: m[4], status: m[5], path })
  }
  return entries
}

const ZERO_MODE = '000000'
const SUBMODULE_MODE = '160000'

/**
 * Turn diff-tree entries into the `tree` array for `POST /git/trees` against
 * `base_tree`, and the list of blobs that have to exist on GitHub first.
 *
 * A deletion is an entry whose `sha` is `null` — that is how the endpoint
 * removes a path from `base_tree`. Everything else references a blob by sha;
 * a blob already on GitHub (present in either parent's tree, so in `known`)
 * needs no upload, because objects are content-addressed and the API accepts
 * any sha the repository holds.
 *
 * A submodule (`160000`) is refused rather than guessed at: the repo has none,
 * and publishing one by accident would point a gitlink at a commit nobody
 * reviewed.
 *
 * @param {ReturnType<typeof parseDiffTree>} entries
 * @param {{ known?: Set<string> }} [opts]
 * @returns {{ tree: object[], uploads: { path: string, mode: string, sha: string }[] }}
 */
export function planTree(entries, { known = new Set() } = {}) {
  const tree = []
  const uploads = []
  for (const e of entries) {
    if (e.dstMode === SUBMODULE_MODE || e.srcMode === SUBMODULE_MODE) {
      throw new Error(`publish: ${e.path} is a submodule; Publish does not write gitlinks`)
    }
    if (e.dstMode === ZERO_MODE) {
      tree.push({ path: e.path, mode: e.srcMode, type: 'blob', sha: null })
      continue
    }
    tree.push({ path: e.path, mode: e.dstMode, type: 'blob', sha: e.dstSha })
    if (!known.has(e.dstSha)) uploads.push({ path: e.path, mode: e.dstMode, sha: e.dstSha })
  }
  return { tree, uploads }
}

/**
 * How a blob that is not yet on GitHub gets there. Two forms exist:
 *
 *   - `POST /git/blobs`, one request per file, any bytes (base64).
 *   - `content` on a `POST /git/trees` entry: GitHub writes the blob itself.
 *     Any number of files ride in ONE request — but `content` is a JSON
 *     string, so only bytes that survive a UTF-8 round trip can take it.
 *
 * The first is what tripped the secondary rate limit (~80
 * content-creating requests a minute, 500 an hour, and a 610-file publish
 * once made 610 of them). So a blob rides inline whenever it can, and only what
 * cannot — binaries, symlinks, anything large — is posted on its own.
 *
 * Inline when: a regular or executable file (a symlink is posted as a blob:
 * the API documents its mode, not whether `content` may carry a link
 * target), no NUL byte (git's own binary heuristic, and a NUL escaped in
 * JSON is not worth trusting), the bytes decode to UTF-8 and encode back to
 * the same bytes, and the size is within `max`. The tree-sha check in
 * `publishTree` catches anything this lets through that GitHub then stores
 * differently.
 *
 * @param {Buffer} bytes
 * @param {string} mode
 * @param {{ max?: number }} [opts]
 */
export function inlineable(bytes, mode, { max = INLINE_MAX_BYTES } = {}) {
  if (mode !== '100644' && mode !== '100755') return false
  if (bytes.length > max) return false
  if (bytes.includes(0)) return false
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
}

/** The largest blob that rides inline; anything bigger is its own POST. */
export const INLINE_MAX_BYTES = 512 * 1024

/**
 * How much inline content one `POST /git/trees` carries. GitHub documents no
 * body limit for the endpoint, so this is deliberately conservative: a
 * publish larger than this makes several tree requests, each built on the
 * previous one's sha, and only the last one is checked against the local
 * tree — see `publishTree`.
 */
export const INLINE_BUDGET_BYTES = 2 * 1024 * 1024

/**
 * Split `items` into consecutive batches whose summed `size()` stays within
 * `budget`. An item larger than the budget on its own is a batch of one —
 * the caller has already decided it ships this way.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => number} size
 * @param {number} budget
 * @returns {T[][]}
 */
export function batchByBytes(items, size, budget) {
  /** @type {T[][]} */
  const batches = []
  /** @type {T[]} */
  let batch = []
  let used = 0
  for (const item of items) {
    const n = size(item)
    if (batch.length && used + n > budget) {
      batches.push(batch)
      batch = []
      used = 0
    }
    batch.push(item)
    used += n
  }
  if (batch.length) batches.push(batch)
  return batches
}

/**
 * The body of `POST /git/commits` — and the one invariant this whole design
 * rests on.
 *
 * GitHub signs a commit an App creates **only when the request carries no
 * `author`, `committer` or `signature` key.** Presence is what breaks it, not
 * value: supplying the bot's own identity verbatim, or `GitHub
 * <noreply@github.com>` as the committer, produces an unsigned commit that
 * renders identically to a signed one (research §3). So this function accepts
 * exactly three fields, and the test pins that the returned object has
 * exactly three keys. A caller that wants an author is a caller that wants an
 * unsigned commit, and there is no such caller.
 *
 * @param {{ message: string, tree: string, parents: string[] }} input
 */
export function commitBody({ message, tree, parents }) {
  if (typeof message !== 'string' || !message.trim())
    throw new Error('publish: a commit needs a message')
  if (!/^[0-9a-f]{40}$/.test(tree ?? '')) throw new Error(`publish: tree is not a sha: ${tree}`)
  if (
    !Array.isArray(parents) ||
    !parents.length ||
    !parents.every((p) => /^[0-9a-f]{40}$/.test(p))
  ) {
    throw new Error(`publish: parents must be one or more shas, got ${JSON.stringify(parents)}`)
  }
  return { message, tree, parents: [...parents] }
}

/** The keys a commit body may carry. Exported so the pin is one place. */
export const COMMIT_BODY_KEYS = Object.freeze(['message', 'tree', 'parents'])

/**
 * Blob shas from `git ls-tree -r -z <tree-ish>` — the set of objects GitHub
 * already holds when `<tree-ish>` is on GitHub.
 */
export function blobShas(lsTreeZ) {
  const shas = new Set()
  for (const rec of lsTreeZ.split('\0')) {
    const m = /^\d{6} blob ([0-9a-f]{40})\t/.exec(rec)
    if (m) shas.add(m[1])
  }
  return shas
}
