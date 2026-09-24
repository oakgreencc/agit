// @ts-check
/**
 * Where a closing keyword has to be written so that it actually closes.
 *
 * GitHub has two auto-close paths:
 *
 *   - **PR body.** Fires when THAT PULL REQUEST merges into the DEFAULT branch.
 *     When agent PRs target another branch (a develop → main flow), this path
 *     never fires: every `Closes #N` in such a PR body is inert.
 *   - **Commit message.** Fires when the COMMIT reaches the default branch,
 *     which the next promotion delivers. This path works either way.
 *
 * In the tracker agit was ported from, every issue that closed itself had a
 * `commit_id` on its close event, and seven PRs whose bodies said `Closes #N`
 * merged into the integration branch and left their issues open — the
 * promotion's merge commit carried only a bare `(#N)` reference.
 *
 * So the refs an agent writes in the PR body are lifted into the commit
 * `agit publish` creates. The issue then closes when the commit reaches the
 * default branch, not when the PR merges — a delay, not a failure, and
 * arguably the more honest moment to call something done.
 */

/**
 * GitHub's documented closing keywords. Kept as one alternation so the two
 * regexes below cannot drift apart.
 */
const KEYWORD = String.raw`close[sd]?|fix(?:e[sd])?|resolve[sd]?`

/**
 * A closing keyword followed by an issue reference.
 *
 * The cross-repo form is captured WHOLE (`acme/wiki#48`, not `#48`) and
 * re-emitted verbatim. Normalising it to a bare `#48` would silently retarget
 * the keyword at issue 48 of THIS repo — a wrong issue closed automatically,
 * which is the one failure mode here that is worse than doing nothing.
 *
 * Full-URL references (`Fixes https://github.com/o/r/issues/1`) are valid to
 * GitHub but deliberately not matched: nothing in this repo writes them, and a
 * URL matcher is where an over-eager regex would start finding refs inside
 * prose links.
 */
const CLOSING = new RegExp(
  String.raw`\b(?:${KEYWORD})\b\s*:?\s+((?:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+)?#\d+)`,
  'gi',
)

/**
 * Extract every closing reference from a block of text, in first-seen order.
 *
 * This is the raw scan and knows nothing about markdown. Against a commit
 * message that is exactly right — it only decides what is already present, and
 * over-matching there is harmless. Against a PR body it is the wrong entry
 * point, because a body may quote a keyword without meaning it: use
 * {@link partitionBodyRefs}, which runs this over a masked copy.
 *
 * @param {string} [text]
 * @returns {string[]} refs such as `#82` or `acme/wiki#48`, deduplicated
 */
