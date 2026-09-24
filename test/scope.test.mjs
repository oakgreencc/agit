// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ADDED_BYTES_CEILING,
  blobSizes,
  findPayloadRefusals,
  isNeverPublished,
  noPrNote,
  payloadRefusalsInTree,
  payloadMessage,
  sweepMessage,
} from '../src/gates/scope.mjs'
import { worktreeTree } from '../src/publish/publish.mjs'

const KiB = 1024

// ---------------------------------------------------------------------------
// The sweep refusal: no --paths and no --all
// ---------------------------------------------------------------------------

test('sweepMessage names every path the sweep would have taken', () => {
  const msg = sweepMessage(['androidfailedbuild.log', 'apps/mobile/src/a.ts'])
  assert.match(msg, /refusing to publish: no --paths and no --all/)
  assert.match(msg, /^ {2}androidfailedbuild\.log$/m)
  assert.match(msg, /^ {2}apps\/mobile\/src\/a\.ts$/m)
  assert.match(msg, /--paths <a,b>/)
  assert.match(msg, /--all/)
})

test('sweepMessage with a clean worktree still refuses, and says so', () => {
  const msg = sweepMessage([])
  assert.match(msg, /refusing to publish: no --paths and no --all/)
  assert.match(msg, /nothing is uncommitted/)
})

test('sweepMessage leads with the usage line when given one', () => {
  const msg = sweepMessage(['a'], { usage: 'usage: bot-commit.mjs publish …' })
  assert.match(msg, /^usage: bot-commit\.mjs publish …\n\nrefusing to publish/)
})

// ---------------------------------------------------------------------------
// *.log at any size
// ---------------------------------------------------------------------------

test('isNeverPublished: *.log anywhere in the tree, case-insensitively, and nothing else', () => {
  assert.equal(isNeverPublished('androidfailedbuild.log'), true)
  assert.equal(isNeverPublished('apps/mobile/build/Build.LOG'), true)
  assert.equal(isNeverPublished('packages/publish/src/logger.mjs'), false)
  assert.equal(isNeverPublished('docs/changelog.md'), false)
  assert.equal(isNeverPublished('log'), false)
})

// ---------------------------------------------------------------------------
// ls-tree -l parsing
// ---------------------------------------------------------------------------

test('blobSizes reads `ls-tree -r -l -z`, including padded sizes and a path with a space', () => {
  const raw =
    '100644 blob 0123456789abcdef0123456789abcdef01234567     123\tpnpm-lock.yaml\0' +
    '100755 blob 89abcdef0123456789abcdef0123456789abcdef 1048576\tbin/run me.sh\0' +
    '120000 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa      12\tlink\0' +
    '160000 commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb       -\tsub\0'
  const sizes = blobSizes(raw)
  assert.deepEqual(
    [...sizes],
    [
      ['pnpm-lock.yaml', 123],
      ['bin/run me.sh', 1048576],
      ['link', 12],
    ],
  )
})

// ---------------------------------------------------------------------------
// The added-bytes ceiling
// ---------------------------------------------------------------------------

/** A size lookup over a literal `{ path: bytes }`; `null` for a path not on disk. */
const sizeOf = (disk) => (p) => (p in disk ? disk[p] : null)

test('the incident: a 55k-line build log is refused whatever the flags say about size', () => {
  const refused = findPayloadRefusals({
    changed: ['androidfailedbuild.log', 'apps/mobile/src/a.ts'],
    size: sizeOf({ 'androidfailedbuild.log': 3 * 1024 * KiB, 'apps/mobile/src/a.ts': 2 * KiB }),
    before: new Map(),
  })
  assert.deepEqual(refused, [
    {
      path: 'androidfailedbuild.log',
      reason: 'log',
      bytes: 3 * 1024 * KiB,
      before: 0,
      added: 3 * 1024 * KiB,
    },
  ])
})

test('a small *.log is still refused: the extension, not the size, is the reason', () => {
  const refused = findPayloadRefusals({
    changed: ['foo.log'],
    size: sizeOf({ 'foo.log': 10 }),
    before: new Map(),
  })
  assert.equal(refused.length, 1)
  assert.equal(refused[0].reason, 'log')
})

test('a new blob over the ceiling is refused; one exactly at it is not', () => {
  const at = findPayloadRefusals({
    changed: ['a.bin'],
    size: sizeOf({ 'a.bin': ADDED_BYTES_CEILING }),
    before: new Map(),
  })
  assert.deepEqual(at, [])
  const over = findPayloadRefusals({
    changed: ['a.bin'],
    size: sizeOf({ 'a.bin': ADDED_BYTES_CEILING + 1 }),
    before: new Map(),
  })
  assert.deepEqual(over, [
    {
      path: 'a.bin',
      reason: 'added-bytes',
      bytes: ADDED_BYTES_CEILING + 1,
      before: 0,
      added: ADDED_BYTES_CEILING + 1,
    },
  ])
})

