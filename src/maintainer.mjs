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
 * command that runs `agit maintainer grant`, and any write to the grant file.
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
 * WHERE. `<git-common-dir>/agit/maintainer.json` — inside `.git`, so it is
 * never tracked, needs no `.gitignore` line, and is shared by every worktree of
 * the clone (the grant is for a session, and a session may move between them).
 * Every change is appended to `maintainer.log` beside it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SCOPES = Object.freeze(['protected', 'no-verify', 'merge'])
export const DEFAULT_HOURS = 4
export const MAX_HOURS = 24

/** The grant file for a clone, from its `git rev-parse --git-common-dir`. */
export const grantPath = (gitCommonDir) => join(gitCommonDir, 'agit', 'maintainer.json')
export const logPath = (gitCommonDir) => join(gitCommonDir, 'agit', 'maintainer.log')

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
 *   | { state: 'none' }
 *   | { state: 'invalid', why: string }
 *   | { state: 'expired', grant: GrantFile }
 *   | { state: 'mismatch', grant: GrantFile, session: string | null }
 *   | { state: 'active', grant: GrantFile, session: string }
 * )} GrantView
 */

/**
 * The grant as seen by `session`. Never throws: an unreadable grant is no grant.
 *
 * @param {{ path: string, session?: string | null, now?: number }} input
 * @returns {GrantView}
 */
export function readGrant({ path, session = currentSession(), now = Date.now() }) {
  if (!existsSync(path)) return { state: 'none' }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { state: 'invalid', why: 'grant file is not valid JSON' }
  }
  if (!raw?.reason || !raw?.expiresAt || !Array.isArray(raw?.scopes))
    return { state: 'invalid', why: 'grant file lacks reason, expiresAt or scopes' }
  const expires = Date.parse(raw.expiresAt)
  if (Number.isNaN(expires)) return { state: 'invalid', why: 'expiresAt is not a date' }
  if (expires <= now) return { state: 'expired', grant: raw }
  const grantee = typeof raw.session === 'string' ? raw.session.trim() : ''
  const asking = typeof session === 'string' ? session.trim() : ''
  if (!grantee || grantee !== asking) return { state: 'mismatch', grant: raw, session: asking || null }
  return { state: 'active', grant: raw, session: asking }
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
  const session = view.state === 'mismatch' ? view.session : view.state === 'active' ? view.session : currentSession()
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
        `Maintainer mode is granted to session ${g.session || '(none)'}, not this one${session ? ` (${session})` : ''}, ` +
        `for: "${g.reason}". A grant unlocks only the session it names.`
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
  return null
}

/**
 * Write a grant. The caller has validated it.
 *
 * @param {{ path: string, log: string, reason: string, scopes: string[], hours: number, session: string, via: string, now?: Date }} input
 */
export function writeGrant({ path, log, reason, scopes, hours, session, via, now = new Date() }) {
  const grant = {
    reason: reason.trim(),
    scopes: [...new Set(scopes)],
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + hours * 3600_000).toISOString(),
    session,
    via,
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 })
  appendLog(log, `GRANT ${grant.scopes.join(',')} until ${grant.expiresAt} session=${session} via=${via} — ${grant.reason}`, now)
  return grant
}

export function revokeGrant({ path, log, via }) {
  const had = existsSync(path)
  if (had) unlinkSync(path)
  appendLog(log, `REVOKE${had ? '' : ' (none active)'} via=${via}`)
  return had
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
        `${view.grant.session} [${view.grant.scopes.join(', ')}] until ${view.grant.expiresAt} — "${view.grant.reason}"`
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
