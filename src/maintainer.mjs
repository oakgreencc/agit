// @ts-check
/**
 * Maintainer mode — a human's time-boxed, reasoned, SCOPED grant that lifts
 * part of the protective layer for one agent session, without taking agit out
 * of the loop.
 *
 * ---------------------------------------------------------------------------
 * RUN IT YOURSELF. An agent asking you to run it is the mechanism working.
 *
 *   ! agit maintainer grant "why this session needs it" [--scope protected,no-verify] [--hours 4]
 *   ! agit maintainer revoke
 *   ! agit maintainer status
 *
 * In Claude Code the `!` prefix runs the command as YOU: it is not a tool call,
 * so no PreToolUse hook sees it, and it binds the grant to the session it is
 * typed into. From a separate terminal, name the session (every refusal prints
 * its id): `agit maintainer grant "why" --session <id>`.
 *
 * The agent cannot grant itself: `agit hook guard-protected` refuses any agent
 * command that runs `agit maintainer grant`, and any write to the grants.
 * That is a tripwire, not a lock — an agent with a shell can do anything a
 * shell can — but a self-grant is then a deliberate act, not a slip.
 *
 * ---------------------------------------------------------------------------
 * SCOPES — what a grant lifts. Everything else stays in force.
 *
 *   protected   edit and publish paths CODEOWNERS (or `.agit.json`) protects.
 *               The PR still needs the code owner's review on GitHub.
 *   no-verify   publish without running the repository's git hooks.
 *   merge       `agit pr merge` past the local merge policy: a base outside
 *               `mergeableBases`, protected paths in the diff, a red base.
 *               GitHub's rulesets still apply; this lifts agit's opinion only.
 *
 * `impossible` paths have no scope. No grant makes the App hold a permission
 * it does not have.
 *
 * ---------------------------------------------------------------------------
 * SESSION-BOUND. A grant names one session and unlocks only that one. A grant
 * that names none unlocks nothing, and the CLI refuses to write one. (In the
 * harness this was ported from, one session's grant once unlocked fourteen
 * concurrent sessions on a reason none of them had asked for.)
 *
 * Session id: `CLAUDE_CODE_SESSION_ID` under Claude Code — hooks use the
 * event's `session_id` — else `AGIT_SESSION`, for any other agent runner that
 * sets one.
 *
 * WHERE. `<git-common-dir>/agit/maintainer/<session>.json` — one file per
 * session, inside `.git`, so it is never tracked, needs no `.gitignore` line,
 * and is shared by every worktree of the clone (the grant is for a session, and
 * a session may move between them). Every change is appended to
 * `maintainer.log` beside the directory.
 *
 * ONE FILE PER SESSION, SO GRANTS COEXIST. Granting writes only the granted
 * session's file, `revoke` removes only one session's, and `status` lists every
 * live grant. (In the harness this was ported from, the grant was once one file
 * per clone: granting a second session silently overwrote the first, whose
 * next write was refused as "granted to session <other>", and any session's
 * revoke revoked everyone's.) The one-slot `<git-common-dir>/agit/maintainer.json`
 * of earlier versions is still read, never written, and revoked only by its own
 * session.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SCOPES = Object.freeze(['protected', 'no-verify', 'merge'])
export const DEFAULT_HOURS = 4
export const MAX_HOURS = 24

/** How long a lapsed grant stays on disk, still reading as expired to its session. */
const PRUNE_AFTER_MS = 24 * 3600_000

/** The grants directory for a clone, from its `git rev-parse --git-common-dir`. */
export const grantsDir = (gitCommonDir) => join(gitCommonDir, 'agit', 'maintainer')
export const logPath = (gitCommonDir) => join(gitCommonDir, 'agit', 'maintainer.log')

/** The one-slot grant file every version before per-session grants wrote, beside the directory. */
const legacyPath = (dir) => `${dir}.json`

/** A session id usable as a file name: no path separator, no leading dot. */
export function isSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
}

