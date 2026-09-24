// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  batchByBytes,
  blobShas,
  changedPaths,
  commitBody,
  COMMIT_BODY_KEYS,
  INLINE_MAX_BYTES,
  inlineable,
  inScope,
  parseDiffTree,
  planTree,
} from '../src/publish/tree.mjs'

const sha = (c) => c.repeat(40)

// --- changedPaths ------------------------------------------------------------

test('reads every kind of status record from -z output', () => {
  // Captured from `git status --porcelain -uall -z` on a scratch repo with a
  // modification, a staged deletion, a rename and an untracked file.
  const raw = ' M a.txt\u0000D  b.txt\u0000R  d/moved.txt\u0000d/c.txt\u0000?? n.txt\u0000'
  assert.deepEqual(changedPaths(raw), ['a.txt', 'b.txt', 'd/moved.txt', 'd/c.txt', 'n.txt'])
})

test('a rename yields both paths, and the old path is not read as a status code', () => {
  // The bug this guards: the bare `<old>` record has no status column, and a
  // reader that treats it as one publishes a garbage path.
  assert.deepEqual(changedPaths('R  new.txt\u0000old.txt\u0000'), ['new.txt', 'old.txt'])
  assert.deepEqual(changedPaths('C  copy.txt\u0000orig.txt\u0000'), ['copy.txt'])
})

test('paths with spaces survive, and nothing is deduplicated away that differs', () => {
  assert.deepEqual(changedPaths(' M a b.txt\u0000?? c\nd.txt\u0000'), ['a b.txt', 'c\nd.txt'])
  assert.deepEqual(changedPaths(''), [])
})

// --- inScope -----------------------------------------------------------------

test('--paths scopes to the named files and directories', () => {
  const f = inScope(['docs/', 'scripts/a.mjs'])
  assert.equal(f('docs/x.md'), true)
  assert.equal(f('docs/sub/x.md'), true)
  assert.equal(f('scripts/a.mjs'), true)
  assert.equal(f('scripts/a.mjs.bak'), false)
  assert.equal(f('docsx/y.md'), false)
  assert.equal(inScope(null)('anything'), true)
  assert.equal(inScope([])('anything'), true)
})

// --- parseDiffTree -----------------------------------------------------------

const DIFF =
  `:100644 100644 ${sha('1')} ${sha('2')} M\u0000a.txt\u0000` +
  `:100644 000000 ${sha('3')} ${sha('0')} D\u0000b.txt\u0000` +
  `:000000 100755 ${sha('0')} ${sha('4')} A\u0000bin/run\u0000` +
  `:000000 120000 ${sha('0')} ${sha('5')} A\u0000link\u0000`

test('parses modify, delete, add and symlink records', () => {
  const e = parseDiffTree(DIFF)
  assert.deepEqual(
    e.map(({ path, srcMode, dstMode, status }) => [path, srcMode, dstMode, status]),
    [
      ['a.txt', '100644', '100644', 'M'],
      ['b.txt', '100644', '000000', 'D'],
      ['bin/run', '000000', '100755', 'A'],
      ['link', '000000', '120000', 'A'],
    ],
  )
  assert.equal(e[0].dstSha, sha('2'))
  assert.deepEqual(parseDiffTree(''), [])
})

test('a malformed record is an error, not a silently skipped path', () => {
  assert.throws(
    () => parseDiffTree(':100644 100644 short M\u0000a.txt\u0000'),
    /unparseable diff-tree record/,
  )
  assert.throws(() => parseDiffTree(`:100644 100644 ${sha('1')} ${sha('2')} M`), /without a path/)
})

// --- planTree ----------------------------------------------------------------

test('a deletion is a null-sha entry; everything else references the blob by sha', () => {
  const { tree, uploads } = planTree(parseDiffTree(DIFF))
  assert.deepEqual(tree, [
    { path: 'a.txt', mode: '100644', type: 'blob', sha: sha('2') },
    { path: 'b.txt', mode: '100644', type: 'blob', sha: null },
    { path: 'bin/run', mode: '100755', type: 'blob', sha: sha('4') },
    { path: 'link', mode: '120000', type: 'blob', sha: sha('5') },
  ])
  assert.deepEqual(
    uploads.map((u) => u.path),
    ['a.txt', 'bin/run', 'link'],
  )
})

test('blobs GitHub already holds are not uploaded again', () => {
  const { uploads } = planTree(parseDiffTree(DIFF), { known: new Set([sha('2'), sha('5')]) })
  assert.deepEqual(uploads, [{ path: 'bin/run', mode: '100755', sha: sha('4') }])
})

