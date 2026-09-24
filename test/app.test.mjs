// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import {
  appJwt,
  createClient,
  installationToken,
  RATE_LIMIT_RETRIES,
  rateLimitWait,
  request,
} from '../src/github/app.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' })

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/**
 * A fake fetch: `routes` maps `METHOD url` to `{ status, body, headers? }`, or
 * to an array of them answered in order (the last one repeats); calls are
 * recorded.
 *
 * Typed as the real `fetch` so it slots into the functions under test; the
 * response is the subset (`ok`, `status`, `text`, `headers`) they read.
 *
 * @typedef {{ status: number, body: string, headers?: Record<string, string> }} Reply
 * @param {Record<string, Reply | Reply[]>} routes
 * @returns {typeof globalThis.fetch & { calls: { url: string, init: any }[] }}
 */
function fakeFetch(routes) {
  /** @type {{ url: string, init: any }[]} */
  const calls = []
  /** @type {any} */
  const fetch = async (url, init = {}) => {
    calls.push({ url, init })
    const route = routes[`${(init.method ?? 'GET').toUpperCase()} ${url}`] ?? {
      status: 404,
      body: '{"message":"Not Found"}',
    }
    const r = /** @type {Reply} */ (
      Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route
    )
    return {
      ok: r.status < 400,
      status: r.status,
      text: async () => r.body,
      headers: new Map(Object.entries(r.headers ?? {})),
    }
  }
  fetch.calls = calls
  return fetch
}

const rateLimited = (status = 403, headers = {}) => ({
  status,
  body: '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}',
  headers,
})

test('appJwt is an RS256 JWT for the App with a nine-minute window, skewed 30s back', () => {
  const jwt = appJwt({ appId: '4242', keyPem, now: 1_000_000 })
  const [h, p, sig] = jwt.split('.')
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(decode(p), { iat: 999_970, exp: 1_000_540, iss: '4242' })
  const v = createVerify('RSA-SHA256')
  v.update(`${h}.${p}`)
  assert.equal(v.verify(publicKey, Buffer.from(sig, 'base64url')), true)
})

test('installationToken: installation lookup, then a token minted with the JWT as bearer', async () => {
  const fetch = fakeFetch({
    'GET https://api.github.com/repos/o/r/installation': { status: 200, body: '{"id":77}' },
    'POST https://api.github.com/app/installations/77/access_tokens': {
      status: 201,
      body: '{"token":"ghs_x"}',
    },
  })
  assert.equal(
    await installationToken({ owner: 'o', repo: 'r', appId: '1', keyPem, fetch }),
    'ghs_x',
  )
  assert.equal(fetch.calls.length, 2)
  for (const c of fetch.calls) assert.match(c.init.headers.Authorization, /^Bearer ey/)
})

test('request: non-2xx is an error naming path and status; non-JSON bodies parse to null', async () => {
  const fetch = fakeFetch({
    'GET https://api.github.com/x': { status: 200, body: 'plain log text' },
    'GET https://api.github.com/y': { status: 409, body: '{"message":"Merge conflict"}' },
  })
  const ok = await request('/x', {}, fetch)
  assert.equal(ok.json, null)
  assert.equal(ok.text, 'plain log text')
  await assert.rejects(request('/y', {}, fetch), /^Error: \/y: 409 \{"message":"Merge conflict"\}$/)
})

test('request: the error carries the status and the rate-limit headers', async () => {
  const fetch = fakeFetch({
    'POST https://api.github.com/z': rateLimited(403, {
      'retry-after': '7',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1700000000',
      'x-other': 'ignored',
    }),
  })
  await assert.rejects(request('/z', { method: 'POST' }, fetch), (err) => {
    assert.equal(/** @type {any} */ (err).status, 403)
    assert.deepEqual(/** @type {any} */ (err).headers, {
      'retry-after': '7',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1700000000',
    })
    return true
  })
})

// --- rateLimitWait: the docs' three rules, then exponential backoff --------------------

const limited = (status, headers = {}, message = 'exceeded a secondary rate limit') =>
  Object.assign(new Error(`/x: ${status} {"message":"${message}"}`), { status, headers })

test('retry-after wins: that many seconds, doubled on every further attempt', () => {
  const err = limited(403, { 'retry-after': '7', 'x-ratelimit-remaining': '0' })
  assert.equal(rateLimitWait(err, 0), 7_000)
  assert.equal(rateLimitWait(err, 1), 14_000)
  assert.equal(rateLimitWait(err, 3), 56_000)
  assert.equal(rateLimitWait(limited(429, { 'retry-after': '2' }), 0), 2_000)
})

