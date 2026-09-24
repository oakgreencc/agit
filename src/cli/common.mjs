// @ts-check
/**
 * What every verb does first: find out where it is (`-C`, `--repo`), and
 * refuse if this agit is older than the project's policy requires.
 */

import { resolve } from 'node:path'
import { flag, resolveContext } from '../context.mjs'
import { versionRefusal } from '../gates/version.mjs'
import { PublishError } from '../publish/publish.mjs'

/** Flags every verb accepts, and which take a value. */
export const COMMON_VALUE_FLAGS = ['-C', '--repo']

/**
 * @param {string[]} argv
 * @param {{ needRoot?: boolean, repo?: string | null }} [opts] `repo` is used when --repo is absent
 */
export function contextFrom(argv, { needRoot = true, repo = null } = {}) {
  const dir = flag(argv, '-C')
  const ctx = resolveContext({
    cwd: dir ? resolve(dir) : process.cwd(),
    repo: flag(argv, '--repo') ?? repo,
  })
  if (needRoot) ctx.requireRoot()
  const refusal = versionRefusal(ctx.config.minVersion)
  if (refusal) throw new PublishError(refusal)
  return ctx
}

/** Print a usage line and signal failure. */
export function usage(line) {
  throw new PublishError(line)
}
