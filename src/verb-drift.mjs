// @ts-check
/**
 * The `agit` invocations a markdown file tells an agent to run, and which of
 * them agit does not have — the doc drift gate. `test/verb-drift.test.mjs`
 * runs it over the skill, the README and docs/.
 *
 * Only code is read: fenced blocks (minus shell comments) and inline code
 * spans. Prose says "agit runs your hooks" and means no verb, and so does a
 * double-quoted string inside code (`echo "agit is not on PATH"`). An
 * invocation is `agit` then a lowercase word; anything else after it
 * (`--version`, `<verb>`) names nothing.
 */
import { SUBVERBS, VERBS } from './cli/verbs.mjs'
import { HOOKS } from './hooks/index.mjs'

/** noun → the actions it takes, `hook` included. */
const ACTIONS = { ...SUBVERBS, hook: Object.keys(HOOKS) }

const WORD = /^[a-z][a-z-]*$/
const INVOCATION = /\bagit[ \t]+(\S+)(?:[ \t]+(\S+))?/g
const FENCE = /^\s*(```|~~~)/
const SHELL_COMMENT = /(^|\s)#(?!\d).*$/
const INLINE_CODE = /(`+)(.+?)\1/g
const TRAILING = /[`'",;:)|]+$/
const QUOTED = /"[^"]*"/g
/** What the bin answers before it looks a verb up. */
const BUILTINS = new Set(['help', 'version'])

/**
 * The code on each line of `markdown`, 1-based.
 *
 * @param {string} markdown
 * @returns {{ line: number, code: string }[]}
 */
function codeByLine(markdown) {
  const out = []
  let fenced = false
  markdown.split('\n').forEach((text, i) => {
    if (FENCE.test(text)) {
      fenced = !fenced
      return
    }
    if (fenced) out.push({ line: i + 1, code: text.replace(SHELL_COMMENT, '') })
    else for (const m of text.matchAll(INLINE_CODE)) out.push({ line: i + 1, code: m[2] })
  })
  return out
}

/**
 * Every `agit` verb `markdown` names in code, in order. A noun carries its
 * action (`issue label`) when the next token is a word; a noun with no word
 * after it (`agit issue <action>`) is the noun alone.
 *
 * @param {string} markdown
 * @returns {{ line: number, verb: string, action: string | null }[]}
 */
export function verbsNamedIn(markdown) {
  const out = []
  for (const { line, code } of codeByLine(markdown))
    for (const [, first, second] of code.replace(QUOTED, '""').matchAll(INVOCATION)) {
      const verb = first.replace(TRAILING, '')
      if (!WORD.test(verb)) continue
      const action = second?.replace(TRAILING, '')
      out.push({ line, verb, action: Object.hasOwn(ACTIONS, verb) && action && WORD.test(action) ? action : null })
    }
  return out
}

/**
 * The invocations `markdown` names that agit does not run: an unknown verb, or
 * a known noun with an action it does not take.
 *
 * @param {string} markdown
 * @returns {{ line: number, verb: string }[]}
 */
export function unknownVerbs(markdown) {
  return verbsNamedIn(markdown)
    .filter(({ verb, action }) => (!Object.hasOwn(VERBS, verb) && !BUILTINS.has(verb)) || (action !== null && !ACTIONS[verb].includes(action)))
    .map(({ line, verb, action }) => ({ line, verb: action ? `${verb} ${action}` : verb }))
}
