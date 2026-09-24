// @ts-check
/**
 * `agit hook <name>` — the Claude Code hook entry points.
 *
 * Each hook reads the event JSON on stdin and answers on stdout, per Claude
 * Code's hook protocol. They are verbs of the one binary so the settings that
 * wire them name `agit hook …` and nothing machine-specific: the same
 * `.claude/settings.json` works on every contributor's machine that has agit
 * on its PATH, and in the plugin's hooks.json.
 *
 *   guard-credentials   PreToolUse Bash                 keep off human credentials
 *   guard-protected     PreToolUse Bash, Write|Edit|…   CODEOWNERS paths need a grant
 *   guard-pr-writes     PreToolUse Bash                 merges go through `agit pr merge`
 *   sync-worktree       PostToolUse EnterWorktree       fast-forward a new worktree
 *
 * Failure posture, per hook: the guards fail OPEN on their own crash (a hook
 * that wedges every Bash call gets removed, and then guards nothing), except
 * that guard-pr-writes denies once it has matched a merge.
 */

export const HOOKS = {
  'guard-credentials': () => import('./guard-credentials.mjs'),
  'guard-protected': () => import('./guard-protected.mjs'),
  'guard-pr-writes': () => import('./guard-pr-writes.mjs'),
  'sync-worktree': () => import('./sync-worktree.mjs'),
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
  let mod
  try {
    mod = await load()
  } catch {
    process.exit(0) // a hook that cannot load has no opinion — fail open
  }
  await mod.main()
  process.exit(0)
}
