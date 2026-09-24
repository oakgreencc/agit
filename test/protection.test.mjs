// @ts-check
/**
 * The Protection module through its interface: `policyFrom(read)` over each
 * reader, and `judge`. Readers are map-backed here except `readAtRef`, which
 * runs against real git because what it reads is a ref, not a directory.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { policyOnBase } from '../src/cli/pr.mjs'
import { mergeVerdict } from '../src/pr-policy.mjs'
import { POLICY_FILES, judge, policyFrom, readAtRef, readAtRoot, snapshot } from '../src/protected.mjs'
import { clientOver } from './fixtures.mjs'

const CODEOWNERS = '/ci/ @alice\n'
/** A reader over a map of path → text. */
const mapReader = (files) => (path) => files[path] ?? null

const GRANT = { reason: 'r', scopes: ['protected'], grantedAt: '', expiresAt: '2099-01-01T00:00:00Z', session: 's', via: 'x' }
/** @type {Record<string, any>} */
const G = {
  none: { state: 'none' },
  protected: { state: 'active', grant: GRANT, session: 's' },
  merge: { state: 'active', grant: { ...GRANT, scopes: ['merge'] }, session: 's' },
}

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------

const base = policyFrom(mapReader({ '.github/CODEOWNERS': CODEOWNERS }))
const local = policyFrom(mapReader({ '.agit.json': JSON.stringify({ protected: { extra: ['/tools/**'] } }) }))

/** @type {[string, { paths: string[], grant?: any, scope?: string }, { impossible: string[], protected: string[], lifted: boolean, ok: boolean }][]} */
const cases = [
  ['ordinary paths', { paths: ['src/a.ts'] }, { impossible: [], protected: [], lifted: false, ok: true }],
  ['a CODEOWNERS path, no grant', { paths: ['ci/run.mjs'] }, { impossible: [], protected: ['ci/run.mjs'], lifted: false, ok: false }],
  ['a CODEOWNERS path, protected grant', { paths: ['ci/run.mjs'], grant: G.protected }, { impossible: [], protected: ['ci/run.mjs'], lifted: true, ok: true }],
  ['a grant for another scope lifts nothing', { paths: ['ci/run.mjs'], grant: G.merge }, { impossible: [], protected: ['ci/run.mjs'], lifted: false, ok: false }],
  ['the scope is the caller\'s: merge', { paths: ['ci/run.mjs'], grant: G.merge, scope: 'merge' }, { impossible: [], protected: ['ci/run.mjs'], lifted: true, ok: true }],
  ['impossible is never lifted', { paths: ['.github/workflows/ci.yml'], grant: G.protected }, { impossible: ['.github/workflows/ci.yml'], protected: [], lifted: false, ok: false }],
  ['either policy protecting is protected', { paths: ['tools/x.mjs', 'ci/a', 'ci/a'] }, { impossible: [], protected: ['tools/x.mjs', 'ci/a'], lifted: false, ok: false }],
  ['self-protection holds without CODEOWNERS', { paths: ['.agit.json'] }, { impossible: [], protected: ['.agit.json'], lifted: false, ok: false }],
]
for (const [label, input, want] of cases) {
  test(`judge: ${label}`, () => {
    const v = judge({ policies: [base, local], ...input })
    assert.deepEqual(
      { impossible: v.impossible.map((h) => h.path), protected: v.protected.map((h) => h.path), lifted: v.lifted, ok: v.ok },
      want,
    )
  })
}

test('judge: the first policy to name a path gives the reason — the base is listed first', () => {
  const reasoned = policyFrom(mapReader({ '.agit.json': JSON.stringify({ protected: { extra: ['/ci/**'] } }) }))
  assert.match(judge({ paths: ['ci/x'], policies: [base, reasoned] }).protected[0].why, /owned by @alice/)
  assert.match(judge({ paths: ['ci/x'], policies: [reasoned, base] }).protected[0].why, /protected\.extra/)
})

// ---------------------------------------------------------------------------
// policyFrom: one config rule, wherever it is read
// ---------------------------------------------------------------------------

test('policyFrom: no .agit.json is the defaults, with no problem', () => {
  const p = policyFrom(mapReader({ 'CODEOWNERS': CODEOWNERS }))
  assert.equal(p.configProblem, null)
  assert.equal(p.codeownersPath, 'CODEOWNERS')
  assert.deepEqual(p.codeowners, { path: 'CODEOWNERS', text: CODEOWNERS })
  assert.equal(p.config.requiredCheck, null)
  assert.equal(p.check('ci/x')?.tier, 'protected')
})

