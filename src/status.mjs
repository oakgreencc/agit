// @ts-check
/**
 * Is anything in this worktree not on GitHub?
 *
 * The question a human or agent asks before deleting a worktree. A tool that
 * counts "commits since the session started" gets it wrong for every agit
 * worktree: `publish` advances the local branch onto commits GitHub created,
 * so the local history is always "new" against where the session began — and
 * all of it is on GitHub (oakgreencc/agit#5).
 *
 * So the answer is read from GitHub, as the App, never from a raw fetch:
 *
 *   - uncommitted paths — the worktree's own, nothing to ask;
 *   - local commits GitHub does not hold — each asked with the compare API
 *     against what matters: the base, the branch named, the local branch, the
 *     PRs carrying HEAD (by their head sha, which GitHub keeps after a branch
 *     is deleted — so a squash merge still counts), and for a commit a
 *     remote-tracking ref points at, that ref's branch;
 *   - those PRs, and whether they merged.
 *
 * Remote-tracking refs are claims, not answers. They bound the walk down
 * HEAD's history only where GitHub confirms them: each commit the walk stops
 * at is asked about, and one GitHub lacks (a force-pushed or deleted branch)
 * is walked past. A stale ref never makes local work look published — the
 * direction that loses data.
 */

import { dirtyPaths } from './publish/publish.mjs'

const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean)

/**
 * @param {object} input
 * @param {(args: string[]) => string} input.git   runs git in the worktree
 * @param {import('./github/app.mjs').Client} input.client
 * @param {string} input.owner
 * @param {string} input.repo
 * @param {string} input.base                       the project's base branch
 * @param {string | null} [input.branch]            the branch this worktree publishes to, if known
 */
export async function localOnly({ git, client, owner, repo, base, branch = null }) {
  const dirty = dirtyPaths(git)
  const local = localBranch(git)
  const head = headSha(git)
  if (!head) return { head, local, dirty, unpublished: [], pulls: [], checkedAgainst: [] }

  const pulls = await pullsFor({ client, owner, repo, sha: head, branch })
  const checkedAgainst = [
    ...new Set([base, branch, local, ...pulls.flatMap((p) => [p.headSha, p.base])].filter((r) => r != null)),
  ]
  /** @type {Map<string, boolean>} */
  const known = new Map()
  const held = async (sha) => {
    if (!known.has(sha)) {
      const tracking = lines(git(['for-each-ref', '--format=%(refname:strip=3)', `--points-at=${sha}`, 'refs/remotes/origin/']))
      known.set(sha, await onGitHub({ client, owner, repo, sha, refs: [...checkedAgainst, ...tracking] }))
    }
    return known.get(sha)
  }

  const unpublished = []
  if (!(await held(head))) {
    const { candidates, bounds } = await walk({ git, head, held })
    // Newest first. A commit GitHub has takes its history with it.
    let pending = candidates
    while (pending.length) {
      const sha = /** @type {string} */ (pending.shift())
      if (await held(sha)) {
        const under = new Set(lines(git(['rev-list', sha, '--not', ...bounds])))
        pending = pending.filter((c) => !under.has(c))
      } else {
        unpublished.push(sha)
      }
    }
  }
  return { head, local, dirty, unpublished, pulls, checkedAgainst }
}

/**
 * HEAD's commits down to where GitHub is confirmed to hold the rest. Starts
 * from the remote-tracking tips — less any that hold HEAD, which GitHub does
 * not, so they are stale — and replaces every stopping point GitHub lacks
 * with its parents until each one is confirmed.
 *
 * @param {{ git: (args: string[]) => string, head: string, held: (sha: string) => Promise<boolean | undefined> }} input
 */
async function walk({ git, head, held }) {
  let bounds = lines(git(['for-each-ref', '--format=%(objectname)', `--no-contains=${head}`, 'refs/remotes/']))
  for (;;) {
    const out = lines(git(['rev-list', '--boundary', head, '--not', ...bounds]))
    const boundary = out.filter((l) => l.startsWith('-')).map((l) => l.slice(1))
    const lacking = []
    for (const b of boundary) if (!(await held(b))) lacking.push(b)
    if (!lacking.length) return { candidates: out.filter((l) => !l.startsWith('-')), bounds: boundary }
    const parents = lacking.flatMap((b) => lines(git(['rev-list', '--parents', '-n', '1', b]))[0].split(/\s+/).slice(1))
    bounds = [...boundary.filter((b) => !lacking.includes(b)), ...parents]
  }
}