test('the premise correction: a large tracked file growing a little is NOT refused', () => {
  // pnpm-lock.yaml is ~816 KB on develop and sektor.yaml ~930 KB. A flat
  // per-blob ceiling would fire on every dependency bump; the gate is on the
  // bytes a publish ADDS to the path.
  const lock = 816 * KiB
  const refused = findPayloadRefusals({
    changed: ['pnpm-lock.yaml'],
    size: sizeOf({ 'pnpm-lock.yaml': lock + 40 * KiB }),
    before: new Map([['pnpm-lock.yaml', lock]]),
  })
  assert.deepEqual(refused, [])
})

test('a tracked file that grows by more than the ceiling in one publish is refused', () => {
  const refused = findPayloadRefusals({
    changed: ['packages/schema/openapi/sektor.yaml'],
    size: sizeOf({ 'packages/schema/openapi/sektor.yaml': 930 * KiB + 600 * KiB }),
    before: new Map([['packages/schema/openapi/sektor.yaml', 930 * KiB]]),
  })
  assert.equal(refused.length, 1)
  assert.equal(refused[0].reason, 'added-bytes')
  assert.equal(refused[0].added, 600 * KiB)
  assert.equal(refused[0].before, 930 * KiB)
})

test('a shrinking file adds nothing; a deleted path has no bytes to gate', () => {
  const refused = findPayloadRefusals({
    changed: ['big.json', 'gone.log'],
    size: sizeOf({ 'big.json': 10 * KiB }), // gone.log is absent on disk: a deletion
    before: new Map([
      ['big.json', 2000 * KiB],
      ['gone.log', 5000 * KiB],
    ]),
  })
  assert.deepEqual(refused, [])
})

test('--allow-large names the path and lifts both refusals for it, and only it', () => {
  const changed = ['foo.log', 'a.bin', 'b.bin']
  const size = sizeOf({ 'foo.log': 10, 'a.bin': 600 * KiB, 'b.bin': 600 * KiB })
  const before = new Map()
  const some = findPayloadRefusals({ changed, size, before, allow: ['foo.log', 'a.bin'] })
  assert.deepEqual(
    some.map((r) => r.path),
    ['b.bin'],
  )
  const all = findPayloadRefusals({ changed, size, before, allow: ['foo.log', 'a.bin', 'b.bin'] })
  assert.deepEqual(all, [])
})

test('the ceiling is overridable, and defaults to 512 KiB', () => {
  assert.equal(ADDED_BYTES_CEILING, 512 * KiB)
  const refused = findPayloadRefusals({
    changed: ['a.bin'],
    size: sizeOf({ 'a.bin': 2 * KiB }),
    before: new Map(),
    ceiling: KiB,
  })
  assert.equal(refused.length, 1)
})

// ---------------------------------------------------------------------------
// The refusal text
// ---------------------------------------------------------------------------

test('payloadMessage prints each path with its size and the override that names it', () => {
  const msg = payloadMessage([
    {
      path: 'androidfailedbuild.log',
      reason: 'log',
      bytes: 3 * 1024 * KiB,
      before: 0,
      added: 3 * 1024 * KiB,
    },
    { path: 'a.bin', reason: 'added-bytes', bytes: 700 * KiB, before: 100 * KiB, added: 600 * KiB },
  ])
  assert.match(msg, /^refusing to publish: 2 paths/)
  assert.match(msg, /androidfailedbuild\.log — never published \(payload\.neverPublish in \.agit\.json; 3\.0 MiB\)/)
  assert.match(
    msg,
    /a\.bin — adds 600\.0 KiB \(100\.0 KiB → 700\.0 KiB\); the ceiling is 512\.0 KiB/,
  )
  assert.match(msg, /--allow-large androidfailedbuild\.log,a\.bin/)
  assert.match(msg, /Nothing was committed/)
})

test('payloadMessage for one path is singular', () => {
  const msg = payloadMessage([{ path: 'foo.log', reason: 'log', bytes: 10, before: 0, added: 10 }])
  assert.match(msg, /^refusing to publish: 1 path /)
  assert.match(msg, /; 10 B\)/)
})

// ---------------------------------------------------------------------------
// The no-PR note
// ---------------------------------------------------------------------------

test('noPrNote says the branch has no PR and therefore no CI, and how to get one', () => {
  const note = noPrNote({ branch: 'agent/topic', base: 'develop' })
  assert.match(note, /agent\/topic has no open pull request/)
  assert.match(note, /no CI runs on it/)
  assert.match(note, /--pr "<title>"/)
  assert.match(note, /develop/)
})

// ---------------------------------------------------------------------------
// Against a real worktree, and the CLI's wiring of the scope gate
// ---------------------------------------------------------------------------

// See integration.test.mjs: the runner's ~/.gitconfig signs commits with a
// 1Password-gated key, so every git call here masks the global config.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}
const gitIn = (dir) => (args, opts = {}) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...GIT_ENV, ...(opts.env ?? {}) },
  })

/**
 * The payload gate the way a publish runs it: build the tree from the
 * worktree (as `worktreeTree` does), then measure what that tree changes.
 */