/**
 * The session asking: a hook event's `session_id` (the session making THAT
 * tool call), else the environment's `CLAUDE_CODE_SESSION_ID`, else
 * `AGIT_SESSION`. The one rule, for the CLI and the hooks alike.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ session_id?: string } | null} [event]
 */
export function currentSession(env = process.env, event = null) {
  const id = event?.session_id || env.CLAUDE_CODE_SESSION_ID || env.AGIT_SESSION || ''
  return String(id).trim() || null
}

/**
 * @typedef {{ reason: string, scopes: string[], grantedAt: string, expiresAt: string, session: string, via: string }} GrantFile
 * @typedef {(
 *   | { state: 'none', session?: string | null }
 *   | { state: 'invalid', why: string, session?: string | null }
 *   | { state: 'expired', grant: GrantFile, session?: string | null }
 *   | { state: 'mismatch', grants: GrantFile[], session: string | null }
 *   | { state: 'active', grant: GrantFile, session: string }
 * )} GrantView
 *   `session` is the session ASKING — every refusal's advice names it, so the
 *   human's `--session` points at the session that was refused. A mismatch
 *   lists every live grant, none of them this session's.
 * @typedef {{ key: string | null, path: string, invalid?: string, expired?: boolean, grant?: GrantFile }} Judged
 *   `key` is the session a file is filed under (`null` for the legacy slot) —
 *   the only owner an unreadable file has.
 */

const trimmed = (s) => (typeof s === 'string' ? s.trim() : '')

/** One grant file judged on its own: invalid, expired, or live. */
function judgeFile(path, key, now) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { key, path, invalid: 'grant file is not valid JSON' }
  }
  if (!raw?.reason || !raw?.expiresAt || !Array.isArray(raw?.scopes))
    return { key, path, invalid: 'grant file lacks reason, expiresAt or scopes' }
  const expires = Date.parse(raw.expiresAt)
  if (Number.isNaN(expires)) return { key, path, invalid: 'expiresAt is not a date' }
  return { key, path, expired: expires <= now, grant: raw }
}

/**
 * Every grant file under `dir`, and the legacy slot beside it, judged at `now`.
 *
 * @returns {Judged[]}
 */
export function listGrants(dir, now = Date.now()) {
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    // No directory is no grants.
  }
  const found = names.sort().map((n) => judgeFile(join(dir, n), n.slice(0, -'.json'.length), now))
  if (existsSync(legacyPath(dir))) found.push(judgeFile(legacyPath(dir), null, now))
  return found
}

const isLive = (j) => !j.invalid && !j.expired

/** Every live grant under `dir` — what `status` lists. */
export function listLive(dir, now = Date.now()) {
  return listGrants(dir, now)
    .filter(isLive)
    .map((j) => /** @type {GrantFile} */ (j.grant))
}

/** The newest lapsed grant in `js` as expired, else the first corrupt one as invalid, else null. */
function notLive(js, who) {
  const lapsed = js
    .filter((j) => j.expired)
    .reduce((a, b) => (!a || Date.parse(b.grant.expiresAt) > Date.parse(a.grant.expiresAt) ? b : a), null)
  if (lapsed) return { state: 'expired', grant: lapsed.grant, session: who }
  const broken = js.find((j) => j.invalid)
  return broken ? { state: 'invalid', why: broken.invalid, session: who } : null
}

/**
 * The grants as seen by `session`. Never throws: an unreadable grant is no grant.
 *
 * This session's own files are judged first, so a lapsed or corrupt grant of
 * someone else's never hides a live one of its own. With nothing of its own, a
 * session sees the others' live grants as a mismatch; failing those, a lapsed
 * grant reads as expired and a corrupt one as invalid, whoever asks.
 *
 * @param {{ dir: string, session?: string | null, now?: number }} input
 * @returns {GrantView}
 */
