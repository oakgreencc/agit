// @ts-check
/**
 * `agit hook <name>` — the Claude Code hook entry points, and their host.
 *
 * They are verbs of the one binary so the settings that wire them name
 * `agit hook …` and nothing machine-specific: the same `.claude/settings.json`
 * works on every contributor's machine that has agit on its PATH, and in the
 * plugin's hooks.json.
 *
 *   guard-credentials   PreToolUse Bash                 keep off human credentials
 *   guard-protected     PreToolUse Bash, Write|Edit|…   CODEOWNERS paths need a grant
 *   guard-pr-writes     PreToolUse Bash                 merges go through `agit pr merge`
 *   sync-worktree       PostToolUse EnterWorktree       fast-forward a new worktree
 *
 * THE HOST owns what every hook would otherwise repeat: reading the event
 * JSON on stdin, the failure posture, and the answer's envelope. A hook is a
 * module exporting
 *
 *   event                    'PreToolUse' (a guard: its message DENIES the call)
 *                            or 'PostToolUse' (a notice: its message is shown)
 *   decide(event, { env })   the message, or null for no opinion
 *
 * FAILURE POSTURE: open. An unreadable event, a hook that cannot load, or a
 * `decide` that throws answers nothing — a hook that wedges every Bash call
 * gets removed, and then guards nothing. A guard that must deny after it has
 * matched (guard-pr-writes) does so inside its own `decide`.
 */

import { readFileSync } from 'node:fs'

export const HOOKS = {
  'guard-credentials': () => import('./guard-credentials.mjs'),
  'guard-protected': () => import('./guard-protected.mjs'),
  'guard-pr-writes': () => import('./guard-pr-writes.mjs'),
  'sync-worktree': () => import('./sync-worktree.mjs'),
}

/**
 * @typedef {{
 *   event: 'PreToolUse' | 'PostToolUse',
 *   decide: (event: any, opts: { env: NodeJS.ProcessEnv }) => string | null | Promise<string | null>,
 * }} Hook
 */

/** The JSON Claude Code reads back, for a hook of `kind` saying `message`. */
export function envelope(kind, message) {
  return kind === 'PreToolUse'
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } }
    : { systemMessage: message, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } }
}

/**
 * One hook call, as a function: the event's text in, the answer line out
 * (`null`: say nothing). Never throws.
 *
 * @param {Hook} hook
 * @param {string} input   what arrived on stdin
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<string | null>}
 */
export async function respond(hook, input, { env = process.env } = {}) {
  let event
  try {
    event = JSON.parse(input || '{}')
  } catch {
    return null // unreadable event: no opinion
  }
  let message = null
  try {
    message = await hook.decide(event, { env })
  } catch {
    return null // a bug in a hook must not wedge the session
  }
  return message ? JSON.stringify(envelope(hook.event, message)) : null
}

const USAGE = `usage: agit hook <${Object.keys(HOOKS).join('|')}>

Claude Code hook entry points; they read the event JSON on stdin.
\`agit setup project\` wires them into .claude/settings.json.`

/** @param {string[]} argv */
export async function run(argv) {
  const name = argv[0]
  const load = name ? HOOKS[/** @type {keyof typeof HOOKS} */ (name)] : undefined
  if (!load) {
    console.error(USAGE)
    process.exit(1)
  }
  let hook
  let input = ''
  try {
    hook = /** @type {Hook} */ (await load())
    input = readFileSync(0, 'utf8')
  } catch {
    process.exit(0) // a hook that cannot load or read has no opinion — fail open
  }
  const out = await respond(hook, input)
  if (out) process.stdout.write(`${out}\n`)
  process.exit(0)
}
