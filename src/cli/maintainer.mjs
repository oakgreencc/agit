// @ts-check
/**
 * `agit maintainer` — the human's override. See src/maintainer.mjs for why it
 * is scoped, session-bound and expiring, and why an agent must not run `grant`.
 *
 *   ! agit maintainer grant "why this session needs it" [--scope protected,no-verify,merge] [--hours 4]
 *   agit maintainer grant "why" --scope protected --session <id>     (from another terminal)
 *   agit maintainer status               this session's state, then every live grant
 *   agit maintainer revoke [--session <id>]   one session's grant, never the clone's
 */

import { flag, has, positionals } from '../context.mjs'
import {
  DEFAULT_HOURS,
  SCOPES,
  currentSession,
  describe,
  describeAll,
  describeInvocation,
  isSessionId,
  revokeGrant,
  validateRequest,
  writeGrant,
} from '../maintainer.mjs'
import { PublishError } from '../errors.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

const USAGE = `usage:
  agit maintainer status
  agit maintainer grant "<reason, more than one word>" [--scope ${SCOPES.join(',')}] [--hours N] [--session <id>]
  agit maintainer revoke [--session <id>]

Scopes (default: protected):
  protected   edit and publish CODEOWNERS-protected paths (the PR still needs code-owner review)
  no-verify   publish without running the repository's git hooks
  merge       agit pr merge past the local merge policy (base, protected paths, red base)

A grant is bound to ONE session: the one it is typed into (\`! agit maintainer grant …\` in
Claude Code), or the one named by --session. It expires (default ${DEFAULT_HOURS}h, max 24h).
Each session holds its own grant; revoke removes one session's, and status lists them all.`

export async function run(argv) {
  const [sub, ...rest] = argv
  if (!sub || sub === '--help' || sub === 'help') {
    console.log(USAGE)
    return sub ? 0 : 1
  }
  const ctx = contextFrom(rest)
  const files = ctx.grantFiles()
  const via = describeInvocation()

  // `--session` given without a usable value is refused rather than falling
  // back to this process's session and acting on the wrong one.
  const named = has(rest, '--session') ? flag(rest, '--session') : undefined
  if (named !== undefined && (!named || named.startsWith('-')))
    throw new PublishError(`agit maintainer ${sub}: --session needs a session id\n\n${USAGE}`)
  if (named && !isSessionId(named))
    throw new PublishError(`agit maintainer ${sub}: "${named}" is not a usable session id — it becomes a file name`)

  if (sub === 'status') {
    const view = ctx.grant(named ?? currentSession())
    console.log(describe(view))
    // A mismatch already listed every live grant; anything else lists them here.
    if (view.state !== 'mismatch') console.log(describeAll(ctx.liveGrants()))
    return 0
  }
  if (sub === 'revoke' || sub === 'off') {
    // Only one session's grant, never the clone's: with several sessions
    // holding grants, "off" for everyone would revoke work nobody asked to stop.
    const session = named ?? currentSession()
    if (!session)
      throw new PublishError(
        "agit maintainer revoke: revoke removes one session's grant, and this names none.\n" +
          'Run it inside that session (`! agit maintainer revoke`), or name it: --session <id>',
      )
    const had = revokeGrant({ ...files, session, via })
    console.log(`maintainer mode: OFF for session ${session} ${had ? '(revoked)' : '(there was no grant)'}`)
    console.log(describeAll(ctx.liveGrants()))
    return 0
  }
  if (sub !== 'grant' && sub !== 'on') throw new PublishError(`unknown subcommand "${sub}"\n\n${USAGE}`)

  const valueFlags = [...COMMON_VALUE_FLAGS, '--scope', '--hours', '--session']
  const reason = positionals(rest, valueFlags).join(' ')
  const scopes = (flag(rest, '--scope') ?? 'protected').split(',').map((s) => s.trim()).filter(Boolean)
  const hours = has(rest, '--hours') ? Number(flag(rest, '--hours')) : DEFAULT_HOURS
  const session = named ?? currentSession()
  const problem = validateRequest({ reason, scopes, hours, session })
  if (problem) throw new PublishError(`agit maintainer grant: ${problem}\n\n${USAGE}`)

  const grant = writeGrant({ ...files, reason, scopes, hours, session: /** @type {string} */ (session), via })
  console.log(describe(ctx.grant(grant.session)))
  console.log(
    `\nLifted for session ${grant.session} only: ${grant.scopes.join(', ')}. Every other gate stays in force,\n` +
      'and GitHub still requires code-owner review on protected paths. Revoke early with `agit maintainer revoke`.',
  )
  return 0
}