test('remaining 0 without retry-after: until x-ratelimit-reset, never less than a second', () => {
  const now = 1_700_000_000_000
  const err = limited(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000030' })
  assert.equal(rateLimitWait(err, 0, now), 30_000)
  assert.equal(rateLimitWait(err, 1, now), 60_000)
  // A reset already in the past still waits a beat rather than hammering.
  assert.equal(rateLimitWait(err, 0, now + 60_000), 1_000)
})

test('a rate-limit message with no header guidance: a minute, doubling', () => {
  assert.equal(rateLimitWait(limited(403), 0), 60_000)
  assert.equal(rateLimitWait(limited(429), 2), 240_000)
})

test('anything else is not retried', () => {
  assert.equal(rateLimitWait(limited(403, {}, 'Resource not accessible by integration'), 0), null)
  assert.equal(rateLimitWait(limited(404, {}, 'Not Found'), 0), null)
  assert.equal(rateLimitWait(limited(422, { 'retry-after': '1' }, 'Validation Failed'), 0), null)
  assert.equal(rateLimitWait(new Error('/x: 500 boom'), 0), null)
  assert.equal(rateLimitWait(new TypeError('fetch failed'), 0), null)
})

// --- the client retries a rate-limited request, and says so ----------------------------

test('createClient waits out a rate-limited response and retries, reporting each wait', async () => {
  const fetch = fakeFetch({
    'POST https://api.github.com/repos/o/r/git/blobs': [
      rateLimited(403, { 'retry-after': '3' }),
      rateLimited(429),
      { status: 201, body: '{"sha":"abc"}' },
    ],
  })
  const waits = []
  const reports = []
  const client = createClient({
    token: 'ghs_t',
    fetch,
    sleep: async (ms) => void waits.push(ms),
    report: (line) => reports.push(line),
  })
  assert.deepEqual(
    await client.json('/repos/o/r/git/blobs', 'POST', { content: 'aGk=', encoding: 'base64' }),
    { sha: 'abc' },
  )
  assert.equal(fetch.calls.length, 3)
  assert.deepEqual(waits, [3_000, 120_000])
  assert.match(
    reports[0],
    /rate limited \(403\) on POST \/repos\/o\/r\/git\/blobs: waiting 3s \(retry 1\/\d+\)/,
  )
  assert.match(reports[1], /rate limited \(429\).*waiting 120s \(retry 2\/\d+\)/)
})

test('createClient gives up after RATE_LIMIT_RETRIES and surfaces the last refusal', async () => {
  const fetch = fakeFetch({
    'POST https://api.github.com/repos/o/r/git/blobs': rateLimited(403, { 'retry-after': '1' }),
  })
  const waits = []
  const client = createClient({ token: 'ghs_t', fetch, sleep: async (ms) => void waits.push(ms) })
  await assert.rejects(
    client.json('/repos/o/r/git/blobs', 'POST', {}),
    /git\/blobs: 403 .*secondary rate limit/,
  )
  assert.equal(fetch.calls.length, RATE_LIMIT_RETRIES + 1)
  assert.equal(waits.length, RATE_LIMIT_RETRIES)
})

test('createClient does not retry, or sleep, on an ordinary refusal', async () => {
  const fetch = fakeFetch({
    'POST https://api.github.com/repos/o/r/git/blobs': { status: 422, body: '{"message":"no"}' },
  })
  const client = createClient({
    token: 'ghs_t',
    fetch,
    sleep: async () => assert.fail('slept'),
  })
  await assert.rejects(client.json('/repos/o/r/git/blobs', 'POST', {}), /: 422 /)
  assert.equal(fetch.calls.length, 1)
})

test('createClient sends the token on every call and json() sets the content type', async () => {
  const fetch = fakeFetch({
    'POST https://api.github.com/repos/o/r/git/blobs': { status: 201, body: '{"sha":"abc"}' },
    'GET https://api.github.com/repos/o/r/git/ref/heads/x': {
      status: 200,
      body: '{"object":{"sha":"abc"}}',
    },
  })
  const client = createClient({ token: 'ghs_t', fetch })
  assert.deepEqual(
    await client.json('/repos/o/r/git/blobs', 'POST', { content: 'aGk=', encoding: 'base64' }),
    { sha: 'abc' },
  )
  assert.deepEqual(await client.api('/repos/o/r/git/ref/heads/x'), { object: { sha: 'abc' } })
  const [post, get] = fetch.calls
  assert.equal(post.init.headers.Authorization, 'token ghs_t')
  assert.equal(post.init.headers['Content-Type'], 'application/json')
  assert.equal(post.init.body, '{"content":"aGk=","encoding":"base64"}')
  assert.equal(get.init.headers.Authorization, 'token ghs_t')
  assert.equal(get.init.headers.Accept, 'application/vnd.github+json')
})
