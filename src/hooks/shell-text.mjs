// @ts-check
/**
 * Shell TEXT helpers shared by the two Bash-scanning hooks.
 *
 * NOT a hook. Nothing dispatches to this file; it is the library
 * `guard-credentials.mjs` and `guard-protected.mjs` both import, and it lives
 * beside them because a helper that decides what a guard sees is part of the
 * guard.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS.
 *
 * Both hooks match SHAPES in a command string — a command word, a redirection,
 * an in-place flag — and both have the same failure mode: quoted text is data,
 * not shell, and a scanner that cannot tell the two apart denies
 * `grep -e "gh issue\|gh pr"` and `echo "see > .agit.json"`. In the harness agit
 * was ported from, the credential hook learned that first; the protected-file
 * guard shipped without it and reproduced the bug. One copy, here, so the
 * next hook does not make it a third time.
 *
 * Every function is pure and length-preserving where it masks, so an offset
 * into the masked text is the same offset into the original. That is what lets
 * a caller find a shape in the masked text and read the real token — a quoted
 * path is still a path — out of the raw command.
 */

/**
 * Blank out heredoc bodies: they are data, not commands. `python3 - <<'EOF' …
 * EOF` routinely contains prose or code that mentions blocked tools or names
 * control files, and scanning it produced denials of scripts that never ran a
 * shell command at all. The delimiter is captured verbatim so a body ends only
 * at its own terminator.
 *
 * Newlines inside the body are masked too, so a masked body can never split
 * into command segments.
 */
export function maskHeredocs(cmd) {
  return cmd.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([\s\S]*?)^\t*\2$/gm,
    (m, _q, tag, body) =>
      m.slice(0, m.length - body.length - tag.length) + '\0'.repeat(body.length) + tag,
  )
}

/**
 * Blank out quoted spans so their contents can't be mistaken for shell syntax.
 *
 * This is the fix for the false positive that made an early credential hook
 * self-defeating: `grep -e "gh issue\|gh pr" file` was DENIED, because the `|`
 * inside the pattern read as a pipe and the following `gh` as a command word. A
 * hook that blocks ordinary greps gets switched off within a day, so quoted text
 * is treated as data — never as commands.
 *
 * Replacement preserves length (so offsets stay meaningful) and uses a character
 * that can never appear in a command word. The quote characters themselves are
 * kept, so a masked token still LOOKS quoted to a tokenizer.
 */
export function maskQuoted(cmd) {
  cmd = maskHeredocs(cmd)
  let out = ''
  let quote = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      if (ch === '\\' && quote === '"') {
        out += '\0\0'
        i++
        continue
      }
      if (ch === quote) {
        quote = null
        out += ch
        continue
      }
      out += '\0'
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    out += ch
  }
  return out
}

/**
 * Contents of `sh -c '<payload>'` / `bash -c "<payload>"` / `zsh -c …`.
 *
 * Those payloads ARE commands, so callers scan them recursively — otherwise
 * `bash -c "gh issue list"` walks straight through a hook that only looks at the
 * outer command. This is the one place quoted text is not treated as data.
 *
 * Returned RAW (quotes intact inside): a caller masks each one itself, exactly
 * as it masks the outer command.
 */
export function shellPayloads(cmd) {
  const payloads = []
  const re = /\b(?:ba|z|k|da)?sh\s+(?:-[a-zA-Z]+\s+)*-c\s*(['"])([\s\S]*?)\1/g
  for (const m of cmd.matchAll(re)) payloads.push(m[2])

  // A heredoc fed to a SHELL is executed, so `bash <<'EOF' … gh … EOF` must be
  // scanned. One fed to anything else (python3, cat, jq) is data — masked by
  // maskHeredocs and deliberately not scanned.
  const hd =
    /(?:^|[;&|(\n])\s*(?:\w+=\S+\s+)*(?:ba|z|k|da)?sh\b[^\n<]*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([\s\S]*?)^\t*\2$/gm
  for (const m of cmd.matchAll(hd)) payloads.push(m[3])
  return payloads
}

/**
 * The separators between STATEMENTS: `;`, `&&`, `||`, newline. A pipe is not
 * one — the stages of a pipeline are one command whose output flows on.
 *
 * `git config --get gpg.ssh.program; git config gpg.ssh.program op-ssh-sign` is
 * two statements, and a verdict on the first must not launder the second
 * `git config --list | grep gpg.ssh.program` is one.
 */
const STATEMENT_SEP = /\n|;|&&|\|\||(?<![|&])[&](?![&])/g

/**
 * The separators between SEGMENTS: every statement separator AND a pipe. This
 * is the split a write-shape scanner wants, because `cat x | sed -i … file` is
 * two commands with two argument lists.
 */
const SEGMENT_SEP = /\n|;|&&|\|\||\||(?<![|&])[&](?![&])/g

function splitWithOffsets(text, sep) {
  const out = []
  let last = 0
  for (const m of text.matchAll(sep)) {
    out.push({ text: text.slice(last, m.index), start: last })
    last = m.index + m[0].length
  }
  out.push({ text: text.slice(last), start: last })
  return out
}

/**
 * Statements of a (masked) command, as `{ text, start }` — `start` is the
 * offset of `text` in the input, so a caller holding the raw command can read
 * the unmasked text of any statement back.
 */
export function statements(masked) {
  return splitWithOffsets(masked, STATEMENT_SEP)
}

/** Segments of a (masked) command — statements further split at each pipe. */
export function segments(masked) {
  return splitWithOffsets(masked, SEGMENT_SEP)
}

/**
 * Whitespace-delimited tokens of one masked segment, each carrying its RAW
 * text from the original command. Because masking preserves length and blanks
 * the inside of every quoted span (spaces included), tokenizing the masked
 * text on whitespace splits exactly where the shell would, and the raw slice
 * at the same offsets is the token as typed — quotes and all.
 */
export function tokens(segment, raw) {
  const out = []
  for (const m of segment.text.matchAll(/\S+/g)) {
    const start = segment.start + m.index
    out.push({ masked: m[0], raw: raw.slice(start, start + m[0].length) })
  }
  return out
}
