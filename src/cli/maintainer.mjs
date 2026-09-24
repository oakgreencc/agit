// @ts-check
/**
 * `agit maintainer` — the human's override. See src/maintainer.mjs for why it
 * is scoped, session-bound and expiring, and why an agent must not run `grant`.
 *
 *   ! agit maintainer grant "why this session needs it" [--scope protected,no-verify,merge] [--hours 4]
 *   agit maintainer grant "why" --scope protected --session <id>     (from another terminal)
 *   agit maintainer status
 *   agit maintainer revoke
 */

import { flag, has, positionals } from '../context.mjs'
import {
  DEFAULT_HOURS,
  SCOPES,
  currentSession,
  describe,
  describeInvocation,
  revokeGrant,
  validateRequest,
  writeGrant,
} from '../maintainer.mjs'
import { PublishError } from '../errors.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

const USAGE = `usage:
  agit maintainer status
  agit maintainer grant "<reason, more than one word>" [--scope ${SCOPES.join(',')}] [--hours N] [--session <id>]
  agit maintainer revoke

Scopes (default: protected):
  protected   edit and publish CODEOWNERS-protected paths (the PR still needs code-owner review)
  no-verify   publish without running the repository's git hooks
  merge       agit pr merge past the local merge policy (base, protected paths, red base)

A grant is bound to ONE session: the one it is typed into (\`! agit maintainer grant …\` in
Claude Code), or the one named by --session. It expires (default ${DEFAULT_HOURS}h, max 24h).`

export async function run(argv) {
  const [sub, ...rest] = argv
  if (!sub || sub === '--help' || sub === 'help') {
    console.log(USAGE)
    return sub ? 0 : 1
  }
  const ctx = contextFrom(rest)
  const files = ctx.grantFiles()
  const via = describeInvocation()

  if (sub === 'status') {
    const session = flag(rest, '--session') ?? currentSession()
    console.log(describe(ctx.grant(session)))
    return 0
  }
  if (sub === 'revoke' || sub === 'off') {
    const had = revokeGrant({ ...files, via })
    console.log(had ? 'maintainer mode: OFF (revoked)' : 'maintainer mode: OFF (there was no grant)')
    return 0
  }
  if (sub !== 'grant' && sub !== 'on') throw new PublishError(`unknown subcommand "${sub}"\n\n${USAGE}`)

  const valueFlags = [...COMMON_VALUE_FLAGS, '--scope', '--hours', '--session']
  const reason = positionals(rest, valueFlags).join(' ')
  const scopes = (flag(rest, '--scope') ?? 'protected').split(',').map((s) => s.trim()).filter(Boolean)
  const hours = has(rest, '--hours') ? Number(flag(rest, '--hours')) : DEFAULT_HOURS
  const session = flag(rest, '--session') ?? currentSession()
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
