// @ts-check
/**
 * `agit status` — is anything in this worktree not on GitHub? The read to run
 * before deleting a worktree. See src/status.mjs.
 */

import { flag, has, positionals } from '../context.mjs'
import { localOnly, statusLines } from '../status.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

const USAGE =
  'usage: agit status [<branch>] [--base <b>] [-C <dir>] [--repo <owner/repo>]\n\n' +
  'What this worktree holds that GitHub does not: uncommitted paths, and local commits no branch\n' +
  'on GitHub contains — checked through the API as the App, no fetch. <branch> is the branch you\n' +
  'publish to, when HEAD is not its tip. Run it before removing a worktree.'

export async function run(argv) {
  if (has(argv, '--help')) {
    console.log(USAGE)
    return 0
  }
  const [branch] = positionals(argv, [...COMMON_VALUE_FLAGS, '--base'])
  const ctx = contextFrom(argv)
  const { owner, repo, full } = ctx.repo()
  const client = await ctx.client()
  const base = flag(argv, '--base') ?? (await ctx.baseBranch())
  const status = await localOnly({ git: ctx.git, client, owner, repo, base, branch: branch ?? null })
  console.log(full)
  for (const line of statusLines(status)) console.log(line)
  return 0
}
