// @ts-check
/**
 * `agit ci wait` — wait for one check on one ref to reach a verdict.
 *
 *   agit ci wait <sha|ref> [--check <name>] [--timeout <s>] [--interval <s>] [--repo o/r]
 *
 * The verdict is the JSON on stdout AND the exit code: 0 green, 1 red,
 * 2 unknowable (src/github/checks.mjs). Progress goes to stderr, so a caller
 * piping the JSON never parses a progress line. `--check` defaults to the
 * project's `requiredCheck`; with neither, there is no question to ask.
 */

import { flag, positionals } from '../context.mjs'
import { PublishError } from '../errors.mjs'
import { pollCheckRunsUntilVerdict, VERDICT_EXIT } from '../github/checks.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

const USAGE = 'usage: agit ci wait <sha|ref> [--check <name>] [--timeout <seconds>] [--interval <seconds>] [--repo <owner/repo>]'

const VALUE_FLAGS = [...COMMON_VALUE_FLAGS, '--check', '--timeout', '--interval']

/** A whole number of seconds from `name`, as milliseconds, or `fallback`. */
function seconds(argv, name, fallback) {
  const raw = flag(argv, name)
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) throw new PublishError(`${name} takes whole seconds\n${USAGE}`)
  return Number(raw) * 1000
}

/**
 * @param {string[]} argv
 * @param {{ client?: import('../github/app.mjs').Client, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   say?: (line: string) => void, report?: (line: string) => void }} [deps]
 * @returns {Promise<number>} the exit code for the verdict
 */
export async function run(argv, { client: given, sleep, now, say = console.log, report = console.error } = {}) {
  const [sub, ref, ...extra] = positionals(argv, VALUE_FLAGS)
  if (sub !== 'wait' || !ref || extra.length) throw new PublishError(USAGE)
  const timeoutMs = seconds(argv, '--timeout', 45 * 60_000)
  const intervalMs = seconds(argv, '--interval', 30_000)
  const ctx = contextFrom(argv, { needRoot: false, client: given })
  const check = flag(argv, '--check') ?? ctx.config.requiredCheck
  if (!check) throw new PublishError(`no --check given and .agit.json has no "requiredCheck"\n${USAGE}`)
  const { owner, repo } = ctx.repo()
  const client = await ctx.client()
  const out = await pollCheckRunsUntilVerdict({
    client,
    owner,
    repo,
    ref,
    check,
    timeoutMs,
    intervalMs,
    report,
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
  })
  say(JSON.stringify(out, null, 2))
  return VERDICT_EXIT[out.verdict]
}