export function parseClosingRefs(text) {
  if (!text) return []
  const seen = new Set()
  const refs = []
  for (const m of text.matchAll(CLOSING)) {
    // Matching is case-insensitive, so two spellings of the same cross-repo ref
    // differ only in the owner segment's case. Dedupe on a lowercased key but
    // emit the first spelling seen, so the owner/repo half survives as written.
    const ref = m[1]
    const key = ref.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

/**
 * The character quoted regions are replaced with.
 *
 * Deliberately NOT a space. `CLOSING` ends in `\s*:?\s+`, so a whitespace mask
 * is transparent to it: a keyword left dangling at the end of a line before a
 * masked block would bind straight through to the next `#123` after it, and
 * MANUFACTURE a closing ref that appears nowhere in the source —
 *
 *     What this fixes:
 *
 *     ```
 *     a stack trace
 *     ```
 *
 *     #82 is the tracking issue.
 *
 * — which is worse than the bug this module is fixing, because the invented ref
 * is in `lift` rather than `quoted` and so is never printed. A NUL is neither
 * whitespace nor a word character, so it terminates the match instead of
 * bridging it, and `partitionBodyRefs` asserts the invariant besides.
 */
const MASK = '\u0000'

/**
 * Blank out every code span in `text`, preserving length and line breaks.
 *
 * CommonMark's rules, both of which matter here: a run of N backticks opens a
 * span and the next run of EXACTLY N closes it, and a code span may not contain
 * a blank line. A run with no matching partner inside its own paragraph is
 * literal backtick and opens nothing — so a stray backtick cannot swallow a
 * `Closes #82` three paragraphs later.
 *
 * Length is preserved rather than the region deleted so that masking cannot
 * join two lines, or two words, that were separate in the source.
 *
 * @param {string} text
 * @returns {string}
 */
function maskCodeSpans(text) {
  const runs = [...text.matchAll(/`+/g)].map((m) => ({ start: m.index, len: m[0].length }))
  // `split('')` and not `[...text]`: match offsets are UTF-16 code units, and a
  // code-point array would drift by one per astral character — an emoji earlier
  // in the body (this repo mandates a 🤖 footer) would slide the mask window off
  // the span it is meant to cover.
  const out = text.split('')
  let i = 0
  while (i < runs.length) {
    const open = runs[i]
    let j = i + 1
    while (j < runs.length && runs[j].len !== open.len) j++
    // No partner, or the only partner is past a paragraph break — and so is
    // everything after it. Literal backticks; nothing to mask. The next run is
    // still a candidate opener, so advance by one rather than giving up.
    if (j >= runs.length || /\n[ \t]*\n/.test(text.slice(open.start + open.len, runs[j].start))) {
      i++
      continue
    }
    const close = runs[j]
    for (let k = open.start; k < close.start + close.len; k++) {
      if (out[k] !== '\n') out[k] = MASK
    }
    i = j + 1
  }
  return out.join('')
}

/**
 * Blank out the parts of a PR body a reader understands as quoting rather than
 * doing: fenced code blocks, blockquotes, and code spans.
 *
 * The order is the one CommonMark uses — fences and blockquotes are decided per
 * line, before any inline parsing, so a ``` opener inside a blockquote is not a
 * fence for the document. Where the two rules disagree the masking is
 * deliberately generous: an unterminated fence runs to the end of the document,
 * masking everything after it. Over-masking loses a lift, which the caller
 * PRINTS; under-masking closes a live issue silently, which is the bug this module exists to fix.
 *
 * Not handled, on purpose: four-space indented code blocks. In a PR body a
 * four-space indent is far more often a wrapped list item than code, so
 * treating it as code would cost real lifts for no observed benefit.
 *
 * @param {string} text
 * @returns {string} the same text with quoted regions replaced by {@link MASK}
 */
function maskQuoted(text) {
  /** @type {{ char: string, len: number } | null} */
  let fence = null
  const lines = text.split('\n').map((line) => {
    const blank = MASK.repeat(line.length)
    const delim = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      // A closing fence is the same character, at least as long, and carries
      // nothing but whitespace after it.
      if (delim && delim[1][0] === fence.char && delim[1].length >= fence.len && !delim[2].trim())
        fence = null
      return blank
    }
    if (delim) {
      // A backtick fence's info string may not itself contain a backtick.
      if (delim[1][0] === '`' && delim[2].includes('`')) return line
      fence = { char: delim[1][0], len: delim[1].length }
      return blank
    }
    if (/^ {0,3}>/.test(line)) return blank
    return line
  })
  return maskCodeSpans(lines.join('\n'))
}

/**
 * Split a PR body's closing references into the ones the author meant and the
 * ones they merely quoted.
 *
 * Discussing another ticket in a PR body is normal and desirable — "this is not
 * #N", a postmortem quoting a previous commit message, a fenced block showing
 * what a commit carried. Before this masking, every one of those closed the issue it
 * named, on the next promotion to `main`, with no way to see it had happened.
 *
 * `quoted` is returned rather than discarded because dropping it silently is
 * the same silence pointed the other way: a keyword written only inside
 * backticks would vanish with no trace. The caller prints both.
 *
 * @param {string} [prBody]
 * @returns {{ lift: string[], quoted: string[] }} `lift` is what to write into
 *   the commit; `quoted` is what was found only in a quoting context.
 */
export function partitionBodyRefs(prBody) {
  if (!prBody) return { lift: [], quoted: [] }
  const raw = parseClosingRefs(prBody)
  // Masking only ever REMOVES text, so anything the masked scan finds must also
  // be in the raw scan. Enforced rather than assumed: a mask that let a keyword
  // bind across the region it blanked would invent a ref the author never
  // wrote, and inventing one is the only outcome here worse than the bug.
  const rawKeys = new Set(raw.map((r) => r.toLowerCase()))
  const lift = parseClosingRefs(maskQuoted(prBody)).filter((r) => rawKeys.has(r.toLowerCase()))
  const lifted = new Set(lift.map((r) => r.toLowerCase()))
  const quoted = raw.filter((r) => !lifted.has(r.toLowerCase()))
  return { lift, quoted }
}

/**
 * Normalise a `--closes` flag value into refs.
 *
 * Accepts what an agent would plausibly type: `82`, `#82`, `82,196`,
 * `#82, #196`, `acme/wiki#48`. Rejects nothing silently — an entry that
 * does not look like a reference throws, because a typo'd `--closes` that
 * quietly closed nothing would reproduce the exact bug this module exists to
 * fix.
 *
 * @param {string} [value]
 * @returns {string[]}
 */
export function parseClosesFlag(value) {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^((?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)?)#?(\d+)$/.exec(s)
      if (!m)
        throw new Error(
          `--closes: "${s}" is not an issue reference (want 82, #82, or owner/repo#82)`,
        )
      return `${m[1]}#${m[2]}`
    })
}

/**
 * Build the commit message that actually closes what the PR says it closes.
 *
 * Refs already present in the message are left alone rather than repeated —
 * an agent that has already learned to write the trailer should not get it
 * twice.
 *
 * @param {object} args
 * @param {string} args.message   the commit message as passed to agit publish
 * @param {string} [args.prBody]  the PR body, scanned for refs to lift
 * @param {string} [args.closes]  raw `--closes` flag value
 * @returns {{ message: string, added: string[], skipped: string[] }} the
 *   message to commit, which refs were appended, and which the body named only
 *   inside a quoting context and will therefore NOT close. The caller logs both
 *   so neither a lift nor a non-lift is invisible.
 */
export function withClosingTrailers({ message, prBody, closes }) {
  const already = new Set(parseClosingRefs(message).map((r) => r.toLowerCase()))

  // `--closes` is the explicit path the convention tells everyone to use, so it
  // goes first and wins unconditionally — over prose, and over a body that
  // quotes some other ref entirely.
  const { lift, quoted } = partitionBodyRefs(prBody)
  const wanted = [...parseClosesFlag(closes), ...lift]
  const added = []
  for (const ref of wanted) {
    const key = ref.toLowerCase()
    if (already.has(key)) continue
    already.add(key)
    added.push(ref)
  }

  // A quoted ref that ends up closing anyway — named by `--closes`, or already
  // a trailer on the commit — was not skipped in any sense the reader cares
  // about, so do not report it.
  const skipped = quoted.filter((r) => !already.has(r.toLowerCase()))

  if (!added.length) return { message, added, skipped }

  // A blank line before the trailers keeps them out of the headline, which is
  // all `git log --oneline` and the GitHub commit list show.
  const trailer = added.map((r) => `Closes ${r}.`).join('\n')
  return { message: `${message.replace(/\s+$/, '')}\n\n${trailer}`, added, skipped }
}
