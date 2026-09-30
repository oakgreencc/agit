// @ts-check
/**
 * A fake GitHub from a route table, for verbs that are only API calls (no
 * git): `{ 'GET /path': reply }`. A reply is a JSON body, `{ status, body }`,
 * or a function of the request body returning either. A route answered by an
 * array of replies answers them in order, the last one repeating. An unknown
 * route is a 404. Runs the REAL client (`clientOver`). Not a test file.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientOver } from './fixtures.mjs'

/** @typedef {any} Reply */

/** @param {Record<string, Reply | Reply[]>} routes */
export function github(routes) {
  /** @type {{ method: string, path: string, body: any }[]} */
  const calls = []
  /** @type {Record<string, number>} */
  const seen = {}
  const client = clientOver((method, path, body) => {
    calls.push({ method, path, body })
    const key = `${method} ${path}`
    if (!(key in routes)) throw new Error(`${path}: 404 {"message":"Not Found"}`)
    let reply = routes[key]
    if (Array.isArray(reply) && reply.length && reply.every((r) => r && typeof r === 'object' && 'reply' in r)) {
      const i = (seen[key] = (seen[key] ?? -1) + 1)
      reply = reply[Math.min(i, reply.length - 1)].reply
    }
    if (typeof reply === 'function') reply = reply(body)
    if (reply && typeof reply === 'object' && 'status' in reply && 'body' in reply) {
      if (reply.status >= 300) throw new Error(`${path}: ${reply.status} ${JSON.stringify(reply.body ?? {})}`)
      return reply.body
    }
    return reply
  })
  return { client, calls }
}

/** Replies in order, the last repeating: `sequence([a, b])`. @param {Reply[]} replies */
export const sequence = (replies) => replies.map((reply) => ({ reply }))

/** A directory that is not a checkout and has no `.agit.json`: `-C` for the verbs. */
export const emptyDir = () => mkdtempSync(join(tmpdir(), 'agit-api-'))
