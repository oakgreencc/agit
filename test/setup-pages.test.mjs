// @ts-check
/**
 * The local setup pages: each is a whole, labelled document; the handoff page
 * says what the App can and cannot do; nothing a manifest carries escapes into
 * markup; and the server answers every path with a page, not a bare status.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { awaitManifestCode } from '../src/setup/app.mjs'
import { appManifest, WITHHELD_PERMISSIONS } from '../src/setup/manifest.mjs'
import { createdPage, foreignCallbackPage, manifestPage, notFoundPage } from '../src/setup/pages.mjs'

const shell = (html) => {
  assert.match(html, /^<!doctype html>\n<html lang="en">/)
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/)
  assert.match(html, /<meta name="color-scheme" content="light dark">/)
  assert.match(html, /prefers-color-scheme: dark/)
  assert.match(html, /<title>[^<]+ · agit<\/title>/)
  assert.match(html, /<main>[\s\S]*<h1>/)
}

test('every page shares the full shell', () => {
  const action = 'https://github.com/settings/apps/new?state=abc'
  const manifest = appManifest({ name: 'acme-agents', owner: 'acme', redirectUrl: 'http://127.0.0.1:1/callback' })
  for (const html of [manifestPage({ action, manifest }), createdPage({ name: 'acme-agents' }), foreignCallbackPage(), notFoundPage()])
    shell(html)
})

test('manifestPage: names the App and owner, lists granted and withheld permissions, escapes', () => {
  const manifest = appManifest({ name: 'acme"<x>', owner: 'acme', ownerType: 'org', redirectUrl: 'http://127.0.0.1:1/callback' })
  const html = manifestPage({ action: 'https://github.com/x?state=1&a="b"', manifest, owner: 'acme', ownerType: 'org', minutes: 15 })
  assert.match(html, /Create <code>acme&quot;&lt;x&gt;<\/code> on GitHub/)
  assert.match(html, /the organization <b>acme<\/b>/)
  assert.match(html, /Open, update and merge pull requests<\/span><span class="tag write">/)
  assert.match(html, /Read check results<\/span><span class="tag read">/)
  assert.equal((html.match(/class="tag never"/g) ?? []).length, WITHHELD_PERMISSIONS.length)
  assert.match(html, /stops after 15 minutes/)
  assert.match(html, /action="https:\/\/github.com\/x\?state=1&amp;a=&quot;b&quot;"/)
  assert.doesNotMatch(html, /acme"<x>/)
  // Back from GitHub must not bounce forward again.
  assert.match(html, /sessionStorage/)
})

test('awaitManifestCode: 404 and foreign callbacks get pages; success names the App', async () => {
  const pages = {}
  let visited = Promise.resolve()
  const code = await awaitManifestCode({
    manifestFor: (redirect) => ({ name: 'acme-agents', redirect_url: redirect }),
    actionFor: (state) => `https://github.com/settings/apps/new?state=${state}`,
    owner: 'acme',
    onReady: (base) => {
      visited = (async () => {
        const first = await (await fetch(`${base}/`)).text()
        const state = /state=([0-9a-f]+)/.exec(first)?.[1]
        const missing = await fetch(`${base}/favicon.ico`)
        pages.missing = { status: missing.status, type: missing.headers.get('content-type'), html: await missing.text() }
        const foreign = await fetch(`${base}/callback?code=x&state=nope`)
        pages.foreign = { status: foreign.status, html: await foreign.text() }
        const ok = await fetch(`${base}/callback?code=good&state=${state}`)
        pages.ok = { status: ok.status, cache: ok.headers.get('cache-control'), html: await ok.text() }
      })()
    },
  })
  await visited
  assert.equal(code, 'good')
  assert.equal(pages.missing.status, 404)
  assert.match(pages.missing.type, /text\/html/)
  assert.match(pages.missing.html, /Nothing here/)
  assert.equal(pages.foreign.status, 400)
  assert.match(pages.foreign.html, /run <code>agit setup app<\/code> again/)
  assert.equal(pages.ok.status, 200)
  assert.equal(pages.ok.cache, 'no-store')
  assert.match(pages.ok.html, /GitHub created <code>acme-agents<\/code>/)
  assert.match(pages.ok.html, /<\/html>\n$/)
})
