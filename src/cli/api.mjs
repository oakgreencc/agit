// @ts-check
/**
 * `api`, `graphql`, `jobs` — the read path (and the tracker's write path), as
 * the App. Anything `gh` was used for goes through here, so no human
 * credential is ever needed.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { jobFailed, jobLines, runIdFrom, runLine } from '../actions-jobs.mjs'
import { flag, has, positionals } from '../context.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

/**
 * The client, scoped to the right installation. `--repo` wins; else a
 * `/repos/<owner>/<repo>/` path names its own; else the checkout's origin.
 * The token covers the whole installation, so any repo in it works.
 */
async function clientForPath(argv, path = '') {
  const fromPath = /^(?:https:\/\/api\.github\.com)?\/repos\/([^/]+)\/([^/?#]+)/.exec(path)
  const ctx = contextFrom(argv, { needRoot: false, repo: fromPath ? `${fromPath[1]}/${fromPath[2]}` : null })
  return { ctx, client: await ctx.client() }
}

const nextLink = (res) => /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null

const API_USAGE =
  'usage: agit api <METHOD> <path> [--body <json>|--body-file <f>] [--paginate] [--raw] [--out <file>] [--repo <owner/repo>]\n\n' +
  '  agit api GET /repos/o/r/pulls/12\n' +
  "  agit api GET '/repos/o/r/issues?state=open' --paginate\n" +
  '  agit api POST /repos/o/r/issues/12/comments --body \'{"body":"…"}\'\n\n' +
  'JSON is pretty-printed on stdout; a text body (job logs) is printed as-is. Use --paginate on any\n' +
  'list — a first page of 30 otherwise reads as the whole set.'

export async function runApi(argv) {
  const [method, path] = positionals(argv, [...COMMON_VALUE_FLAGS, '--body', '--body-file', '--out'])
  if (!method || !path || has(argv, '--help')) {
    console.log(API_USAGE)
    return method && path ? 0 : 1
  }
  const { client } = await clientForPath(argv, path)
  const bodyFile = flag(argv, '--body-file')
  const body = bodyFile ? readFileSync(resolve(bodyFile), 'utf8') : flag(argv, '--body')
  const init = {
    method: method.toUpperCase(),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
  }

  // --out writes the body as bytes. Required for anything binary — artifact
  // zips in particular, which stdout would corrupt.
  const out = flag(argv, '--out')
  if (out) {
    const url = path.startsWith('http') ? path : `https://api.github.com${path}`
    const res = await fetch(url, { ...init, headers: { ...client.auth, ...init.headers } })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    console.log(`wrote ${out}`)
    return 0
  }

  // --raw: exactly as GitHub sent it, for callers that parse it themselves.
  if (has(argv, '--raw')) {
    console.log((await client.raw(path, init)).text)
    return 0
  }

  if (!has(argv, '--paginate')) {
    // A body that is not JSON (`/actions/jobs/<id>/logs`) is printed as the
    // text it is; printing `null` read as "the endpoint returned nothing".
    const { text, json } = await client.raw(path, init)
    console.log(json === null && text ? text : JSON.stringify(json, null, 2))
    return 0
  }

  // RFC 5988 `Link: rel="next"`, array pages concatenated. Some list endpoints
  // wrap the array (`{ total_count, workflow_runs: [...] }`); those are
  // concatenated on the one array key.
  const all = []
  /** @type {string | null} */
  let next = path
  let wrapper = null
  while (next) {
    const { res, json } = await client.raw(next, init)
    if (Array.isArray(json)) all.push(...json)
    else {
      const key = json && Object.keys(json).find((k) => Array.isArray(json[k]))
      if (!key) {
        console.log(JSON.stringify(json, null, 2))
        return 0
      }
      wrapper ??= { ...json, [key]: [] }
      wrapper[key].push(...json[key])
    }
    next = nextLink(res)
  }
  console.log(JSON.stringify(wrapper ?? all, null, 2))
  return 0
}

export async function runGraphql(argv) {
  const [query] = positionals(argv, [...COMMON_VALUE_FLAGS, '--vars', '--vars-file'])
  if (!query || has(argv, '--help')) {
    console.log(
      "usage: agit graphql '<query>' [--vars <json>|--vars-file <f>] [--repo <owner/repo>]\n\n" +
        'Required for anything with no REST surface — Projects v2 in particular.',
    )
    return query ? 0 : 1
  }
  const { client } = await clientForPath(argv)
  const varsFile = flag(argv, '--vars-file')
  const varsRaw = varsFile ? readFileSync(resolve(varsFile), 'utf8') : flag(argv, '--vars')
  // client.graphql throws on an `errors` array: GraphQL answers 200 even when
  // the call failed entirely, and printing `null` would read as success.
  const data = await client.graphql(query, varsRaw ? JSON.parse(varsRaw) : {})
  console.log(JSON.stringify(data, null, 2))
  return 0
}

/**
 * The CI-failure read in one call: which job and step failed, and the logs
 * that say why, on disk. Without it this was three `api` calls and a flag
 * nobody remembered, and reports stopped at "job X failed".
 */
export async function runJobs(argv) {
  const [runArg] = positionals(argv, [...COMMON_VALUE_FLAGS, '--logs'])
  const runId = runArg ? runIdFrom(runArg) : null
  if (!runId || has(argv, '--help')) {
    console.log('usage: agit jobs <run-id | run URL> [--logs <dir>] [--all] [--repo <owner/repo>]')
    return runId ? 0 : 1
  }
  const fromUrl = /github\.com\/([^/]+)\/([^/]+)\/actions\/runs\//.exec(runArg)
  const { ctx, client } = await clientForPath(argv, fromUrl ? `/repos/${fromUrl[1]}/${fromUrl[2]}/` : '')
  const { owner, repo } = ctx.repo()
  const base = `/repos/${owner}/${repo}/actions`

  const run = await client.api(`${base}/runs/${runId}`)
  const jobs = []
  /** @type {string | null} */
  let next = `${base}/runs/${runId}/jobs?per_page=100`
  while (next) {
    const { res, json } = await client.raw(next)
    jobs.push(...json.jobs)
    next = nextLink(res)
  }

  /** @type {Record<number, string>} */
  const logs = {}
  const dir = flag(argv, '--logs')
  if (dir) {
    mkdirSync(dir, { recursive: true })
    for (const j of has(argv, '--all') ? jobs : jobs.filter(jobFailed)) {
      const out = join(dir, `${j.id}.log`)
      writeFileSync(out, (await client.raw(`${base}/jobs/${j.id}/logs`)).text)
      logs[j.id] = out
    }
  }
  console.log(runLine(run))
  for (const line of jobLines(jobs, logs)) console.log(line)
  return 0
}

