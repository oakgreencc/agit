// @ts-check
/**
 * `agit validate` — run the project's validation in this worktree and, when it
 * is green, record which base it was green ON (gates/validated-base.mjs), so a
 * later publish onto a base that has since moved is refused rather than
 * shipping a combination nothing executed.
 *
 *   agit validate                 runs `validate.command` from .agit.json
 *   agit validate -- npm test     runs the given command instead
 */

import { spawnSync } from 'node:child_process'
import { flag, has } from '../context.mjs'
import { writeReceipt } from '../gates/validated-base.mjs'
import { PublishError } from '../errors.mjs'
import { contextFrom } from './common.mjs'

export async function run(argv) {
  const dash = argv.indexOf('--')
  const own = dash >= 0 ? argv.slice(0, dash) : argv
  if (has(own, '--help')) {
    console.log('usage: agit validate [--base <b>] [-C <dir>] [-- <command…>]')
    return 0
  }
  const ctx = contextFrom(own)
  const command = dash >= 0 ? argv.slice(dash + 1).join(' ') : ctx.config.validate.command
  if (!command)
    throw new PublishError(
      'agit validate: nothing to run. Set "validate": { "command": "…" } in .agit.json, or pass one after --.',
    )

  // The base the receipt names must be the one publish will compare against,
  // and current: fetch it first. A base that cannot be resolved means no
  // receipt — which the publish gate reads as "unknown", never as "stale".
  const base = flag(own, '--base') ?? (await ctx.baseBranch())
  const { git } = ctx
  try {
    git(['fetch', 'origin', base])
  } catch {
    console.error(`agit validate: could not fetch origin/${base}; the receipt uses the local ref`)
  }
  let baseSha = null
  let headSha = null
  try {
    baseSha = git(['rev-parse', `origin/${base}`]).trim()
    headSha = git(['rev-parse', 'HEAD']).trim()
  } catch {
    // see above
  }

  console.error(`agit validate: ${command}`)
  const res = spawnSync(command, { cwd: /** @type {string} */ (ctx.root), shell: true, stdio: 'inherit' })
  const code = res.status ?? 1
  if (code !== 0) {
    console.error(`agit validate: failed (exit ${code}); no receipt written`)
    return code
  }
  const receipt = writeReceipt({ gitDir: ctx.gitDir(), ref: `origin/${base}`, baseSha, headSha, command })
  console.log(
    receipt
      ? `validated against origin/${base} @ ${receipt.baseSha.slice(0, 12)}${headSha && headSha !== baseSha ? ` (HEAD ${headSha.slice(0, 12)})` : ''}`
      : 'validated, but no receipt could be written — publish will not check the base',
  )
  return 0
}
