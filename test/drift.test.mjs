// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findDisplacement, displacementMessage } from '../src/gates/drift.mjs'

/** A fake `git` that records its args and replays canned stdout. */
const fakeGit = (stdout, calls = []) => {
  const fn = (args) => {
    calls.push(args)
    return stdout
  }
  fn.calls = calls
  return fn
}

test('the #596 case: a path that moved on develop is reported', () => {
  const git = fakeGit('apps/admin/CLAUDE.md\n')
  const displaced = findDisplacement({
    git,
    worktreeBase: 'abc6574',
    branchHead: '25b298a',
    paths: ['apps/admin/CLAUDE.md', 'packages/agent-env/src/worktree.mjs'],
  })
  assert.deepEqual(displaced, ['apps/admin/CLAUDE.md'])
})

test('a worktree level with the branch publishes clean', () => {
  const git = fakeGit('\n')
  assert.deepEqual(
    findDisplacement({ git, worktreeBase: 'aaa', branchHead: 'aaa', paths: ['a.md'] }),
    [],
  )
})

test('scoped publishes only compare the paths being published', () => {
  // A file that drifted but is NOT being published cannot be displaced, so the
  // pathspec must reach git — otherwise the gate blocks unrelated publishes.
  const calls = []
  const git = fakeGit('', calls)
  findDisplacement({ git, worktreeBase: 'aaa', branchHead: 'bbb', paths: ['x.md', 'y.md'] })
  assert.deepEqual(calls[0], ['diff', '--name-only', 'aaa', 'bbb', '--', 'x.md', 'y.md'])
})

test('an unscoped publish compares the whole tree', () => {
  // Without --paths bot-commit sweeps every change in the worktree, so every
  // path is a candidate for displacement and no pathspec may be passed.
  const calls = []
  const git = fakeGit('', calls)
  findDisplacement({ git, worktreeBase: 'aaa', branchHead: 'bbb' })
  assert.deepEqual(calls[0], ['diff', '--name-only', 'aaa', 'bbb'])

  const calls2 = []
  findDisplacement({ git: fakeGit('', calls2), worktreeBase: 'aaa', branchHead: 'bbb', paths: [] })
  assert.deepEqual(calls2[0], ['diff', '--name-only', 'aaa', 'bbb'])
})

test('output is sorted and free of blank entries', () => {
  const git = fakeGit('b.md\n\na.md\n  c.md  \n')
  assert.deepEqual(findDisplacement({ git, worktreeBase: 'aaa', branchHead: 'bbb' }), [
    'a.md',
    'b.md',
    'c.md',
  ])
})

test('the refusal names the files, both bases, and the fix', () => {
  const msg = displacementMessage(['apps/admin/CLAUDE.md'], {
    base: 'develop',
    worktreeBase: 'abc657498328d5ff',
    branchHead: '25b298a11223344',
  })
  assert.match(msg, /apps\/admin\/CLAUDE\.md/)
  assert.match(msg, /abc6574/)
  assert.match(msg, /25b298a/)
  assert.match(msg, /git fetch origin develop/)
  assert.match(msg, /git rebase origin\/develop/)
  assert.match(msg, /git reset --soft origin\/develop/)
  // Never the destructive reconcile: the classifier refuses it and it drops edits.
  assert.doesNotMatch(msg, /reset --hard/)
  assert.match(msg, /--allow-displacement/)
  // Singular/plural, because a gate that says "1 files" reads as broken.
  assert.match(msg, /revert 1 file\b/)
})

test('the refusal pluralises past one file', () => {
  const msg = displacementMessage(['a.md', 'b.md'], { base: 'develop' })
  assert.match(msg, /revert 2 files\b/)
})
