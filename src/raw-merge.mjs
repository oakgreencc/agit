// @ts-check
/**
 * A merge sent through the raw `api` / `graphql` verbs, recognised from the
 * PARSED call rather than from command text.
 *
 * `agit pr merge` is where the merge policy lives. The `guard-pr-writes` hook
 * turns raw merges away inside Claude Code, but any other runner calls
 * `agit api PUT …/pulls/<n>/merge` straight through — so the verbs refuse it
 * themselves, before any client is built. There is no escape flag: the
 * override is a maintainer grant with the `merge` scope, on `agit pr merge`.
 *
 * What passes: `GET …/merge` ("is it merged?"), `PUT …/update-branch` (lands
 * nothing on the base), and GraphQL queries that merely mention a merge field.
 */

/** The GraphQL root mutations that merge a PR, now or later. */
export const MERGE_MUTATIONS = Object.freeze(['mergePullRequest', 'enablePullRequestAutoMerge', 'enqueuePullRequest'])

/**
 * `https://api.github.com//repos/o/r/pulls/1/merge/?x=1` → `/repos/o/r/pulls/1/merge`.
 * Percent-escapes are decoded, since GitHub decodes them too.
 *
 * @param {string} path
 */
export function normalisePath(path) {
  let p = String(path).trim()
  try {
    p = decodeURIComponent(p)
  } catch {
    // A malformed escape is left as-is; GitHub will reject it anyway.
  }
  return p
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^(?!\/)/, '/')
    .replace(/(.)\/+$/, '$1')
}

const MERGE_PATH = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/([^/]+)\/merge$/i

/**
 * The PR a raw REST call merges, or `null` for a read or any other path.
 * The number is loose so a path built from an unexpanded `$N` is still caught.
 *
 * @param {{ method: string, path: string }} call
 * @returns {{ kind: 'rest', repo: string, number: string } | null}
 */
export function restMergeTarget({ method, path }) {
  if (String(method).toUpperCase() === 'GET') return null // reading merge state
  const m = MERGE_PATH.exec(normalisePath(path))
  return m ? { kind: 'rest', repo: `${m[1]}/${m[2]}`, number: m[3] } : null
}

/**
 * The root fields of every `mutation` operation in a GraphQL document, in
 * order — aliases resolved to the field, arguments, comments, strings and
 * directives skipped. Queries and subscriptions contribute nothing. Fragment
 * spreads at the root are not followed (GitHub has no use for one there).
 *
 * @param {string} query
 * @returns {string[]}
 */
export function mutationRootFields(query) {
  const text = String(query)
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, '')
  const tokens = text.match(/\.\.\.|[{}():]|[@$]?[_A-Za-z][_0-9A-Za-z]*/g) ?? []
  /** @type {string[]} */
  const fields = []
  let braces = 0
  let parens = 0
  /** @type {string | null} */
  let op = null // the operation type the next top-level `{` opens
  let inMutation = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '(') parens++
    else if (t === ')') parens--
    else if (parens > 0) continue
    else if (t === '{') {
      if (braces === 0) {
        inMutation = op === 'mutation'
        op = null
      }
      braces++
    } else if (t === '}') {
      braces--
      if (braces === 0) inMutation = false
    } else if (braces === 0) {
      if (t === 'query' || t === 'mutation' || t === 'subscription' || t === 'fragment') op = t
    } else if (braces === 1 && inMutation && /^[_A-Za-z]/.test(t) && tokens[i + 1] !== ':' && tokens[i - 1] !== '...')
      fields.push(t)
  }
  return fields
}

/**
 * The first merge mutation a raw GraphQL document runs, or `null`.
 *
 * @param {string} query
 * @returns {string | null}
 */
export function graphqlMergeField(query) {
  return mutationRootFields(query).find((f) => MERGE_MUTATIONS.includes(f)) ?? null
}
