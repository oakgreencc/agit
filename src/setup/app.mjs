// @ts-check
/**
 * `agit setup app` — create the GitHub App an agent acts as, and install it.
 *
 * The App Manifest flow, so the human never hand-copies a key:
 *
 *   1. a one-shot server on 127.0.0.1 serves a page that POSTs the manifest
 *      (manifest.mjs) to GitHub's "new App" form;
 *   2. the human reviews it and clicks Create — the one decision that is
 *      theirs: the App's name, and that it exists at all;
 *   3. GitHub redirects back to `/callback` with a one-time code, which
 *      `POST /app-manifests/{code}/conversions` turns into the App's id and
 *      private key;
 *   4. those land in `$AGIT_HOME/apps/<slug>/` — the key 0600, the directory
 *      0700 — and the owner is mapped to the App in `$AGIT_HOME/config.json`;
 *   5. the human installs it on the repositories it may touch, and this waits
 *      until GitHub reports an installation.
 *
 * The conversion also returns a client secret and a webhook secret. agit uses
 * neither, so neither is written anywhere: a secret that is never stored
 * cannot leak.
 *
 * `--manual` is for an App that already exists: id and PEM path in, copied to
 * the same place, checked against `GET /app`.
 *
 * Every question has a flag (`--name`, `--owner`, `--org`, `--yes`, …) so the
 * whole thing can run unattended — except the two clicks, which are the point.
 * Run inside a repository, the owner defaults to its origin's, and whether
 * that is a user or an organization is asked of GitHub, not the human.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { agitHome, loadUserConfig } from '../config.mjs'
import { contextOptions } from '../cli/common.mjs'
import { flag, has, resolveContext } from '../context.mjs'
import { appDir, asApp, request } from '../github/app.mjs'
import { appManifest, installUrl, newAppUrl } from './manifest.mjs'
import { createPrompter } from './prompt.mjs'

const say = (line = '') => console.log(line)

/** Open a URL in the human's browser, best effort. The URL is always printed too. */
export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch {
    // Printing the URL is the fallback, and it has already happened.
  }
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** The page that carries the manifest to GitHub. */
export function manifestPage({ action, manifest }) {
  return `<!doctype html><meta charset="utf-8"><title>agit: create GitHub App</title>
<body style="font-family:system-ui;max-width:40em;margin:4em auto">
<p>Sending the App manifest to GitHub… review it there and click <b>Create GitHub App</b>.</p>
<form id="f" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button></form>
<script>document.getElementById('f').submit()</script>`
}

/**
 * Run the local half of the manifest flow: serve the page, wait for the
 * callback, return the code. `onReady(url)` is called with the local URL once
 * the server listens (the caller opens it).
 *
 * @param {{ manifestFor: (redirectUrl: string) => object, actionFor: (state: string) => string, onReady: (url: string) => void, timeoutMs?: number }} input
 * @returns {Promise<string>}
 */
export function awaitManifestCode({ manifestFor, actionFor, onReady, timeoutMs = 15 * 60 * 1000 }) {
  const state = randomBytes(16).toString('hex')
  return new Promise((resolve, reject) => {
    let base = ''
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', base)
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(manifestPage({ action: actionFor(state), manifest: manifestFor(`${base}/callback`) }))
        return
      }
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code')
        // The state ties the callback to THIS run; anything else on the port is not GitHub.
        if (url.searchParams.get('state') !== state || !code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('agit: this callback does not belong to the running setup.')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;margin:4em">App created. Return to your terminal.')
        finish(null, code)
        return
      }
      res.writeHead(404)
      res.end()
    })
    const timer = setTimeout(() => finish(new Error('timed out waiting for GitHub to redirect back')), timeoutMs)
    const finish = (err, code) => {
      clearTimeout(timer)
      server.close()
      server.closeAllConnections?.()
      err ? reject(err) : resolve(code)
    }
    server.on('error', (err) => finish(err))
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address())
      base = `http://127.0.0.1:${addr.port}`
      onReady(base)
    })
  })
}

/**
 * Exchange the one-time code for the App's credentials.
 *
 * @param {{ code: string, fetch?: typeof globalThis.fetch }} input
 */