export function readGrant({ dir, session = currentSession(), now = Date.now() }) {
  const asking = trimmed(session)
  const who = asking || null
  const all = listGrants(dir, now)
  if (!all.length) return { state: 'none', session: who }

  // An unreadable file has no grantee, so it is this session's only by name.
  const mine = asking ? all.filter((j) => (j.invalid ? j.key === asking : trimmed(j.grant?.session) === asking)) : []
  const own = mine.find(isLive)
  if (own) return { state: 'active', grant: /** @type {GrantFile} */ (own.grant), session: asking }
  const ownState = notLive(mine, who)
  if (ownState) return ownState

  const live = all.filter(isLive)
  if (live.length) return { state: 'mismatch', grants: live.map((j) => /** @type {GrantFile} */ (j.grant)), session: who }
  return notLive(all, who) ?? { state: 'none', session: who }
}

/** One grant in words: whose, what it lifts, until when, why. */
export function describeGrant(g) {
  const who = trimmed(g.session)
    ? `session ${trimmed(g.session)}`
    : `no session (via=${g.via || 'unknown'}, so it unlocks nothing)`
  return `${who} [${g.scopes.join(', ')}] until ${g.expiresAt} — "${g.reason}"`
}

/** Every live grant, one per line — what `status` adds below this session's state. */
export function describeAll(grants) {
  if (!grants.length) return 'active grants: none'
  return [`active grants (${grants.length}):`, ...grants.map((g) => `  ${describeGrant(g)}`)].join('\n')
}

/** Does `view` lift `scope`? */
export function allows(view, scope) {
  return view.state === 'active' && view.grant.scopes.includes(scope)
}

/**
 * One sentence on why `scope` is NOT lifted, and the exact command a human
 * runs to lift it — the tail of every refusal that a grant could clear.
 *
 * @param {GrantView} view
 * @param {string} scope
 */
export function grantAdvice(view, scope) {
  const g = /** @type {any} */ (view).grant
  const session = view.session !== undefined ? view.session : currentSession()
  let state
  switch (view.state) {
    case 'none':
      state = 'Maintainer mode is off.'
      break
    case 'invalid':
      state = `Maintainer mode is off (${view.why}).`
      break
    case 'expired':
      state = `Maintainer mode expired at ${g.expiresAt} (granted for: "${g.reason}").`
      break
    case 'mismatch':
      state =
        `Maintainer mode is off for this session${session ? ` (${session})` : ''}. It is granted to ` +
        `${view.grants.map(describeGrant).join('; ')}. A grant unlocks only the session it names.`
      break
    case 'active':
      state = `This session's grant ("${g.reason}") does not include the \`${scope}\` scope (it has: ${g.scopes.join(', ')}).`
      break
  }
  return (
    `${state}\n\nAsk the human to grant it, with a reason — they run it, not you:\n\n` +
    `    ! agit maintainer grant "<why this session needs it>" --scope ${scope}\n` +
    (session ? `    (from another terminal: agit maintainer grant "<why>" --scope ${scope} --session ${session})\n` : '')
  )
}

/** One line per state change, so a grant is never invisible after the fact. Best effort. */
export function appendLog(path, line, now = new Date()) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${now.toISOString()} ${line}\n`)
  } catch {
    // Logging must not fail the grant.
  }
}

/**
 * Validate a grant request. Returns an error string, or `null`.
 *
 * A reason is at least two words: it is shown to every agent that trips the
 * guard and written to the log, and "fix" helps nobody later. A bare
 * `status`/`off`/`revoke` is refused as a reason because it is almost
 * certainly a mistyped subcommand — one of which, in the original harness,
 * silently turned the gate ON with the reason "status".
 */
export function validateRequest({ reason, scopes, hours, session }) {
  const text = String(reason ?? '').trim()
  if (!text) return 'a reason is required'
  const words = text.split(/\s+/)
  if (words.length === 1) {
    const bare = words[0].toLowerCase().replace(/^-+/, '')
    if (['status', 'off', 'revoke', 'on', 'grant', 'help'].includes(bare))
      return `"${words[0]}" is not a reason — did you mean \`agit maintainer ${bare === 'off' ? 'revoke' : bare}\`?`
    return 'a reason must be more than one word — it is shown to every agent that hits the guard'
  }
  if (!scopes.length) return `name at least one scope: ${SCOPES.join(', ')}`
  const unknown = scopes.filter((s) => !SCOPES.includes(s))
  if (unknown.length) return `unknown scope${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (known: ${SCOPES.join(', ')})`
  if (!(Number.isFinite(hours) && hours > 0 && hours <= MAX_HOURS)) return `--hours must be between 0 and ${MAX_HOURS}`
  if (!session)
    return (
      'this grant would name no session, so it would unlock nothing.\n' +
      'Run it inside the session that needs it (`! agit maintainer grant …` in Claude Code),\n' +
      'or name the session: --session <id> (the refusal the agent relayed prints it).'
    )
  if (!isSessionId(session)) return `"${session}" is not a usable session id — it becomes a file name`
  return null
}

