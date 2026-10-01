// @ts-check
/**
 * Issue reads and writes: `readIssue`, `createIssue`, `commentOnIssue`,
 * `closeIssue`, `editIssueBody`, `assignIssue`, `labelIssue`. Each takes an
 * authenticated client (`createClient` in ./app.mjs) and nothing else that
 * talks to GitHub, so the tests drive them over a fake fetch.
 *
 * A read that cannot complete — 404, 403, a timeout, a body that is not an
 * issue — returns {@link UNREADABLE}, never `null`: "the issue has no labels"
 * and "I could not look" are opposite answers. The reason goes into the
 * caller's `failures`, one line, for the shell to print. A write that GitHub
 * refuses throws: there is no partial answer to render.
 *
 * Pull requests are issues to this API too: a comment or label on a PR goes
 * through here.
 */

import { createHash } from 'node:crypto'
import { PublishError } from '../errors.mjs'
import { oneLine } from './checks.mjs'

/** What a read returns when it could not look. Never `null`. */
export const UNREADABLE = Symbol('unreadable')

/** @typedef {{ what: string, error: string }} Failure */

/**
 * @typedef {object} Issue
 * @property {number} number
 * @property {string} title
 * @property {string} state                 `open` | `closed`
 * @property {string | null} stateReason    `completed` | `not_planned` | `duplicate` | `reopened` | null
 * @property {string[]} labels
 * @property {string[]} assignees           logins
 * @property {string | null} author
 * @property {string} body
 * @property {string} etag                  `bodyEtag(body)` — what `editIssueBody` checks before it writes
 * @property {string | null} url
 * @property {number} comments              the count; the comments themselves are another read
 * @property {boolean} pullRequest          GitHub serves pull requests from the issues endpoint too
 * @property {string | null} createdAt
 * @property {string | null} updatedAt
 * @property {string | null} closedAt
 */

/**
 * The version tag `editIssueBody` guards on: sha256 of the body, hex.
 *
 * Not GitHub's `ETag`, on purpose: GitHub's ETag for an unchanged issue
 * differs per installation token, so one read never matches a later run's,
 * and `PATCH /issues/N` answers 400 to any `If-Match`, even the current one.
 * A hash of the body is stable across tokens and is exactly what a clobber
 * would change.
 *
 * @param {string} body
 */
export const bodyEtag = (body) => createHash('sha256').update(body, 'utf8').digest('hex')

/**
 * Label names from an issue (its `labels`) or a bare label list — GitHub
 * sends objects, some older payloads plain strings.
 *
 * @param {any} from
 * @returns {string[]}
 */
