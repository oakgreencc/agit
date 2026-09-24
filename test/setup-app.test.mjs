// @ts-check
/**
 * The manifest flow end to end, with GitHub faked: the local page carries the
 * manifest, a callback with the wrong state is refused, the right one is
 * converted, and the key lands 0600 in a temp AGIT_HOME with no stored secrets.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { awaitManifestCode, saveApp, setupApp, waitForInstallation } from '../src/setup/app.mjs'
import { scriptedPrompter } from '../src/setup/prompt.mjs'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('awaitManifestCode: serves the manifest, refuses a foreign state, returns the code', async () => {
  let stateSeen = ''
  const code = await awaitManifestCode({
    manifestFor: (redirect) => ({ name: 'x', redirect_url: redirect }),
    actionFor: (state) => {
      stateSeen = state
      return `https://github.com/settings/apps/new?state=${state}`
    },
    onReady: async (base) => {
      const page = await (await fetch(`${base}/`)).text()
      assert.match(page, /name="manifest"/)
      assert.match(page, new RegExp(`${base.replace(/[.:/]/g, '\\$&')}/callback`))
      const bad = await fetch(`${base}/callback?code=evil&state=nope`)
      assert.equal(bad.status, 400)
      await fetch(`${base}/callback?code=good&state=${stateSeen}`)
    },
  })
  assert.equal(code, 'good')
})

test('saveApp: key 0600, dirs 0700, no client/webhook secrets, owner mapped and default set', () => {
  const home = mkdtempSync(join(tmpdir(), 'agit-home-'))
  try {
    const env = { AGIT_HOME: home }
    const out = saveApp({
      app: {
        id: 42,
        slug: 'acme-agents',
        pem,
        owner: { login: 'Acme' },
        client_id: 'Iv1',
        // @ts-expect-error — extra fields GitHub returns
        client_secret: 'SECRET',
        webhook_secret: 'HOOKSECRET',
      },
      env,
    })
    const dir = join(home, 'apps', 'acme-agents')
    assert.equal(out.dir, dir)
    assert.equal(statSync(join(dir, 'private-key.pem')).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    const meta = readFileSync(join(dir, 'app.json'), 'utf8')
    assert.doesNotMatch(meta, /SECRET/)
    assert.equal(JSON.parse(meta).id, 42)
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.deepEqual(cfg, { owners: { acme: 'acme-agents' }, defaultApp: 'acme-agents' })

    // A second App for another owner is mapped but does not steal the default.
    saveApp({ app: { id: 7, slug: 'other', pem, owner: { login: 'Other' } }, env })
    const cfg2 = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.equal(cfg2.defaultApp, 'acme-agents')
    assert.equal(cfg2.owners.other, 'other')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('waitForInstallation: polls until an installation appears', async () => {
  let calls = 0
  const fakeFetch = /** @type {any} */ (async (url, init) => {
    assert.match(String(url), /\/app\/installations$/)
    assert.match(init.headers.Authorization, /^Bearer /)
    return json(++calls < 3 ? [] : [{ id: 1, account: { login: 'acme' } }])
  })
  const got = await waitForInstallation({ appId: '42', keyPem: pem, fetch: fakeFetch, sleep: async () => {} })
  assert.equal(got.length, 1)
  assert.equal(calls, 3)
})

test('setupApp: the whole manifest flow against a fake GitHub', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agit-home-'))
  const opened = []
  const fakeFetch = /** @type {any} */ (async (url, init = {}) => {
    const u = String(url)
    if (u.endsWith('/users/acme')) return json({ type: 'Organization' })
    if (u.endsWith('/app-manifests/c0de/conversions')) {
      assert.equal(init.method, 'POST')
      return json({ id: 99, slug: 'acme-bots', pem, owner: { login: 'acme' }, client_secret: 'x' })
    }
    throw new Error(`unexpected ${u}`)
  })
  const origLog = console.log
  console.log = () => {}
  try {
    const out = await setupApp(['--owner', 'acme', '--name', 'acme-bots', '--no-wait'], {
      fetch: fakeFetch,
      env: { ...process.env, AGIT_HOME: home },
      prompt: scriptedPrompter(),
      open: (url) => {
        opened.push(url)
        if (!url.startsWith('http://127.0.0.1')) return
        ;(async () => {
          const page = await (await fetch(url)).text()
          // An org resolved from /users/<owner> posts to the org's form.
          assert.match(page, /organizations\/acme\/settings\/apps\/new\?state=/)
          const state = /state=([0-9a-f]+)/.exec(page)?.[1]
          await fetch(`${url}/callback?code=c0de&state=${state}`)
        })()
      },
    })
    assert.equal(out.slug, 'acme-bots')
    assert.equal(out.appId, '99')
    assert.equal(statSync(join(home, 'apps', 'acme-bots', 'private-key.pem')).mode & 0o777, 0o600)
  } finally {
    console.log = origLog
    rmSync(home, { recursive: true, force: true })
  }
})

test('setupApp --manual: validates the pair with GET /app before storing it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agit-home-'))
  const keyFile = join(home, 'k.pem')
  writeFileSync(keyFile, pem)
  const fakeFetch = /** @type {any} */ (async (url, init) => {
    assert.match(String(url), /\/app$/)
    assert.match(init.headers.Authorization, /^Bearer /)
    return json({ id: 5, slug: 'mine', owner: { login: 'me' } })
  })
  const origLog = console.log
  console.log = () => {}
  try {
    const out = await setupApp(['--manual', '--app-id', '5', '--key', keyFile, '--no-wait'], {
      fetch: fakeFetch,
      env: { ...process.env, AGIT_HOME: home },
      prompt: scriptedPrompter(),
    })
    assert.equal(out.slug, 'mine')
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).owners.me, 'mine')
  } finally {
    console.log = origLog
    rmSync(home, { recursive: true, force: true })
  }
})