function headSha(git) {
  try {
    return git(['rev-parse', '--verify', '-q', 'HEAD']).trim() || null
  } catch {
    return null // unborn: no commits, nothing to lose but the dirty paths
  }
}

/** The checked-out branch, or null when detached. */
function localBranch(git) {
  try {
    return git(['symbolic-ref', '--short', '-q', 'HEAD']).trim() || null
  } catch {
    return null
  }
}

/**
 * The PRs carrying `sha` — open ones whose head holds it, and the merged one
 * that brought it in — plus every PR from `branch`, found even when HEAD
 * itself is not on GitHub.
 */
async function pullsFor({ client, owner, repo, sha, branch }) {
  const found = []
  try {
    found.push(...(await client.api(`/repos/${owner}/${repo}/commits/${sha}/pulls`)))
  } catch (e) {
    // 422: a commit GitHub has never seen carries no PR. Anything else is a real failure.
    if (!/: 422 /.test(String(/** @type {Error} */ (e)?.message))) throw e
  }
  if (branch)
    found.push(...(await client.api(`/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`)))
  const byNumber = new Map(
    found.map((p) => [
      p.number,
      {
        number: p.number,
        merged: Boolean(p.merged_at),
        state: p.state,
        head: p.head?.ref ?? null,
        headSha: p.head?.sha ?? null,
        base: p.base?.ref ?? null,
        url: p.html_url,
      },
    ]),
  )
  return [...byNumber.values()]
}

/** Whether any of `refs` (branch names or shas) on GitHub contains `sha`. A missing ref, or a sha GitHub lacks, is a 404: no. */
async function onGitHub({ client, owner, repo, sha, refs }) {
  for (const ref of new Set(refs)) {
    const cmp = await client.getOrNull(`/repos/${owner}/${repo}/compare/${encodeURIComponent(ref)}...${sha}`)
    if (cmp && cmp.ahead_by === 0) return true
  }
  return false
}

const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`

/**
 * The one line to read before deleting a worktree: nothing local, or exactly
 * what would be lost.
 *
 * @param {{ dirty: string[], unpublished: string[] }} status
 */
export function verdict({ dirty, unpublished }) {
  if (!dirty.length && !unpublished.length) return 'nothing local that GitHub does not have'
  const bits = []
  if (dirty.length) bits.push(n(dirty.length, 'uncommitted path'))
  if (unpublished.length) bits.push(n(unpublished.length, 'commit'))
  return `local only (not on GitHub): ${bits.join(', ')}`
}

/**
 * The full report `agit status` prints, ending with the verdict.
 *
 * @param {Awaited<ReturnType<typeof localOnly>>} status
 */
export function statusLines(status) {
  const where = status.local ? ` (${status.local})` : ' (detached)'
  const out = [status.head ? `HEAD ${status.head.slice(0, 7)}${where}` : 'HEAD: no commits yet']
  if (status.dirty.length) out.push(`uncommitted: ${n(status.dirty.length, 'path')}`, ...status.dirty.map((p) => `  ${p}`))
  if (status.unpublished.length)
    out.push(
      `commits GitHub does not hold: ${status.unpublished.length}`,
      ...status.unpublished.map((c) => `  ${c.slice(0, 7)}`),
    )
  const short = (r) => (/^[0-9a-f]{40}$/.test(r) ? r.slice(0, 7) : r)
  out.push(`checked against: ${status.checkedAgainst.map(short).join(', ') || '(nothing)'}`)
  for (const p of status.pulls)
    out.push(`PR #${p.number} (${p.head} → ${p.base}): ${p.merged ? 'merged' : p.state}  ${p.url}`)
  out.push(verdict(status))
  return out
}
