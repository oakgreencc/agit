// @ts-check
/**
 * PreToolUse hook — refuse to WRITE a protected path unless a human granted it.
 *
 *   agit hook guard-protected      (matchers: Bash, and Write|Edit|MultiEdit|NotebookEdit)
 *
 * "Protected" is whatever CODEOWNERS says a human must approve (plus
 * `.agit.json`'s `protected.extra`, plus the files that define the protection
 * itself) — see src/protected.mjs. The grant is maintainer mode's `protected`
 * scope — see src/maintainer.mjs.
 *
 * ---------------------------------------------------------------------------
 * WHY, WHEN CODEOWNERS ALREADY GATES THE MERGE.
 *
 * CODEOWNERS catches it at review, which is the right place for enforcement
 * and the wrong place for discovery. An agent that rewrote the CI gate while
 * doing something else has spent the session's effort by then, and the human
 * first learns of it from a diff they did not expect. This hook moves that to
 * the first keystroke: the edit is refused, the agent asks, and the human
 * decides before the work rather than after it.
 *
 * It does not try to be unbypassable. The boundary is CODEOWNERS on GitHub;
 * this is the tripwire in front of it. `agit publish` checks the same policy
 * again, read from the BASE branch, as a second tripwire for writes this hook
 * cannot see.
 *
 * ---------------------------------------------------------------------------
 * THE BASH HALF.
 *
 * A guard wired only to the file tools guards against `Edit` and not against
 * `sed -i`. That is not a hostile-agent problem — it is DRIFT: the tripwire's
 * value is that every deliberate protected edit stays an explicit, granted
 * act. So `writeTargets` matches WRITE SHAPES — redirection, `sed -i`, `tee`,
 * `cp`/`mv`/`install`, `rm`, `dd of=`, in-place `perl`/`ruby`, a scripting
 * one-liner's `open(path, 'w')` — and asks the policy about the paths they
 * name. It does not parse shell; an obfuscated write gets through, as an
 * obfuscated anything does.
 *
 * The cases that must NOT fire matter more. Running, reading, grepping or
 * `git log`-ing a protected file is the most common thing anyone does with
 * one, and a guard that blocks those gets disabled within the hour. In the
 * harness agit was ported from that happened anyway, once: an unanchored
 * `-[A-Za-z]*i` matched inside filenames, so `sed -n 1,40p` was refused on the
 * very files the guard protects. Hence: quoted text is DATA (masked before any
 * shape is matched), and a flag is a TOKEN starting with `-`, never a
 * substring of a filename.
 *
 * ---------------------------------------------------------------------------
 * WHAT ONLY A HUMAN MAY DO, WITH OR WITHOUT A GRANT.
 *
 *   - run `agit maintainer grant` — a grant the agent issues itself is not a
 *     human's decision. The human types it with Claude Code's `!` prefix,
 *     which is not a tool call and never reaches this hook.
 *   - write into `.git/agit/` — the grant file and its log live there.
 *   - write an `impossible` path — the App cannot, so no grant can help.
 *
 * WHERE A FILE IS. Each path is resolved against the event's `cwd` and judged
 * by its position in its OWN checkout (the nearest `.git`), so a file in any
 * worktree, wherever the harness put it, is judged correctly. The harness agit
 * was ported from stripped one hard-coded worktree prefix, and the guard was
 * silently off for every session whose worktree lived anywhere else.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { allows, grantAdvice, grantPath, readGrant } from '../maintainer.mjs'
import { createPolicy, normalise, policyAtRoot, resolveTarget } from '../protected.mjs'
import { maskQuoted, segments, shellPayloads, tokens } from './shell-text.mjs'

/** Tools whose `file_path` (or `notebook_path`) input is a write. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

/** Strip one layer of surrounding quotes from a shell token. */
const unquote = (t) => t.replace(/^['"]|['"]$/g, '')

/** Looks like a path rather than a flag or an operator. */
const pathish = (t) => !!t && !t.startsWith('-') && /[/.]/.test(t) && !/^[|&;<>]+$/.test(t)

/** A token is a FLAG only if it starts with `-`. */
const isFlag = (t) => t.startsWith('-')

/** The in-place flag of `sed`/`perl`/`ruby`: a short cluster with `i`, or GNU's long form. */
const IN_PLACE_FLAG = /^-[A-Za-z]*i|^--in-place\b/

/** The unquoted expression argument of `sed -i 's/…/…/' file` — not a path. */
const SED_EXPRESSION = /^s[/|,#]/

const verb = (words) => new RegExp(`^(?:[\\w./~-]*/)?(?:${words})$`)
const verbIndex = (toks, re) => toks.findIndex((t) => re.test(t.masked))
const EDITOR = verb('sed|perl|ruby')
const MOVER = verb('cp|mv|install')
const REMOVER = verb('rm|unlink|truncate')

/**
 * Paths a command WRITES, as named by well-known write shapes. A path merely
 * mentioned — an argument to `node`, `cat`, `grep`, `git log` — is not
 * returned. Shapes are matched on the MASKED command; the path is read back
 * from the RAW command at the same offset, so a quoted path is still a path.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function writeTargets(command) {
  const out = []
  const add = (t) => {
    const p = unquote(t ?? '')
    if (pathish(p)) out.push(p)
  }
  const masked = maskQuoted(command)
  const rawAt = (m, group) =>
    command.slice(m.index + m[0].length - m[group].length, m.index + m[0].length)

  // `> path`, `>> path`, `2> path`, `&> path`.
  for (const m of masked.matchAll(/(?:^|[^0-9<>&])(?:[0-9]|&)?>>?\s*(['"]?[^\s;|&<>()]+['"]?)/g))
    add(rawAt(m, 1))

  // `dd of=path`
  for (const m of masked.matchAll(/\bdd\b[^\n;|&]*?\bof=(['"]?[^\s;|&]+['"]?)/g)) add(rawAt(m, 1))

  // `tee path`, `tee -a path`
  for (const m of masked.matchAll(/\btee\b\s+(?:-\S+\s+)*(['"]?[^\s;|&<>()]+['"]?)/g))
    add(rawAt(m, 1))

  for (const seg of segments(masked)) {
    const toks = tokens(seg, command)

    // In-place editors rewrite each file they are handed. The flag must be a
    // FLAG TOKEN after the verb, never a substring of a filename.
    const editor = verbIndex(toks, EDITOR)
    if (editor >= 0) {
      const args = toks.slice(editor + 1)
      if (args.some((t) => isFlag(t.masked) && IN_PLACE_FLAG.test(t.masked))) {
        for (const t of args) if (!isFlag(t.masked) && !SED_EXPRESSION.test(t.masked)) add(t.raw)
      }
    }

    // `cp src dst` / `install … dst`: the last path is written. `mv` (and
    // `git mv`) writes BOTH: the source is destroyed.
    const mover = verbIndex(toks, MOVER)
    if (mover >= 0) {
      const args = toks.slice(mover + 1).filter((t) => !isFlag(t.masked))
      if (toks[mover].masked.endsWith('mv')) for (const t of args) add(t.raw)
      else if (args.length >= 2) add(args[args.length - 1].raw)
    }

    // Removal is a write.
    const remover = verbIndex(toks, REMOVER)
    if (remover >= 0) for (const t of toks.slice(remover + 1)) if (!isFlag(t.masked)) add(t.raw)
  }

  // Scripting one-liners that open a file for writing. Scanned RAW — the path
  // is the quoted string. A read (`open(path).read()`) is not matched.
  for (const m of command.matchAll(
    /\bopen\(\s*(['"])([^'"\n]+)\1\s*,\s*(?:mode\s*=\s*)?['"][wax]/g,
  ))
    add(m[2])
  for (const m of command.matchAll(/\bPath\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/g))
    add(m[2])
  for (const m of command.matchAll(/\b(?:writeFile|appendFile)(?:Sync)?\(\s*(['"])([^'"\n]+)\1/g))
    add(m[2])

  // `sh -c '…'` runs its payload; scan it as the command it is.
  for (const payload of shellPayloads(command)) out.push(...writeTargets(payload))

  return out
}

/** `agit` as a command word — bare, by path, or `node …/agit.mjs`. */
const AGIT_WORD = /^(?:[\w./~-]*\/)?agit(?:\.mjs)?$/

/** Maintainer subcommands an agent may run: reading and giving up a grant. */
const AGENT_MAINTAINER_OK = new Set(['status', 'revoke', 'help', '--help', '-h'])

/**
 * Does this command run `agit maintainer <something other than status/revoke>`?
 * Masked-quote aware, and `sh -c` payloads are scanned: `echo "agit maintainer
 * grant"` is text, `bash -c "agit maintainer grant x"` is a grant.
 *
 * @param {string} command
 */
export function grantsItself(command) {
  const check = (cmd) => {
    const masked = maskQuoted(cmd)
    for (const seg of segments(masked)) {
      const toks = tokens(seg, cmd)
      for (let i = 0; i < toks.length; i++) {
        if (!AGIT_WORD.test(toks[i].masked)) continue
        const rest = toks.slice(i + 1).map((t) => unquote(t.raw))
        // `agit [-C dir] maintainer …` — the subcommand is the word after it.
        const at = rest.indexOf('maintainer')
        if (at < 0 || at > 2) continue
        const sub = rest[at + 1] ?? 'status'
        if (!AGENT_MAINTAINER_OK.has(sub)) return true
      }
    }
    return false
  }
  return check(command) || shellPayloads(command).some(check)
}

/** Inside a clone's `.git/agit/` — the grant file and its log. */
const AGIT_STATE = /(?:^|\/)\.git\/agit(?:\/|$)/
export const isAgitState = (path) => AGIT_STATE.test(String(path).replace(/\\/g, '/'))

/**
 * @typedef {{ rel: string, policy: import('../protected.mjs').Policy, grant: import('../maintainer.mjs').GrantView }} Lookup
 * @typedef {(path: string, cwd: string) => Lookup | null} LookupFn
 */

/** The one description of an impossible refusal. */
function impossibleReason(hit, how = '') {
  return (
    `\`${hit.path}\` ${hit.why}${how}.\n\n` +
    'No grant unlocks this: the App does not hold the permission to write it (for\n' +
    '`.github/workflows/**`, the Workflows permission is withheld on purpose), so GitHub\n' +
    'would refuse the publish regardless. Describe the exact patch and hand it to the\n' +
    'human to apply.'
  )
}

const STATE_REASON =
  "`.git/agit/` holds the maintainer grant and its log. Only a human writes there, through\n" +
  '`agit maintainer grant` — a grant an agent writes for itself is not a decision anyone made.'

/**
 * `null` to allow, or a reason to deny, for one written path.
 *
 * @param {{ path: string, cwd: string, lookup: LookupFn, how?: string }} input
 */
function judgePath({ path, cwd, lookup, how = '' }) {
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  if (isAgitState(abs) || isAgitState(path)) return STATE_REASON
  const found = lookup(path, cwd)
  if (!found) return null // outside any checkout: not ours to judge
  const hit = found.policy.check(found.rel)
  if (!hit) return null
  if (hit.tier === 'impossible') return impossibleReason(hit, how)
  if (allows(found.grant, 'protected')) return null
  return (
    `\`${hit.path}\` is protected — ${hit.why}${how}. It decides what the gates catch, what an\n` +
    'agent may do, or what reaches production, so a human decides when it changes.\n\n' +
    'Reading or running it is always fine; writing it is the granted act.\n' +
    `${grantAdvice(found.grant, 'protected')}\n` +
    'The grant lets you write the change, not land it: CODEOWNERS still requires the\n' +
    "owner's review on the PR. Do not route around this with a different shell shape; if\n" +
    'the refusal is wrong — the path is not really written — say so instead.'
  )
}

/**
 * `null` to allow, or a reason to deny, for a file tool.
 *
 * @param {{ tool: string, filePath?: string, cwd: string, lookup: LookupFn }} input
 */
export function verdict({ tool, filePath, cwd, lookup }) {
  if (!WRITE_TOOLS.has(tool) || !filePath) return null
  return judgePath({ path: filePath, cwd, lookup })
}

/**
 * `null` to allow, or a reason to deny, for a Bash command.
 *
 * @param {{ command?: string, cwd: string, lookup: LookupFn }} input
 */
export function bashVerdict({ command, cwd, lookup }) {
  if (!command) return null
  if (grantsItself(command))
    return (
      'Only a human grants maintainer mode. Ask them to run it — they type it, with the\n' +
      "`!` prefix in Claude Code, which is not a tool call:\n\n" +
      '    ! agit maintainer grant "<why this session needs it>" --scope <scope>\n\n' +
      'Say which scope you need (protected, no-verify, merge) and why.'
    )
  for (const path of writeTargets(command)) {
    const reason = judgePath({ path, cwd, lookup, how: ' (named by a shell write)' })
    if (reason) return reason
  }
  return null
}

/**
 * The real lookup: nearest checkout, its policy from disk, its grant as
 * `session` sees it. Memoised per checkout for the life of one hook call.
 *
 * @param {string | null | undefined} session
 * @returns {LookupFn}
 */
export function makeLookup(session) {
  const cache = new Map()
  return (path, cwd) => {
    const loc = resolveTarget(path, cwd)
    if (!loc) return null
    let entry = cache.get(loc.root)
    if (!entry) {
      let policy
      try {
        policy = policyAtRoot(loc.root)
      } catch {
        // An unreadable .agit.json still self-protects: the defaults do.
        policy = createPolicy({})
      }
      let grant = /** @type {import('../maintainer.mjs').GrantView} */ ({ state: 'none' })
      try {
        const d = execFileSync('git', ['-C', loc.root, 'rev-parse', '--git-common-dir'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim()
        grant = readGrant({ path: grantPath(resolve(loc.root, d)), session: session ?? null })
      } catch {
        // No grant readable is no grant.
      }
      entry = { policy, grant }
      cache.set(loc.root, entry)
    }
    return { rel: normalise(loc.rel), ...entry }
  }
}

export async function main() {
  let event
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return // unreadable event: no opinion
  }
  let reason = null
  try {
    const cwd = event.cwd ?? process.cwd()
    // Judged as the session making THIS tool call.
    const lookup = makeLookup(event.session_id ?? process.env.CLAUDE_CODE_SESSION_ID)
    const tool = event.tool_name
    reason =
      tool === 'Bash'
        ? bashVerdict({ command: event.tool_input?.command, cwd, lookup })
        : verdict({
            tool,
            filePath: event.tool_input?.file_path ?? event.tool_input?.notebook_path,
            cwd,
            lookup,
          })
  } catch {
    return // a bug in here must not wedge the session
  }
  if (!reason) return
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
}
