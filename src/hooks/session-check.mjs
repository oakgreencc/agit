// @ts-check
/**
 * SessionStart hook — is raw git in this session bound to the App?
 *
 *   agit hook session-check
 *
 * The `GIT_CONFIG_*` block in `.claude/settings.json` and the Bash hooks are
 * loaded once, when a session starts. A session that started before `agit
 * setup project`, or that inherited another project's block, has raw git that
 * reaches for the human's SSH key or someone else's credential helper — and
 * no error anywhere says so. This asks git, under the session's environment,
 * what a raw `git fetch` would authenticate as (session-env.mjs), and tells
 * the agent and the human when it is not the App. Silent when it is.
 *
 * It cannot help a session that loaded no settings at all — this hook is in
 * those settings. What it catches is the session that loaded them and still
 * is not bound: a foreign block, a remote on another owner's SSH, a helper
 * that answers before agit's.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveContext } from '../context.mjs'
import { readRawGit, sessionFindings } from '../session-env.mjs'

/**
 * @param {any} event
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string | null}
 */
export function check(event, { env = process.env } = {}) {
  const ctx = resolveContext({ cwd: event?.cwd ?? process.cwd(), env })
  if (!ctx.root) return null
  const settingsPath = join(ctx.root, '.claude', 'settings.json')
  let settingsEnv = null
  try {
    if (existsSync(settingsPath)) settingsEnv = JSON.parse(readFileSync(settingsPath, 'utf8')).env ?? null
  } catch {
    // Unreadable settings: still say what raw git would do; doctor names the file.
  }
  const { url, helpers } = readRawGit({ cwd: ctx.root, env })
  if (!url) return null
  const problems = sessionFindings({ url, helpers, processEnv: env, settingsEnv }).filter((f) => f.level !== 'ok')
  if (!problems.length) return null
  return [
    'agit: raw git in this session is NOT bound to the GitHub App.',
    ...problems.map((f) => `- ${f.label}${f.detail ? `\n  ${f.detail}` : ''}`),
  ].join('\n')
}

/** A notice (see hooks/index.mjs): shown at session start, never blocks. */
export const event = 'SessionStart'

/** @param {any} input  @param {{ env: NodeJS.ProcessEnv }} opts */
export const decide = (input, { env }) => check(input, { env })
