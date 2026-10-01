// @ts-check
/**
 * Which tool calls an agent working through agit makes, and whether Claude
 * Code's permission rules let each one through without a prompt — pure.
 *
 * Auto mode puts a classifier in front of every call no rule decides, and the
 * classifier moves: a call it waved through last month it may stop on next
 * month, and a headless session has no one to answer the prompt. An explicit
 * allow rule decides before the classifier is asked, so the workflow is only
 * as dependable as its rules. This is the list the rules must cover:
 *
 *   AGENT_CALLS   one representative call per thing the workflow does — every
 *                 agent-run verb and action, the read-only git the skill
 *                 tells the agent to use, the worktree lifecycle
 *   NOT_AGENT     the verbs and actions an agent never runs as a tool call,
 *                 each with why. Every verb and action in src/cli/verbs.mjs is
 *                 in exactly one of the two (test/permissions.test.mjs), so a
 *                 new verb cannot ship without saying which.
 *
 * `unallowedCalls` judges the list against a stack of settings layers (user,
 * project, local): denied, ask, or simply not allowed. `agit doctor` runs it
 * over the files this machine has; the test runs it over what `agit setup
 * project` writes.
 *
 * The matcher follows Claude Code's documented rule syntax, not its full
 * shell parser: one call, one command, no operators. A representative call
 * that needs `&&` to make sense does not belong in the list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** @typedef {{ tool: string, command?: string, why: string }} Call */

/** @type {readonly Call[]} */
export const AGENT_CALLS = Object.freeze([
  // --- agit ---------------------------------------------------------------
  { tool: 'Bash', command: 'agit --version', why: 'the skill checks agit is installed' },
  { tool: 'Bash', command: 'agit validate', why: 'record the green base a publish needs' },
  { tool: 'Bash', command: 'agit publish agent/topic "message" --paths a,b --pr "title" --pr-body-file body.md', why: 'land work as a Verified commit' },
  { tool: 'Bash', command: 'agit status agent/topic', why: 'what the worktree holds that GitHub does not' },
  { tool: 'Bash', command: 'agit advance agent/topic', why: 'follow a branch that moved' },
  { tool: 'Bash', command: 'agit merge agent/topic', why: 'publish a resolved merge' },
  { tool: 'Bash', command: 'agit api GET /repos/o/r/pulls --paginate', why: 'every read of GitHub' },
  { tool: 'Bash', command: "agit graphql 'query { viewer { login } }'", why: 'Projects v2' },
  { tool: 'Bash', command: 'agit jobs https://github.com/o/r/actions/runs/1 --logs logs', why: 'why CI failed' },
  { tool: 'Bash', command: 'agit pr merge 12', why: 'merge a PR' },
  { tool: 'Bash', command: 'agit pr update 12', why: 'update a PR from its base' },
  { tool: 'Bash', command: 'agit issue read 12', why: 'read an issue' },
  { tool: 'Bash', command: 'agit issue create --title "t" --body-file body.md', why: 'open an issue' },
  { tool: 'Bash', command: 'agit issue comment 12 --body-file body.md', why: 'comment on an issue or PR' },
  { tool: 'Bash', command: 'agit issue close 12 --body-file body.md', why: 'close an issue' },
  { tool: 'Bash', command: 'agit issue edit 12 --body-file body.md --etag W/"x"', why: 'edit an issue body' },
  { tool: 'Bash', command: 'agit issue assign 12 --login someone', why: 'assign an issue' },
  { tool: 'Bash', command: 'agit issue label 12 --add bug', why: 'label an issue' },
  { tool: 'Bash', command: 'agit ci wait main', why: 'wait for CI' },
  { tool: 'Bash', command: 'agit maintainer status', why: 'what grant this session holds' },
  { tool: 'Bash', command: 'agit maintainer revoke', why: 'give a grant back' },
  { tool: 'Bash', command: 'agit maintainer off', why: 'give a grant back' },
  { tool: 'Bash', command: 'agit protected --changed', why: 'which dirty paths need a grant' },
  { tool: 'Bash', command: 'agit doctor', why: 'diagnose a refusal' },
  // --- git, read-only toward GitHub ---------------------------------------
  { tool: 'Bash', command: 'git fetch origin main', why: 'bring the base in for a merge, as the App' },
  { tool: 'Bash', command: 'git merge --no-commit origin/main', why: 'resolve a conflict for agit merge' },
  { tool: 'Bash', command: 'git add src/a.mjs', why: 'mark a conflict resolved' },
  { tool: 'Bash', command: 'git status', why: 'what is dirty' },
  { tool: 'Bash', command: 'git diff', why: 'what changed' },
  { tool: 'Bash', command: 'git log --oneline -5', why: 'what is here' },
  // --- the worktree lifecycle ---------------------------------------------
  { tool: 'EnterWorktree', why: 'every task starts in a worktree' },
  { tool: 'ExitWorktree', why: 'and ends by removing it' },
  { tool: 'Bash', command: 'git worktree add --detach .claude/worktrees/topic origin/main', why: 'a worktree without the tool' },
  { tool: 'Bash', command: 'git worktree list', why: 'clean-up check' },
  { tool: 'Bash', command: 'git worktree remove .claude/worktrees/topic', why: 'clean up a manual (detached) worktree' },
])

