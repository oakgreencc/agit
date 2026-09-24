// @ts-check
/**
 * What every verb does first: find out where it is (`-C`, `--repo`), and
 * refuse if this agit is older than the project's policy requires.
 */

import { resolve } from 'node:path'
import { flag, resolveContext } from '../context.mjs'
import { PublishError } from '../errors.mjs'
import { versionRefusal } from '../gates/version.mjs'

/** Flags every verb accepts, and which take a value. */
export const COMMON_VALUE_FLAGS = ['-C', '--repo']

/**
 * `resolveContext`'s input from a command line: `-C <dir>` (else `cwd`),
 * `--repo` (else `repo`). The one reading of the common flags, for the verbs
 * and for `setup`/`doctor`, which resolve a Context without the version gate.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, repo?: string | null, env?: NodeJS.ProcessEnv }} [defaults]
 */
export function contextOptions(argv, { cwd, repo = null, env } = {}) {
  const dir = flag(argv, '-C')
  return {
    cwd: dir ? resolve(dir) : (cwd ?? process.cwd()),
    repo: flag(argv, '--repo') ?? repo,
    ...(env ? { env } : {}),
  }
}

/**
 * @param {string[]} argv
 * @param {{ needRoot?: boolean, repo?: string | null, client?: import('../github/app.mjs').Client | null }} [opts]
 *   `repo` is used when --repo is absent; `client` replaces the minted one (tests)
 */
export function contextFrom(argv, { needRoot = true, repo = null, client = null } = {}) {
  const ctx = resolveContext({ ...contextOptions(argv, { repo }), client })
  if (needRoot) ctx.requireRoot()
  const refusal = versionRefusal(ctx.config.minVersion)
  if (refusal) throw new PublishError(refusal)
  return ctx
}