test('policyFrom: an .agit.json that does not parse is judged by the defaults — CODEOWNERS and self-protection hold — and says so', () => {
  const p = policyFrom(mapReader({ '.agit.json': '{ nope', 'docs/CODEOWNERS': CODEOWNERS }))
  assert.match(String(p.configProblem), /^\.agit\.json: /)
  assert.equal(p.check('ci/x')?.tier, 'protected')
  assert.equal(p.check('.agit.json')?.tier, 'protected')
  assert.equal(p.check('.github/workflows/x.yml')?.tier, 'impossible')
})

test('policyFrom: the config shapes the policy — owners filter, codeowners off, extra', () => {
  const owners = policyFrom(mapReader({ CODEOWNERS: '/ci/ @alice\n/lib/ @bob\n', '.agit.json': JSON.stringify({ protected: { owners: ['@bob'] } }) }))
  assert.equal(owners.check('ci/x'), null)
  assert.equal(owners.check('lib/x')?.tier, 'protected')
  const off = policyFrom(mapReader({ CODEOWNERS, '.agit.json': JSON.stringify({ protected: { codeowners: false } }) }))
  assert.equal(off.check('ci/x'), null)
  assert.equal(off.check('CODEOWNERS')?.tier, 'protected') // still self-protected
})

test('snapshot: fetches each policy file once, then reads synchronously', async () => {
  /** @type {string[]} */
  const asked = []
  const read = await snapshot(async (p) => {
    asked.push(p)
    return p === '.github/CODEOWNERS' ? CODEOWNERS : null
  })
  assert.deepEqual(asked, POLICY_FILES)
  assert.equal(policyFrom(read).check('ci/x')?.tier, 'protected')
  assert.deepEqual(asked, POLICY_FILES)
})

// ---------------------------------------------------------------------------
// The readers over real places
// ---------------------------------------------------------------------------

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const gitIn = (dir) => (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })

test('readAtRef vs readAtRoot: a base without .agit.json is the defaults, NOT the worktree\'s config', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agit-prot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = gitIn(dir)
  git(['init', '-q', '-b', 'main'])
  mkdirSync(join(dir, '.github'))
  writeFileSync(join(dir, '.github/CODEOWNERS'), CODEOWNERS)
  git(['add', '.'])
  git(['commit', '-qm', 'base'])
  // The worktree adds a config the base does not have — loosening CODEOWNERS.
  writeFileSync(join(dir, '.agit.json'), JSON.stringify({ protected: { codeowners: false }, requiredCheck: 'ci' }))

  const atBase = policyFrom(readAtRef(git, 'HEAD'))
  assert.equal(atBase.check('ci/x')?.tier, 'protected')
  assert.equal(atBase.config.requiredCheck, null)
  const atRoot = policyFrom(readAtRoot(dir))
  assert.equal(atRoot.check('ci/x'), null)
  assert.equal(atRoot.config.requiredCheck, 'ci')
})

// ---------------------------------------------------------------------------
// pr merge: the base policy, as the contents API has it
// ---------------------------------------------------------------------------

/** The real client over a contents API that serves `files` on any ref, 404 otherwise. */
const contentsClient = (files) =>
  clientOver((method, path) => {
    const m = /\/contents\/(.+)\?ref=/.exec(path)
    const text = m ? files[m[1]] : undefined
    if (text === undefined) throw new Error(`${path}: 404 {"message":"Not Found"}`)
    return { content: Buffer.from(text).toString('base64') }
  })

test('policyOnBase: read from the base alone — a base with no .agit.json does not borrow the worktree\'s', async () => {
  const policy = await policyOnBase({ client: contentsClient({ '.github/CODEOWNERS': CODEOWNERS }), owner: 'o', repo: 'r', base: 'main' })
  assert.equal(policy.config.requiredCheck, null)
  assert.equal(policy.config.baseBranch, null)
  assert.equal(policy.check('ci/x')?.tier, 'protected')
})

test('mergeVerdict: an unparseable base policy refuses, and a merge grant lifts it', async () => {
  const policy = await policyOnBase({ client: contentsClient({ '.agit.json': '{' }), owner: 'o', repo: 'r', base: 'main' })
  const input = {
    pr: { number: 7, base: 'main', headSha: 'a'.repeat(40) },
    allowedBases: ['main'],
    policy,
    policyProblem: policy.configProblem,
    requiredCheck: null,
    lookups: { files: async () => ['src/a.ts'] },
  }
  const refused = await mergeVerdict({ ...input, granted: false })
  assert.equal(refused.ok, false)
  assert.match(refused.refusals[0].text, /the policy on `main` does not parse/)
  const lifted = await mergeVerdict({ ...input, granted: true })
  assert.equal(lifted.ok, true)
  assert.equal(lifted.lifted.length, 1)
})