test('a submodule is refused', () => {
  assert.throws(
    () => planTree(parseDiffTree(`:000000 160000 ${sha('0')} ${sha('9')} A\u0000vendor/x\u0000`)),
    /submodule/,
  )
})

// --- inlineable: what may ride inside POST /git/trees as `content` ------------------

test('UTF-8 text in a regular or executable blob is inlineable', () => {
  assert.equal(inlineable(Buffer.from('plain\n'), '100644'), true)
  assert.equal(inlineable(Buffer.from('#!/bin/sh\necho héllo — ✓\n'), '100755'), true)
  assert.equal(inlineable(Buffer.from('crlf\r\n\ttabs\n'), '100644'), true)
  assert.equal(inlineable(Buffer.alloc(0), '100644'), true)
})

test('a symlink, a NUL byte, invalid UTF-8 or an oversized blob is not', () => {
  assert.equal(inlineable(Buffer.from('target'), '120000'), false)
  assert.equal(inlineable(Buffer.from('a\0b'), '100644'), false)
  assert.equal(inlineable(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]), '100644'), false)
  // A lone continuation byte decodes to U+FFFD: the bytes would change, so no.
  assert.equal(inlineable(Buffer.from([0x61, 0x80, 0x62]), '100644'), false)
  assert.equal(inlineable(Buffer.alloc(INLINE_MAX_BYTES + 1, 0x61), '100644'), false)
  assert.equal(inlineable(Buffer.alloc(INLINE_MAX_BYTES, 0x61), '100644'), true)
  assert.equal(inlineable(Buffer.from('ab'), '100644', { max: 1 }), false)
})

// --- batchByBytes -------------------------------------------------------------------

test('batches keep insertion order and stay within the byte budget', () => {
  const items = [
    { path: 'a', bytes: 4 },
    { path: 'b', bytes: 5 },
    { path: 'c', bytes: 2 },
    { path: 'd', bytes: 9 },
    { path: 'e', bytes: 1 },
  ]
  assert.deepEqual(
    batchByBytes(items, (i) => i.bytes, 10).map((b) => b.map((i) => i.path)),
    [['a', 'b'], ['c'], ['d', 'e']],
  )
  assert.deepEqual(
    batchByBytes(items.slice(0, 0), (i) => i.bytes, 10),
    [],
  )
  // An item alone over budget still ships, on its own.
  assert.deepEqual(
    batchByBytes(items.slice(3), (i) => i.bytes, 3).map((b) => b.map((i) => i.path)),
    [['d'], ['e']],
  )
})

// --- commitBody: THE pin --------------------------------------------------------

test('a commit body carries exactly message, tree and parents — nothing that would disable signing', () => {
  // research §3: an `author` (any value, the bot's own included), a
  // `committer` (even `GitHub <noreply@github.com>`) or a `signature` makes
  // GitHub skip signing. Field presence is what breaks it, so the pin is on
  // the key set, not on values.
  const body = commitBody({ message: 'm', tree: sha('a'), parents: [sha('b'), sha('c')] })
  assert.deepEqual(Object.keys(body).sort(), [...COMMIT_BODY_KEYS].sort())
  assert.equal('author' in body, false)
  assert.equal('committer' in body, false)
  assert.equal('signature' in body, false)
  assert.deepEqual(body, { message: 'm', tree: sha('a'), parents: [sha('b'), sha('c')] })
})

test('commitBody validates its three fields', () => {
  assert.throws(
    () => commitBody({ message: '', tree: sha('a'), parents: [sha('b')] }),
    /needs a message/,
  )
  assert.throws(
    () => commitBody({ message: 'm', tree: 'nope', parents: [sha('b')] }),
    /tree is not a sha/,
  )
  assert.throws(() => commitBody({ message: 'm', tree: sha('a'), parents: [] }), /parents must be/)
  assert.throws(
    () => commitBody({ message: 'm', tree: sha('a'), parents: ['x'] }),
    /parents must be/,
  )
})

// --- blobShas ----------------------------------------------------------------

test('collects blob shas from ls-tree -r -z, ignoring trees and gitlinks', () => {
  const raw = `100644 blob ${sha('1')}\ta.txt\u0000040000 tree ${sha('2')}\td\u0000100755 blob ${sha('3')}\td/run\u0000160000 commit ${sha('4')}\tsub\u0000`
  assert.deepEqual([...blobShas(raw)].sort(), [sha('1'), sha('3')])
})
