// @ts-check
/**
 * CODEOWNERS, read the way GitHub reads it — because it is the manifest.
 *
 * agit protects exactly what the project's CODEOWNERS says a human must
 * approve. That makes one list serve both halves of the arrangement:
 *
 *   - on GitHub, with "require review from Code Owners" on the base branch's
 *     ruleset, it is the BOUNDARY: a PR touching an owned path cannot merge
 *     without the owner, whatever an agent does locally;
 *   - locally, it is the TRIPWIRE in front of that boundary: the edit is
 *     refused at the first keystroke, and the human decides before the work
 *     instead of discovering it at review.
 *
 * The SeKtor harness this was ported from kept a second, hand-written list and
 * a CI check that the two had not drifted. Reading CODEOWNERS directly deletes
 * that problem: there is nothing to drift from.
 *
 * Semantics, per GitHub's documentation, which is gitignore's with exceptions:
 *
 *   - the LAST matching line wins, and a line with no owners un-owns;
 *   - `/x` is anchored at the root; a pattern with a `/` anywhere but the end
 *     is anchored too; otherwise it matches at any depth;
 *   - `x/` matches a directory (so, everything under it) and never a file;
 *   - a pattern that matches a directory owns everything below it, EXCEPT one
 *     whose last segment is a bare `*` — `docs/*` owns `docs/a.md`, not
 *     `docs/sub/b.md`;
 *   - `*` and `?` never cross `/`; `**` does;
 *   - `!` negation and `[...]` ranges are not supported by GitHub. A line using
 *     them is reported as unsupported and never matches, so it cannot silently
 *     protect less than it appears to.
 */

/** Where GitHub looks, in the order it looks. The first that exists is the file. */
export const CODEOWNERS_LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']

/**
 * @typedef {{ pattern: string, owners: string[], line: number, re: RegExp | null, unsupported?: string }} Rule
 */

const escape = (s) => s.replace(/[.+^${}()|\\]/g, '\\$&')

/**
 * One pattern → an anchored regex over repo-relative POSIX file paths.
 * Returns `null` for syntax GitHub does not support.
 *
 * @param {string} pattern
 * @returns {RegExp | null}
 */
export function patternToRegExp(pattern) {
  let p = pattern
  if (p.startsWith('!') || /\[[^\]]*\]/.test(p)) return null
  const dirOnly = p.endsWith('/') && p !== '/'
  if (dirOnly) p = p.slice(0, -1)
  let anchored = p.startsWith('/')
  if (anchored) p = p.slice(1)
  if (p.includes('/') && !p.startsWith('**/')) anchored = true
  if (!p) return /^.*$/ // `/` alone: everything

  const segments = p.split('/')
  const lastIsStar = segments.length > 1 && segments[segments.length - 1] === '*'

  let body = ''
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const last = i === segments.length - 1
    if (seg === '**') {
      // `**/` at the front or in the middle: zero or more directories.
      // `/**` at the end: everything inside.
      body += last ? '.*' : '(?:[^/]+/)*'
      continue
    }
    body += seg
      .split('')
      .map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : escape(ch)))
      .join('')
    if (!last) body += '/'
  }

  const prefix = anchored ? '^' : '^(?:.*/)?'
  // What may follow the matched part: a directory match owns its contents.
  const suffix = dirOnly ? '/.+$' : lastIsStar ? '$' : '(?:/.*)?$'
  return new RegExp(prefix + body + suffix)
}

/**
 * Parse CODEOWNERS text into rules, in file order. Comments, blank lines and
 * `\#`-escaped leading hashes follow GitHub. Owners are the `@user`,
 * `@org/team` and email tokens after the pattern.
 *
 * @param {string} text
 * @returns {Rule[]}
 */
export function parseCodeowners(text) {
  const rules = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    if (/^\s*#/.test(line)) continue
    // An unescaped ` #` starts a trailing comment.
    line = line.replace(/(^|\s)#.*$/, '$1').trim()
    if (!line) continue
    const [rawPattern, ...owners] = line.split(/\s+/)
    const pattern = rawPattern.replace(/^\\#/, '#')
    const re = patternToRegExp(pattern)
    rules.push({
      pattern,
      owners: owners.filter((o) => o.startsWith('@') || o.includes('@')),
      line: i + 1,
      re,
      ...(re ? {} : { unsupported: `line ${i + 1}: \`${pattern}\` uses syntax GitHub ignores` }),
    })
  }
  return rules
}

/**
 * The rule that decides `path` — the last one matching — or `null`.
 *
 * @param {Rule[]} rules
 * @param {string} path repo-relative POSIX path
 */
export function decidingRule(rules, path) {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (rules[i].re?.test(path)) return rules[i]
  }
  return null
}

/**
 * The owners of `path` (after the last-match rule), narrowed to `only` when
 * given. `[]` means unowned — including a path whose deciding line names no
 * owners, or names only owners outside `only`.
 *
 * @param {Rule[]} rules
 * @param {string} path
 * @param {string[]} [only]
 */
export function ownersOf(rules, path, only = []) {
  const rule = decidingRule(rules, path)
  if (!rule) return []
  if (!only.length) return rule.owners
  const want = new Set(only.map((o) => o.toLowerCase()))
  return rule.owners.filter((o) => want.has(o.toLowerCase()))
}

/**
 * The CODEOWNERS text GitHub would use, via `read(path)` (which returns the
 * file's text or throws/returns null when absent). `{ path: null }` when none.
 *
 * @param {(path: string) => string | null} read
 * @returns {{ path: string | null, text: string }}
 */
export function findCodeowners(read) {
  for (const path of CODEOWNERS_LOCATIONS) {
    let text = null
    try {
      text = read(path)
    } catch {
      text = null
    }
    if (typeof text === 'string') return { path, text }
  }
  return { path: null, text: '' }
}