export function labelsOf(from) {
  const list = Array.isArray(from) ? from : (from?.labels ?? [])
  return list.map((/** @type {any} */ l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
}

/** @param {any} raw @returns {string[]} */
const loginsOf = (raw) => (raw?.assignees ?? []).map((/** @type {any} */ a) => a.login)

/**
 * @param {any} raw  the REST issue object
 * @returns {Issue}
 */
function toIssue(raw) {
  return {
    number: raw.number,
    title: raw.title ?? '',
    state: raw.state,
    stateReason: raw.state_reason ?? null,
    labels: labelsOf(raw),
    assignees: loginsOf(raw),
    author: raw.user?.login ?? null,
    body: raw.body ?? '',
    etag: bodyEtag(raw.body ?? ''),
    url: raw.html_url ?? null,
    comments: raw.comments ?? 0,
    pullRequest: Boolean(raw.pull_request),
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
    closedAt: raw.closed_at ?? null,
  }
}

/**
 * One issue, or `UNREADABLE`.
 *
 * @param {{ client: import('./app.mjs').Client, owner: string, repo: string, number: number, failures?: Failure[] }} input
 * @returns {Promise<Issue | typeof UNREADABLE>}
 */
export async function readIssue({ client, owner, repo, number, failures = [] }) {
  const what = `${owner}/${repo}#${number}`
  let raw
  try {
    raw = await client.api(`/repos/${owner}/${repo}/issues/${number}`)
  } catch (err) {
    failures.push({ what, error: oneLine(err) })
    return UNREADABLE
  }
  if (!raw || typeof raw !== 'object' || typeof raw.number !== 'number') {
    failures.push({ what, error: 'the response was not an issue' })
    return UNREADABLE
  }
  return toIssue(raw)
}

/**
 * Throw before any request when `value` is blank — GitHub would accept an
 * empty comment body and file it.
 *
 * @param {string} value
 * @param {string} name
 */
function refuseEmpty(value, name) {
  if (!value?.trim()) throw new PublishError(`refusing: the ${name} is empty`)
}

/**
 * Open a new issue. Labels are written as given.
 *
 * @param {{ client: import('./app.mjs').Client, owner: string, repo: string, title: string, body: string, labels?: string[] }} input
 * @returns {Promise<{ number: number, url: string }>}
 */
export async function createIssue({ client, owner, repo, title, body, labels = [] }) {
  refuseEmpty(title, 'title')
  refuseEmpty(body, 'body')
  const made = await client.json(`/repos/${owner}/${repo}/issues`, 'POST', { title, body, labels })
  return { number: made.number, url: made.html_url }
}

/**
 * Comment on an issue or pull request.
 *
 * @param {{ client: import('./app.mjs').Client, owner: string, repo: string, number: number, body: string }} input
 * @returns {Promise<{ id: number, url: string }>}
 */
export async function commentOnIssue({ client, owner, repo, number, body }) {
  refuseEmpty(body, 'body')
  const made = await client.json(`/repos/${owner}/${repo}/issues/${number}/comments`, 'POST', { body })
  return { id: made.id, url: made.html_url }
}

/** The `state_reason`s a close may carry; the first is the default. */
export const CLOSE_REASONS = /** @type {const} */ (['completed', 'not_planned', 'duplicate'])

/**
 * Close an issue with the comment that says why: the comment first, then the
 * close, so an issue is never closed silently — a failed comment leaves it
 * open, a failed close leaves the reason on it for the retry.
 *
 * @param {{ client: import('./app.mjs').Client, owner: string, repo: string, number: number, body: string, reason?: string }} input
 * @returns {Promise<{ number: number, state: string, stateReason: string | null, comment: { id: number, url: string } }>}
 */
export async function closeIssue({ client, owner, repo, number, body, reason = 'completed' }) {
  if (!CLOSE_REASONS.includes(/** @type {any} */ (reason)))
    throw new PublishError(`refusing: reason '${reason}' is not one of ${CLOSE_REASONS.join(', ')}`)
  refuseEmpty(body, 'body')
  const comment = await commentOnIssue({ client, owner, repo, number, body })
  const closed = await client.json(`/repos/${owner}/${repo}/issues/${number}`, 'PATCH', {
    state: 'closed',
    state_reason: reason,
  })
  return { number, state: closed?.state ?? 'closed', stateReason: closed?.state_reason ?? reason, comment }
}

/**
 * Replace an issue's body — only if it is still the body the caller read.
 *
 * `etag` is the `etag` a `readIssue` returned (see {@link bodyEtag}). The body
 * is re-read and a mismatch refuses: two sessions that each read, edit and
 * write back would otherwise have the second silently erase the first. The
 * residual race is the milliseconds between that re-read and the PATCH;
 * GitHub offers no conditional write to close it.
 *
 * @param {{ client: import('./app.mjs').Client, owner: string, repo: string, number: number, body: string, etag: string }} input
 * @returns {Promise<{ number: number, url: string | null, etag: string }>}
 */
export async function editIssueBody({ client, owner, repo, number, body, etag }) {
  refuseEmpty(etag, 'etag')
  refuseEmpty(body, 'body')
  const path = `/repos/${owner}/${repo}/issues/${number}`
  const current = await client.api(path)
  const now = bodyEtag(current?.body ?? '')
  if (now !== etag)
    throw new PublishError(
      `refusing: ${owner}/${repo}#${number}'s body changed since it was read ` +
        `(etag ${etag.slice(0, 12)}, now ${now.slice(0, 12)}) — re-read it and re-apply the edit`,
    )
  const made = await client.json(path, 'PATCH', { body })
  return { number, url: made?.html_url ?? null, etag: bodyEtag(made?.body ?? body) }
}

/**
 * Assign `login`, keeping whoever is already assigned — through `PATCH` with
 * the full list. GitHub silently drops a login it cannot assign and still
 * answers 200, so the reply is checked and an absent login throws. (The App
 * itself cannot be an assignee: name a human, or a user with repo access.)
 *
 * @param {{ client: import('./app.mjs').Client, owner: string, repo: string, number: number, login: string }} input
 * @returns {Promise<{ number: number, assignees: string[] }>}
 */
export async function assignIssue({ client, owner, repo, number, login }) {
  refuseEmpty(login, 'login')
  const path = `/repos/${owner}/${repo}/issues/${number}`
  const before = loginsOf(await client.api(path))
  const assignees = loginsOf(await client.json(path, 'PATCH', { assignees: [...new Set([...before, login])] }))
  if (!assignees.includes(login))
    throw new PublishError(
      `assign: GitHub did not assign ${login} to ${owner}/${repo}#${number} — not a login with access to the repo?`,
    )
  return { number, assignees }
}

/**
 * Add and remove labels on an issue or pull request.
 *
 * An added label must already exist in the repo: GitHub creates an unknown
 * one on the fly, which is how a typo becomes a new label. A removed label
 * that is not on the issue is already where the caller wants it, so GitHub's
 * 404 "Label does not exist" counts as done.
 *
 * @param {{ client: import('./app.mjs').Client, owner: string, repo: string, number: number, add?: string[], remove?: string[] }} input
 * @returns {Promise<{ number: number, labels: string[] }>}
 */
export async function labelIssue({ client, owner, repo, number, add = [], remove = [] }) {
  if (!add.length && !remove.length) throw new PublishError('refusing: no labels to add or remove')
  const both = add.filter((l) => remove.includes(l))
  if (both.length) throw new PublishError(`refusing: ${both.join(', ')} both added and removed`)
  const base = `/repos/${owner}/${repo}`
  for (const name of add) {
    try {
      await client.api(`${base}/labels/${encodeURIComponent(name)}`)
    } catch (err) {
      if (/** @type {any} */ (err)?.status === 404)
        throw new PublishError(`refusing: label '${name}' does not exist in ${owner}/${repo}`)
      throw err
    }
  }
  /** @type {any} */
  let labels = null
  if (add.length) labels = await client.json(`${base}/issues/${number}/labels`, 'POST', { labels: add })
  for (const name of remove) {
    try {
      labels = await client.api(`${base}/issues/${number}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' })
    } catch (err) {
      const e = /** @type {any} */ (err)
      if (e?.status !== 404 || !/Label does not exist/i.test(String(e?.message))) throw err
    }
  }
  // Every removal was already absent and nothing was added: say what is there.
  if (labels === null) labels = await client.api(`${base}/issues/${number}/labels`)
  return { number, labels: labelsOf(labels) }
}
