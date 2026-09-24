// @ts-check
/**
 * `agit protected` — what the protection policy says, so nobody has to guess.
 *
 *   agit protected a.mjs b/c.ts   the tier of each path, and why
 *   agit protected --changed      the same, for every uncommitted path
 *   agit protected --ref origin/main …   as of a ref, the way publish reads it
 *
 * Exits 1 when any named path is protected or impossible, so a script can ask.
 */

import { flag, has, positionals } from '../context.mjs'
import { dirtyPaths } from '../publish/publish.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

export async function run(argv) {
  if (has(argv, '--help')) {
    console.log('usage: agit protected [paths…] [--changed] [--ref <ref>] [-C <dir>]')
    return 0
  }
  const ctx = contextFrom(argv)
  const ref = flag(argv, '--ref')
  const policy = ref ? ctx.policyAt(ref) : ctx.localPolicy()
  const paths = [...positionals(argv, [...COMMON_VALUE_FLAGS, '--ref']), ...(has(argv, '--changed') ? dirtyPaths(ctx.git) : [])]

  console.log(`CODEOWNERS: ${policy.codeownersPath ?? '(none — only .agit.json extras and self-protected files apply)'}`)
  for (const u of policy.unsupported) console.log(`  ! ${u}`)
  if (!paths.length) return 0

  let hit = false
  for (const p of paths) {
    const r = policy.check(p)
    if (r) hit = true
    console.log(r ? `${r.tier.padEnd(10)} ${r.path} — ${r.why}` : `${'ordinary'.padEnd(10)} ${p}`)
  }
  return hit ? 1 : 0
}
