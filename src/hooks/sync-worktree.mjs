// @ts-check
/**
 * PostToolUse/EnterWorktree hook — fast-forward a freshly created worktree
 * onto the base branch.
 *
 *   agit hook sync-worktree
 *
 * ---------------------------------------------------------------------------
 * WHY. Claude Code's `EnterWorktree` branches from `origin/<default-branch>`
 * (or the local HEAD, with `worktree.baseRef: "head"`). Neither is necessarily
 * the branch agent PRs land on, and a local ref is only as current as the last
 * fetch. A publish lands whole file contents, so a worktree based on stale
 * content would silently revert everything it does not know about — the
 * displacement gate refuses that at publish time (gates/drift.mjs), and this
 * hook stops the situation arising.
 *
 * The base is `.agit.json`'s `baseBranch`, else the remote's HEAD branch.
 *
 * ---------------------------------------------------------------------------
 * WHY FAST-FORWARD AND NOT `reset --hard`. A hook does not know the tree is
 * disposable. So the safety is structural:
 *
 *   1. nothing happens when `path` was passed — entering an EXISTING worktree
 *      is deliberate, and its ref may be deliberate too;
 *   2. nothing happens when the tree is dirty;
 *   3. `merge --ff-only` refuses rather than discards; a worktree carrying its
 *      own commits is left exactly as it is.
 *
 * Every failure is reported and none is fatal: the hook always exits 0.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolveContext } from '../context.mjs'

/** Emit the hook's one JSON object. */
function say(message) {
  if (!message) return
  process.stdout.write(
    `${JSON.stringify({
      systemMessage: message,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    })}\n`,
  )
}

/**
 * The worktree path: from the tool's result text ("Created worktree at <path>
 * …"), which states it outright, else the event's cwd.
 */
export function worktreePath(event) {
  const blob = JSON.stringify(event?.tool_response ?? '')
  const m = blob.match(/worktree at (\/[^"\\\s]+?)(?=["\\\s]|$)/i)
  return m ? m[1] : (event?.cwd ?? process.cwd())
}

/**
 * The whole hook, as a function of the event. Returns the message, if any.
 * The base is Context's offline rule (`baseBranchOffline`): a hook must not
 * mint a token to find it.
 *
 * @param {any} event
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function sync(event, { env = process.env } = {}) {
  // Entering an EXISTING worktree is deliberate. Only a new one is ours.
  if (event?.tool_input?.path) return null
  const wt = worktreePath(event)
  if (!existsSync(wt)) return null

  let base = null
  try {
    const ctx = resolveContext({ cwd: wt, env })
    if (!ctx.root) return null
    const { git } = ctx
    base = ctx.baseBranchOffline()
    if (!base) return null

    if (git(['status', '--porcelain']).trim()) {
      return `Worktree has uncommitted changes, so it was NOT synced to origin/${base}. If it is behind, publishing would revert files — agit's displacement gate will say so.`
    }
    const before = git(['rev-parse', 'HEAD']).trim()
    git(['fetch', 'origin', base])
    const target = git(['rev-parse', 'FETCH_HEAD']).trim()
    if (before === target) return null
    try {
      git(['merge', '--ff-only', 'FETCH_HEAD'])
    } catch {
      return `Worktree at ${before.slice(0, 7)} could not be fast-forwarded to origin/${base} (${target.slice(0, 7)}) — it has diverged. Left untouched; reconcile it before publishing.`
    }
    return `Worktree fast-forwarded ${before.slice(0, 7)} → ${target.slice(0, 7)} (origin/${base}).`
  } catch (err) {
    return `Could not sync the worktree to origin/${base ?? '<base>'}: ${/** @type {Error} */ (err)?.message ?? err}. Run \`agit advance ${base ?? '<base>'}\` before publishing.`
  }
}

export async function main() {
  let event
  try {
    event = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return
  }
  try {
    say(sync(event))
  } catch {
    // never wedge
  }
}