function payloadOf({ git, head, paths = null, allow }) {
  const { tree } = worktreeTree({ git, base: head, paths })
  if (!tree) return []
  const changed = git(['diff-tree', '-r', '--no-renames', '--name-only', '-z', head, tree]).split('\0').filter(Boolean)
  return payloadRefusalsInTree({ git, base: head, tree, paths: changed, allow })
}

/** A repo with one commit holding a large tracked file, as develop does. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'publish-scope-'))
  const git = gitIn(dir)
  git(['init', '-q', '-b', 'main'])
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'x'.repeat(816 * KiB))
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'base'])
  return { dir, git, head: git(['rev-parse', 'HEAD']).trim() }
}

test('payloadRefusalsInTree over real git: a 600 KiB blob and foo.log are refused, --allow-large lifts each', (t) => {
  const { dir, git, head } = scratchRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(600 * KiB, 1))
  writeFileSync(join(dir, 'foo.log'), 'one line\n')
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2\n')
  // The lockfile grows by 40 KiB: a dependency bump, not a dump.
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'x'.repeat(856 * KiB))

  const all = payloadOf({ git, head })
  assert.deepEqual(
    all.map(({ path, reason }) => ({ path, reason })),
    [
      { path: 'big.bin', reason: 'added-bytes' },
      { path: 'foo.log', reason: 'log' },
    ],
  )
  // --paths scopes the tree, and so the gate, to what is being published.
  assert.deepEqual(payloadOf({ git, head, paths: ['src', 'pnpm-lock.yaml'] }), [])
  // --allow-large names the path.
  assert.deepEqual(
    payloadOf({ git, head, allow: ['big.bin'] }).map((r) => r.path),
    ['foo.log'],
  )
  assert.deepEqual(payloadOf({ git, head, allow: ['big.bin', 'foo.log'] }), [])
})

test('payloadRefusalsInTree: deleting a tracked large file, or a tracked log, is not a refusal', (t) => {
  const { dir, git } = scratchRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'old.log'), 'x'.repeat(2 * KiB))
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'with a log'])
  const head = git(['rev-parse', 'HEAD']).trim()
  unlinkSync(join(dir, 'old.log'))
  unlinkSync(join(dir, 'pnpm-lock.yaml'))
  assert.deepEqual(payloadOf({ git, head }), [])
})

test('payloadRefusalsInTree measures the TREE, not the disk: what is judged is what ships', (t) => {
  const { dir, git, head } = scratchRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2\n')
  const { tree } = worktreeTree({ git, base: head, paths: null })
  // The disk moves on after the tree was built; the tree is what lands.
  writeFileSync(join(dir, 'src/a.ts'), 'x'.repeat(600 * KiB))
  assert.deepEqual(payloadRefusalsInTree({ git, base: head, tree: /** @type {string} */ (tree), paths: ['src/a.ts'] }), [])
})

const AGIT = new URL('../bin/agit.mjs', import.meta.url).pathname
const runAgit = (args) =>
  spawnSync(process.execPath, [AGIT, ...args], {
    encoding: 'utf8',
    // An empty AGIT_HOME: no App is configured, so anything reaching for
    // credentials would fail loudly rather than use this machine's.
    env: { ...process.env, ...GIT_ENV, AGIT_HOME: join(tmpdir(), 'agit-no-home') },
  })

test('CLI: publish with neither --paths nor --all exits 1 before any network, listing the sweep', (t) => {
  const { dir } = scratchRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'androidfailedbuild.log'), 'x'.repeat(4 * KiB))
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2\n')
  // No credentials, no remote: the scope gate is the first thing that runs,
  // so it must refuse before anything that would need either.
  const out = runAgit(['publish', 'agent/x', 'msg', '-C', dir])
  assert.equal(out.status, 1, out.stderr)
  assert.match(out.stderr, /^usage: agit publish .*\(--paths a,b \| --all\)/m)
  assert.match(out.stderr, /refusing to publish: no --paths and no --all/)
  assert.match(out.stderr, /^ {2}androidfailedbuild\.log$/m)
  assert.match(out.stderr, /^ {2}src\/a\.ts$/m)
  assert.match(out.stderr, /Nothing was sent to GitHub/)
  assert.doesNotMatch(out.stderr, /credentials|fetch/i)
})

test('CLI: a flag in the branch slot is refused before anything else', (t) => {
  const { dir } = scratchRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // The mangled invocation from the incident: a verb-ish flag where the branch goes.
  const out = runAgit(['publish', '--api', 'GET /repos/o/r', '--all', '-C', dir])
  assert.equal(out.status, 1, out.stderr)
  assert.match(out.stderr, /^usage: agit publish/m)
})

test('CLI: --paths and --all together is a contradiction, refused', (t) => {
  const { dir } = scratchRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = runAgit(['publish', 'agent/x', 'msg', '--paths', 'src', '--all', '-C', dir])
  assert.equal(out.status, 1, out.stderr)
  assert.match(out.stderr, /--paths or --all, not both/)
})