export async function convertManifest({ code, fetch = globalThis.fetch }) {
  const { json } = await request(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' }, fetch)
  if (!json?.id || !json?.pem || !json?.slug) throw new Error('GitHub returned no App id, slug or key for that code')
  return json
}

/**
 * Write an App's credentials into `$AGIT_HOME/apps/<slug>/` and map its owner
 * to it in `$AGIT_HOME/config.json`. Secrets agit does not use are dropped.
 *
 * @param {{ app: { id: number | string, slug: string, pem: string, owner?: { login?: string } | null, client_id?: string, html_url?: string, created_at?: string }, owner?: string, env?: NodeJS.ProcessEnv }} input
 * @returns {{ dir: string, owner: string | null, madeDefault: boolean }}
 */
export function saveApp({ app, owner, env = process.env }) {
  const home = agitHome(env)
  const dir = appDir(app.slug, env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  chmodSync(join(home, 'apps'), 0o700)
  chmodSync(dir, 0o700)
  const login = owner ?? app.owner?.login ?? null
  const meta = {
    id: Number(app.id),
    slug: app.slug,
    owner: login,
    ...(app.client_id ? { client_id: app.client_id } : {}),
    ...(app.html_url ? { html_url: app.html_url } : {}),
    created_at: app.created_at ?? new Date().toISOString(),
  }
  writeFileSync(join(dir, 'app.json'), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
  const pem = join(dir, 'private-key.pem')
  writeFileSync(pem, app.pem.endsWith('\n') ? app.pem : `${app.pem}\n`, { mode: 0o600 })
  chmodSync(pem, 0o600) // writeFileSync's mode applies only on create

  const cfgPath = join(home, 'config.json')
  const cfg = loadUserConfig(env)
  cfg.owners = cfg.owners ?? {}
  if (login) cfg.owners[login.toLowerCase()] = app.slug
  const madeDefault = !cfg.defaultApp
  if (madeDefault) cfg.defaultApp = app.slug
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  return { dir, owner: login, madeDefault }
}

/**
 * Poll until the App has an installation, or give up. Resolves with the
 * installations list (possibly empty on timeout/skip).
 *
 * @param {{ appId: string, keyPem: string, fetch?: typeof globalThis.fetch, timeoutMs?: number, intervalMs?: number, skip?: Promise<void>, sleep?: (ms: number) => Promise<void> }} input
 */
export async function waitForInstallation({
  appId,
  keyPem,
  fetch = globalThis.fetch,
  timeoutMs = 10 * 60 * 1000,
  intervalMs = 3000,
  skip,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let skipped = false
  skip?.then(() => {
    skipped = true
  })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { json } = await asApp({ appId, keyPem }, fetch)('/app/installations')
    if (Array.isArray(json) && json.length) return json
    if (skipped || Date.now() >= deadline) return []
    await sleep(intervalMs)
  }
}

/** Resolves when the human presses enter; never, without a TTY. */
function enterPressed() {
  if (!process.stdin.isTTY) return new Promise(() => {})
  return new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.once('data', () => {
      process.stdin.pause()
      resolve(undefined)
    })
  })
}

const USAGE = `usage: agit setup app [--owner <user> | --org <org>] [--name <app-name>] [--projects]
                      [--no-wait] [--yes]
       agit setup app --manual [--app-id <id>] [--key <path/to/private-key.pem>]`

/**
 * @param {string[]} argv
 * @param {{ fetch?: typeof globalThis.fetch, open?: (url: string) => void, prompt?: import('./prompt.mjs').Prompter, env?: NodeJS.ProcessEnv, timeoutMs?: number, repoOwner?: (argv: string[]) => string | null }} [deps]
 * @returns {Promise<{ slug: string, appId: string, owner: string | null, installations: any[] }>}
 */
export async function setupApp(argv, deps = {}) {
  if (has(argv, '--help')) {
    say(USAGE)
    return /** @type {any} */ (null)
  }
  const {
    fetch = globalThis.fetch,
    open = openBrowser,
    env = process.env,
    prompt = createPrompter({ yes: has(argv, '--yes') }),
    repoOwner = originOwner,
  } = deps
  try {
    const app = has(argv, '--manual')
      ? await manualApp(argv, { fetch, prompt, env })
      : await manifestApp(argv, { fetch, open, prompt, env, timeoutMs: deps.timeoutMs, repoOwner })

    const keyPem = readFileSync(join(appDir(app.slug, env), 'private-key.pem'), 'utf8')
    let installations = []
    if (!has(argv, '--no-wait')) {
      const url = installUrl(app.slug)
      say(`\nNow install ${app.slug} on the repositories agents may work in (only those):\n  ${url}`)
      open(url)
      say('Waiting for the installation… (press enter to skip)')
      installations = await waitForInstallation({ appId: app.appId, keyPem, fetch, skip: enterPressed() })
      if (process.stdin.isTTY) process.stdin.pause() // stop waiting for an enter nobody needs to press
      if (installations.length)
        say(`✓ installed on ${installations.map((i) => i.account?.login ?? i.id).join(', ')}`)
      else say(`! no installation yet. Install it later from ${url}, then run: agit doctor`)
    }
    say('\nNext, in each repository: agit setup project')
    return { ...app, installations }
  } finally {
    prompt.close()
  }
}

/**
 * The owner of the repository setup runs in, from its `origin` remote — the
 * account whose repositories the App is for, so nobody has to type it. Null
 * outside a repository or without a GitHub origin.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
export function originOwner(argv) {
  try {
    const ctx = resolveContext(contextOptions(argv))
    return ctx.root ? ctx.repo().owner : null
  } catch {
    return null
  }
}

async function manifestApp(argv, { fetch, open, prompt, env, timeoutMs, repoOwner }) {
  const org = flag(argv, '--org')
  const fromOrigin = org || flag(argv, '--owner') ? null : repoOwner(argv)
  if (fromOrigin) say(`Owner: ${fromOrigin}, from this repository's origin (--owner or --org to change).`)
  const owner =
    org ??
    flag(argv, '--owner') ??
    fromOrigin ??
    (await prompt.ask('GitHub user or organization that will own the App', { flag: '--owner or --org' }))
  // An org's App is created from a different URL. Ask GitHub rather than the
  // human which one `owner` is (public endpoint; no credentials needed yet).
  let ownerType = /** @type {'user' | 'org'} */ (org ? 'org' : 'user')
  if (!org) {
    try {
      const { json } = await request(`/users/${encodeURIComponent(owner)}`, {}, fetch)
      if (json?.type === 'Organization') ownerType = 'org'
    } catch {
      // Unknown: treat as a user; --org overrides.
    }
  }
  const name =
    flag(argv, '--name') ??
    (await prompt.ask('App name (globally unique on GitHub)', { default: `${owner}-agents`, flag: '--name' }))
  const projects = has(argv, '--projects')

  say(`Creating GitHub App "${name}" for ${ownerType === 'org' ? 'organization' : 'user'} ${owner}.`)
  say('It gets contents/pull_requests/issues write and actions/checks/statuses read — and deliberately')
  say('NOT workflows, administration or secrets (see docs/github-setup.md).')
  const code = await awaitManifestCode({
    manifestFor: (redirectUrl) => appManifest({ name, owner, ownerType, redirectUrl, projects }),
    actionFor: (state) => newAppUrl({ owner, ownerType, state }),
    onReady: (url) => {
      say(`\nOpen this in a browser signed in to GitHub as an owner of ${owner}:\n  ${url}`)
      open(url)
    },
    timeoutMs,
  })
  const conv = await convertManifest({ code, fetch })
  const saved = saveApp({ app: conv, owner, env })
  say(`✓ created ${conv.slug} (id ${conv.id}); credentials in ${saved.dir}`)
  return { slug: conv.slug, appId: String(conv.id), owner: saved.owner }
}

async function manualApp(argv, { fetch, prompt, env }) {
  const appId = flag(argv, '--app-id') ?? (await prompt.ask('App ID', { flag: '--app-id' }))
  const keyPath = flag(argv, '--key') ?? (await prompt.ask('Path to the App private key (.pem)', { flag: '--key' }))
  if (!existsSync(keyPath)) throw new Error(`no such file: ${keyPath}`)
  const pem = readFileSync(keyPath, 'utf8')
  // Prove the pair works before storing it: GET /app answers only for a valid JWT.
  const { json } = await asApp({ appId, keyPem: pem }, fetch)('/app')
  const saved = saveApp({ app: { ...json, id: json?.id ?? appId, pem }, env })
  say(`✓ ${json.slug} (id ${json.id}) stored in ${saved.dir}`)
  return { slug: json.slug, appId: String(json.id ?? appId), owner: saved.owner }
}