/** Unlink, tolerating a concurrent CLI having got there first. */
function removeFile(path) {
  try {
    unlinkSync(path)
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e
  }
}

/** Delete grant files lapsed over a day ago, so the directory does not accrete; returns whose. */
function pruneLapsed(dir, now) {
  const stale = listGrants(dir, now).filter(
    (j) => j.expired && Date.parse(/** @type {GrantFile} */ (j.grant).expiresAt) + PRUNE_AFTER_MS <= now,
  )
  for (const j of stale) removeFile(j.path)
  return stale.map((j) => trimmed(j.grant?.session) || j.key || 'legacy')
}

/**
 * Write `session`'s grant, replacing only its own file — every other
 * session's grant stands. The caller has validated it.
 *
 * @param {{ dir: string, log: string, reason: string, scopes: string[], hours: number, session: string, via: string, now?: Date }} input
 */
export function writeGrant({ dir, log, reason, scopes, hours, session, via, now = new Date() }) {
  if (!isSessionId(session)) throw new Error(`"${session}" is not a usable session id`)
  const grant = {
    reason: reason.trim(),
    scopes: [...new Set(scopes)],
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + hours * 3600_000).toISOString(),
    session,
    via,
  }
  for (const who of pruneLapsed(dir, now.getTime())) appendLog(log, `PRUNED lapsed grant for ${who}`, now)
  mkdirSync(dir, { recursive: true })
  // Rename into place, so a hook reading mid-write sees the old file or the new.
  const tmp = join(dir, `.${session}.${process.pid}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, join(dir, `${session}.json`))
  appendLog(log, `GRANT ${grant.scopes.join(',')} until ${grant.expiresAt} session=${session} via=${via} — ${grant.reason}`, now)
  return grant
}

/**
 * Remove every grant `session` owns — by the grantee recorded inside (what
 * `readGrant` honours), plus its own file by name — and nobody else's. The
 * legacy slot goes the same way, so only when it is that session's. Returns
 * whether there was one.
 *
 * @param {{ dir: string, log: string, session: string, via: string }} input
 */
export function revokeGrant({ dir, log, session, via }) {
  const own = listGrants(dir).filter((j) => j.key === session || trimmed(j.grant?.session) === session)
  for (const j of own) removeFile(j.path)
  appendLog(log, `REVOKE${own.length ? '' : ' (none active)'} session=${session} via=${via}`)
  return own.length > 0
}

/** A one-line description of a view, for `status`. */
export function describe(view) {
  switch (view.state) {
    case 'none':
      return 'maintainer mode: OFF'
    case 'invalid':
      return `maintainer mode: OFF (${view.why})`
    case 'expired':
      return `maintainer mode: EXPIRED at ${view.grant.expiresAt} — "${view.grant.reason}"`
    case 'mismatch':
      return (
        `maintainer mode: OFF for this session${view.session ? ` (${view.session})` : ''} — granted to ` +
        view.grants.map(describeGrant).join('; ')
      )
    case 'active':
      return `maintainer mode: ON [${view.grant.scopes.join(', ')}] for session ${view.session} until ${view.grant.expiresAt} — "${view.grant.reason}"`
  }
}

/** How the grant was issued, as far as the process can tell. Traceability, not proof. */
export function describeInvocation(env = process.env, isTTY = Boolean(process.stdin.isTTY)) {
  if (env.CLAUDECODE === '1') return 'claude-session'
  return isTTY ? 'terminal' : 'unattended'
}