/**
 * verb, or `verb action`, → why no agent runs it as a tool call.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const NOT_AGENT = Object.freeze({
  setup: 'a human runs it: it opens a browser and creates a GitHub App',
  'setup app': 'a human runs it',
  'setup project': 'a human runs it',
  'maintainer grant': 'a human types it as `! agit …`, which no rule gates; an agent running it is refused',
  'maintainer on': 'as maintainer grant',
  credential: 'git runs it as the credential helper, not the agent',
  'credential get': 'as credential',
  hook: 'Claude Code runs the hooks, not the agent',
})

/**
 * Allow rules auto mode drops on entry because they grant arbitrary code
 * execution: the whole of Bash, interpreters, package-manager runners, Agent
 * and Monitor. They allow nothing there, so they must not count here. The
 * docs give examples, not a list; this errs toward dropping.
 */
const INTERPRETER = /^(python3?|node|deno|bun|ruby|perl|php|bash|sh|zsh|fish|env|eval|exec|sudo|xargs|npx|bunx|pnpx|uvx|(npm|pnpm|yarn|bun) (run|exec|x|dlx))\b/

/** @param {string} rule */
export function droppedInAutoMode(rule) {
  const r = parseRule(rule)
  if (r.tool === 'PowerShell') return r.spec === null || r.spec.trim() === '*'
  if (r.tool !== 'Bash') return ['Agent', 'Task', 'Monitor'].includes(r.tool)
  if (r.spec === null || /^\*?$/.test(r.spec.replace(/:\*$/, '*').trim())) return true
  return INTERPRETER.test(r.spec.replace(/\*.*$/, '').trim() + ' ')
}

/** `Tool` or `Tool(spec)`. @param {string} rule */
export function parseRule(rule) {
  const m = /^([^()]+?)(?:\((.*)\))?$/s.exec(String(rule).trim())
  return { tool: m?.[1] ?? '', spec: m?.[2] ?? null }
}

const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/**
 * Does a Bash rule's spec match one command? `*` matches anything, spaces
 * included; the space before a trailing `*` is part of the rule (`ls *` is
 * not `lsof`), and legacy `:*` means the same as ` *`. Read strictly: `git
 * status *` is not taken to match a bare `git status` — the docs do not say
 * it does, so a bare call needs its own rule.
 *
 * @param {string} spec
 * @param {string} command
 */
export function bashSpecMatches(spec, command) {
  const cmd = command.trim().replace(/\s+/g, ' ')
  const s = spec.trim().replace(/:\*$/, ' *')
  return new RegExp(`^${s.split('*').map(escape).join('.*')}$`, 's').test(cmd)
}

/**
 * @param {string} rule
 * @param {Call} call
 */
export function ruleMatches(rule, call) {
  const { tool, spec } = parseRule(rule)
  if (tool !== call.tool) return false
  if (spec === null || spec === '*') return true
  if (call.tool !== 'Bash') return false // a spec on a tool whose input is not a command: not ours to judge
  return bashSpecMatches(spec, call.command ?? '')
}

/**
 * What the rules of every layer, together, say about one call: deny beats
 * ask beats allow, in any layer. `none` means no rule decides — auto mode's
 * classifier will, or a prompt.
 *
 * @param {{ permissions?: { allow?: string[], ask?: string[], deny?: string[] } }[]} layers
 * @param {Call} call
 * @returns {{ verdict: 'deny' | 'ask' | 'allow' | 'none', rule?: string }}
 */
export function verdictFor(layers, call) {
  const rules = (key) => layers.flatMap((l) => l?.permissions?.[key] ?? []).map(String)
  for (const key of /** @type {const} */ (['deny', 'ask'])) {
    const rule = rules(key).find((r) => ruleMatches(r, call))
    if (rule) return { verdict: key, rule }
  }
  const rule = rules('allow').find((r) => !droppedInAutoMode(r) && ruleMatches(r, call))
  return rule ? { verdict: 'allow', rule } : { verdict: 'none' }
}

/** A call, as a rule would name it. @param {Call} call */
export const describeCall = (call) => (call.command ? `${call.tool}(${call.command})` : call.tool)

/**
 * The calls the layers do not explicitly allow, and why.
 *
 * @param {Parameters<typeof verdictFor>[0]} layers
 * @param {readonly Call[]} [calls]
 */
export function unallowedCalls(layers, calls = AGENT_CALLS) {
  return calls
    .map((call) => ({ call, ...verdictFor(layers, call) }))
    .filter((r) => r.verdict !== 'allow')
}

/**
 * The settings files Claude Code reads for a session in `root`, lowest first,
 * that exist. Managed settings are left out: a machine without them is the
 * case to plan for.
 *
 * @param {{ root: string, home?: string }} at
 * @returns {{ path: string, settings: any }[]}
 */
export function readSettingsLayers({ root, home = homedir() }) {
  return [join(home, '.claude', 'settings.json'), join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')]
    .filter((p) => existsSync(p))
    .map((path) => ({ path, settings: JSON.parse(readFileSync(path, 'utf8')) }))
}
