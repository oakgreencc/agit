// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_PERMISSIONS, WITHHELD_PERMISSIONS, appManifest, installUrl, newAppUrl } from '../src/setup/manifest.mjs'

test('manifest: private, no webhooks, exactly the write-path permissions', () => {
  const m = appManifest({ name: 'acme-agents', owner: 'acme', redirectUrl: 'http://127.0.0.1:1/callback' })
  assert.equal(m.public, false)
  assert.equal(m.url, 'https://github.com/acme')
  assert.equal(m.redirect_url, 'http://127.0.0.1:1/callback')
  assert.equal(m.hook_attributes.active, false)
  assert.deepEqual(m.default_events, [])
  assert.deepEqual(m.default_permissions, { ...APP_PERMISSIONS })
})

test('manifest: the hard floor — workflows, administration and secrets are never granted', () => {
  for (const ownerType of /** @type {const} */ (['user', 'org'])) {
    const m = appManifest({ name: 'n', owner: 'o', ownerType, redirectUrl: 'x', projects: true })
    for (const p of WITHHELD_PERMISSIONS) assert.equal(p in m.default_permissions, false, p)
  }
})

test('manifest: organization_projects only for an org that asked for it', () => {
  const org = appManifest({ name: 'n', owner: 'o', ownerType: 'org', redirectUrl: 'x', projects: true })
  assert.equal(org.default_permissions.organization_projects, 'write')
  const user = appManifest({ name: 'n', owner: 'o', ownerType: 'user', redirectUrl: 'x', projects: true })
  assert.equal('organization_projects' in user.default_permissions, false)
  const quiet = appManifest({ name: 'n', owner: 'o', ownerType: 'org', redirectUrl: 'x' })
  assert.equal('organization_projects' in quiet.default_permissions, false)
})

test('manifest: a name and an owner are required', () => {
  assert.throws(() => appManifest({ name: '', owner: 'o', redirectUrl: 'x' }))
  assert.throws(() => appManifest({ name: 'n', owner: '', redirectUrl: 'x' }))
})

test('newAppUrl: user and org forms, state carried', () => {
  assert.equal(newAppUrl({ owner: 'me', state: 's 1' }), 'https://github.com/settings/apps/new?state=s%201')
  assert.equal(
    newAppUrl({ owner: 'acme', ownerType: 'org', state: 's' }),
    'https://github.com/organizations/acme/settings/apps/new?state=s',
  )
  assert.equal(installUrl('acme-agents'), 'https://github.com/apps/acme-agents/installations/new')
})
