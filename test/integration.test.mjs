// @ts-check
/**
 * The operations against REAL git, with a bare repository standing in for
 * GitHub.
 *
 * `publish.test.mjs` pins the request shapes with fakes. This file answers
 * the question the fakes cannot: does the tree the tool builds locally come
 * out byte-identical when GitHub rebuilds it from `base_tree` + entries? The
 * fake GitHub (fixtures.mjs) implements the Git Database endpoints with git
 * plumbing on a bare repo, so the sha equality check in `publishTree` is
 * exercised for real — modes, deletions, untracked files, a merge.
 *
 * No network, no credentials, no `git push`: the "remote" is a directory.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULTS, merge } from '../src/config.mjs'
import { ZERO_SHA, hookRunner } from '../src/git-hooks.mjs'
import {
  PublishError,
  advance,
  publishMerge,
  publishWorktree,
  resolveBranch,
} from '../src/publish/publish.mjs'
import { runPublish } from '../src/cli/publish.mjs'
import { hookScenario, must, run, scenario, status } from './fixtures.mjs'

test('publish: modifications, a deletion, an untracked file and an exec bit land as one commit whose tree GitHub rebuilds identically', async () => {
  const s = scenario()
  try {
    const { wt, bare, git, client } = s
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    unlinkSync(join(wt, 'b.txt'))
    writeFileSync(join(wt, 'new.txt'), 'new\n')
    writeFileSync(join(wt, 'run.sh'), '#!/bin/sh\n')
    chmodSync(join(wt, 'run.sh'), 0o755)
    writeFileSync(join(wt, 'd/c.txt'), 'out of scope\n') // not in --paths: must not ship

    const base = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    const out = await publishWorktree({
      git,
      client,
      owner: 'o',
      repo: 'r',
      branch: 'agent/x',
      head: null,
      base,
      message: 'feat: x',
      paths: ['a.txt', 'b.txt', 'new.txt', 'run.sh'],
    })

    // The branch exists on "GitHub", its tree is exactly what git built locally.
    const remoteHead = run(bare, ['rev-parse', 'refs/heads/agent/x']).trim()
    assert.equal(remoteHead, out.commit.sha)
    const ls = run(bare, ['ls-tree', '-r', remoteHead])
    assert.match(ls, /100755 blob [0-9a-f]{40}\trun\.sh/)
    assert.match(ls, /100644 blob [0-9a-f]{40}\tnew\.txt/)
    assert.doesNotMatch(ls, /b\.txt/)
    assert.equal(run(bare, ['show', `${remoteHead}:a.txt`]), 'changed\n')
    assert.equal(run(bare, ['show', `${remoteHead}:d/c.txt`]), 'three\n') // untouched by the publish
    assert.equal(
      run(bare, ['rev-list', '--parents', '-n', '1', remoteHead]).trim(),
      `${remoteHead} ${base.sha}`,
    )

    // Advance: HEAD moves to the published commit, the published paths are
    // clean, and the out-of-scope edit is still there, still uncommitted.
    run(wt, ['fetch', '-q', 'origin', 'agent/x'])
    const adv = advance({ git, target: out.commit.sha })
    assert.equal(adv.advanced, true)
    assert.deepEqual(must(adv.recorded).sort(), ['a.txt', 'b.txt', 'new.txt', 'run.sh'])
    assert.equal(run(wt, ['rev-parse', 'HEAD']).trim(), out.commit.sha)
    assert.equal(status(wt), ' M d/c.txt')
  } finally {
    s.cleanup()
  }
})

/**
 * agent/x on "GitHub" (published as the App) edits a.txt one way; develop
 * then moves on "GitHub", editing a.txt the other way and adding theirs.txt.
 * The worktree is on agent/x's head with origin/develop fetched — the moment
 * before the agent's `git merge`. `make` builds the underlying scenario.
 *
 * @template {ReturnType<typeof scenario>} S
 * @param {() => S} [make]
 */
async function conflictScenario(make = /** @type {() => S} */ (scenario)) {
  const s = make()
  const { wt, bare, git, client } = s
  const develop = run(bare, ['rev-parse', 'refs/heads/develop']).trim()
  run(wt, ['checkout', '-q', '--detach', develop])
  writeFileSync(join(wt, 'a.txt'), 'mine\n')
  const pub = await publishWorktree({
    git,
    client,
    owner: 'o',
    repo: 'r',
    branch: 'agent/x',
    head: null,
    base: { sha: develop, tree: run(bare, ['rev-parse', `${develop}^{tree}`]).trim() },
    message: 'mine',
    paths: ['a.txt'],
  })
  run(wt, ['fetch', '-q', 'origin'])
  advance({ git, target: pub.commit.sha })

  const devIndex = { GIT_INDEX_FILE: join(bare, 'dev-index') }
  run(bare, ['read-tree', develop], { env: devIndex })
  const theirsA = run(bare, ['hash-object', '-w', '--stdin'], { input: 'theirs\n' }).trim()
  const theirsT = run(bare, ['hash-object', '-w', '--stdin'], { input: 'theirs file\n' }).trim()
  run(bare, ['update-index', '--add', '--cacheinfo', `100644,${theirsA},a.txt`], { env: devIndex })
  run(bare, ['update-index', '--add', '--cacheinfo', `100644,${theirsT},theirs.txt`], { env: devIndex })
  const devTree = run(bare, ['write-tree'], { env: devIndex }).trim()
  const develop2 = run(bare, ['commit-tree', devTree, '-p', develop, '-m', 'theirs']).trim()
  run(bare, ['update-ref', 'refs/heads/develop', develop2])
  run(wt, ['fetch', '-q', 'origin', 'develop'])
  return { ...s, pub, develop2 }
}

const merging = (wt) => {
  try {
    run(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
    return true
  } catch {
    return false
  }
}

test('merge --no-commit: a resolved, uncommitted merge is published as a two-parent commit with the stripped MERGE_MSG — no local commit — and advance ends clean with the merge state cleared', async () => {
  const s = await conflictScenario()
  try {
    const { wt, bare, git, client, pub, develop2 } = s
    const before = run(wt, ['rev-parse', 'HEAD']).trim()
    assert.throws(() => run(wt, ['merge', '--no-commit', 'origin/develop']))
    assert.match(status(wt), /^UU a\.txt/m)
    writeFileSync(join(wt, 'a.txt'), 'mine and theirs\n')
    run(wt, ['add', 'a.txt'])
    const indexTree = run(wt, ['write-tree']).trim()

    const head = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }))
    const out = await publishMerge({ git, client, owner: 'o', repo: 'r', branch: 'agent/x', head })
    assert.equal(out.kind, 'merge')
    assert.deepEqual(/** @type {any} */ (out).parents, [pub.commit.sha, develop2])
    // No local commit was made: HEAD has not moved, and the merge is still in progress.
    assert.equal(run(wt, ['rev-parse', 'HEAD']).trim(), before)
    assert.ok(merging(wt), 'publishMerge alone (--no-advance) leaves MERGE_HEAD in place')

    const remoteHead = run(bare, ['rev-parse', 'refs/heads/agent/x']).trim()
    assert.equal(remoteHead, out.commit.sha)
    assert.equal(run(bare, ['rev-parse', `${remoteHead}^{tree}`]).trim(), indexTree)
    assert.equal(
      run(bare, ['rev-list', '--parents', '-n', '1', remoteHead]).trim(),
      `${remoteHead} ${pub.commit.sha} ${develop2}`,
    )
    const message = run(bare, ['log', '-1', '--format=%B', remoteHead]).trim()
    assert.match(message, /^Merge remote-tracking branch 'origin\/develop'/)
    assert.doesNotMatch(message, /#|Conflicts/)

    run(wt, ['fetch', '-q', 'origin', 'agent/x'])
    const adv = advance({ git, target: out.commit.sha })
    assert.equal(adv.advanced, true, adv.reason)
    assert.equal(run(wt, ['rev-parse', 'HEAD']).trim(), out.commit.sha)
    assert.equal(status(wt), '')
    assert.equal(merging(wt), false)
  } finally {
    s.cleanup()
  }
})

test('merge --no-commit: an index with unmerged paths is refused, naming them, and nothing is published', async () => {
  const s = await conflictScenario()
  try {
    const { wt, bare, git, client, pub } = s
    assert.throws(() => run(wt, ['merge', '--no-commit', 'origin/develop']))
    const head = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }))
    await assert.rejects(
      publishMerge({ git, client, owner: 'o', repo: 'r', branch: 'agent/x', head }),
      /1 unmerged path in the index:\n\n {2}a\.txt\n/,
    )
    assert.equal(run(bare, ['rev-parse', 'refs/heads/agent/x']).trim(), pub.commit.sha)
    assert.ok(merging(wt))
  } finally {
    s.cleanup()
  }
})

test('merge --no-commit with hooks: pre-commit runs on the real index and what it stages ships; commit-msg runs on MERGE_MSG', async () => {
  const s = await conflictScenario(() =>
    hookScenario({
      'pre-commit': [
        'set -e',
        'git diff --cached --name-only > "$AGIT_TEST_OUT"',
        'printf "hooked\\n" >> a.txt',
        'git add a.txt',
      ].join('\n'),
      'commit-msg': 'printf "\\nReviewed-by: hook\\n" >> "$1"',
    }),
  )
  try {
    const { wt, bare, git, client, root } = s
    const seen = join(root, 'staged')
    process.env.AGIT_TEST_OUT = seen
    assert.throws(() => run(wt, ['merge', '--no-commit', 'origin/develop']))
    writeFileSync(join(wt, 'a.txt'), 'mine and theirs\n')
    run(wt, ['add', 'a.txt'])

    const head = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }))
    const out = await publishMerge({
      git, client, owner: 'o', repo: 'r', branch: 'agent/x', head, hooks: s.wire('agent/x', head.sha),
    })
    // The hook saw the resolved merge staged in the real index.
    assert.equal(readFileSync(seen, 'utf8'), 'a.txt\ntheirs.txt\n')
    assert.deepEqual(s.runner.ran, ['pre-commit', 'commit-msg'])
    const remoteHead = run(bare, ['rev-parse', 'refs/heads/agent/x']).trim()
    assert.equal(remoteHead, out.commit.sha)
    assert.equal(run(bare, ['show', `${remoteHead}:a.txt`]), 'mine and theirs\nhooked\n')
    const message = run(bare, ['log', '-1', '--format=%B', remoteHead]).trim()
    assert.match(message, /^Merge remote-tracking branch 'origin\/develop'[\s\S]*\n\nReviewed-by: hook$/)
    assert.doesNotMatch(message, /Conflicts/)
  } finally {
    delete process.env.AGIT_TEST_OUT
    s.cleanup()
  }
})

test('a retry after a lost response is a no-op success, not a failure', async () => {
  const s = scenario()
  try {
    const { wt, bare, git, client } = s
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    const base = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    const input = { git, client, owner: 'o', repo: 'r', branch: 'agent/x', message: 'feat: x', paths: ['a.txt'] }
    // The first publish lands; its response is "lost", so the worktree is
    // never advanced — it still sits on develop with a.txt modified.
    const first = await publishWorktree({ ...input, head: null, base })
    assert.equal(first.noop, false)
    const writes = client.calls.length

    // The retry resolves the branch the first run created. The worktree's
    // tree over the branch head is the head's own tree.
    const head = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }))
    run(wt, ['fetch', '-q', 'origin', 'agent/x'])
    const again = await publishWorktree({ ...input, head, base: null })
    assert.equal(again.noop, true)
    assert.deepEqual(again.commit, { sha: first.commit.sha, url: null, verified: null })
    assert.equal(again.created, false)
    assert.deepEqual(again.changed, [])
    // Nothing written: two GETs for the resolve, no blob, tree, commit or ref.
    assert.deepEqual(
      client.calls.slice(writes).map((c) => c.method),
      ['GET', 'GET'],
    )
    assert.equal(run(bare, ['rev-parse', 'refs/heads/agent/x']).trim(), first.commit.sha)

    // …and once advanced, a re-run with nothing dirty is the same answer.
    advance({ git, target: first.commit.sha })
    const clean = await publishWorktree({ ...input, head, base: null })
    assert.equal(clean.noop, true)
    assert.deepEqual(clean.changed, [])
  } finally {
    s.cleanup()
  }
})

test('a publish with nothing to publish onto a branch that does not exist yet is still refused', async () => {
  const s = scenario()
  try {
    const { git, client } = s
    const base = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    await assert.rejects(
      publishWorktree({ git, client, owner: 'o', repo: 'r', branch: 'agent/x', head: null, base, message: 'm', paths: null }),
      /no changes in worktree/,
    )
  } finally {
    s.cleanup()
  }
})

/** Run `fn` with console.log captured; returns the lines. */
async function captured(fn) {
  /** @type {string[]} */
  const lines = []
  const log = console.log
  console.log = (...args) => void lines.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.log = log
  }
  return lines
}

test('agit publish, retried after a lost response: says nothing was published, reuses the open PR, and still advances', async () => {
  const s = scenario()
  try {
    const { wt, bare, git, client } = s
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    const argv = ['agent/x', 'feat: x', '--paths', 'a.txt', '--base', 'develop', '--pr', 'X', '--repo', 'o/r', '-C', wt]
    // The first run lands the commit and opens the PR; its "response is lost"
    // before the worktree advances (--no-advance stands in for that).
    const first = await captured(() => runPublish([...argv, '--no-advance'], { client }))
    assert.ok(first.includes('published 1 path to o/r@agent/x'), first.join('\n'))
    assert.ok(first.includes('pr: https://github.com/o/r/pull/1'), first.join('\n'))
    const landed = run(bare, ['rev-parse', 'refs/heads/agent/x']).trim()

    const before = client.calls.length
    const again = await captured(() => runPublish(argv, { client }))
    assert.ok(
      again.includes('nothing to publish: o/r@agent/x already has this content — no commit made'),
      again.join('\n'),
    )
    assert.ok(again.includes('pr: https://github.com/o/r/pull/1 (already open)'), again.join('\n'))
    assert.ok(again.some((l) => l.startsWith(`worktree advanced to ${landed.slice(0, 7)}`)), again.join('\n'))
    // No second commit, ref move or PR.
    assert.deepEqual(
      client.calls.slice(before).filter((c) => c.method !== 'GET'),
      [],
    )
    assert.equal(run(bare, ['rev-parse', 'refs/heads/agent/x']).trim(), landed)
    assert.equal(run(wt, ['rev-parse', 'HEAD']).trim(), landed)
    assert.equal(status(wt), '')
  } finally {
    s.cleanup()
  }
})

test('merge: a locally resolved conflict is published as a two-parent commit with the resolved tree, and the worktree ends clean on it', async () => {
  const s = scenario()
  try {
    const { wt, bare, git, client } = s
    const develop = run(bare, ['rev-parse', 'refs/heads/develop']).trim()

    // agent/x: edits a.txt one way. develop: edits a.txt the other way, adds theirs.txt.
    run(wt, ['checkout', '-q', '-b', 'agent/x'])
    writeFileSync(join(wt, 'a.txt'), 'mine\n')
    run(wt, ['commit', '-qam', 'mine (local)'])
    const branchHeadLocal = run(wt, ['rev-parse', 'HEAD']).trim()
    // Put agent/x on "GitHub" the way the App would: publishWorktree from a
    // detached checkout of develop with the same edit.
    run(wt, ['checkout', '-q', '--detach', develop])
    writeFileSync(join(wt, 'a.txt'), 'mine\n')
    const pub = await publishWorktree({
      git,
      client,
      owner: 'o',
      repo: 'r',
      branch: 'agent/x',
      head: null,
      base: { sha: develop, tree: run(bare, ['rev-parse', `${develop}^{tree}`]).trim() },
      message: 'mine',
    })
    assert.notEqual(pub.commit.sha, branchHeadLocal) // the App's object, not the local one
    run(wt, ['fetch', '-q', 'origin'])
    advance({ git, target: pub.commit.sha })

    // develop moves on "GitHub" (someone else's merge), conflicting on a.txt.
    const devIndex = { GIT_INDEX_FILE: join(bare, 'dev-index') }
    run(bare, ['read-tree', develop], { env: devIndex })
    const theirsA = run(bare, ['hash-object', '-w', '--stdin'], { input: 'theirs\n' }).trim()
    const theirsT = run(bare, ['hash-object', '-w', '--stdin'], { input: 'theirs file\n' }).trim()
    run(bare, ['update-index', '--add', '--cacheinfo', `100644,${theirsA},a.txt`], {
      env: devIndex,
    })
    run(bare, ['update-index', '--add', '--cacheinfo', `100644,${theirsT},theirs.txt`], {
      env: devIndex,
    })
    const devTree = run(bare, ['write-tree'], { env: devIndex }).trim()
    const develop2 = run(bare, ['commit-tree', devTree, '-p', develop, '-m', 'theirs']).trim()
    run(bare, ['update-ref', 'refs/heads/develop', develop2])

    // The agent: fetch, merge, hit the conflict, resolve, commit.
    run(wt, ['fetch', '-q', 'origin', 'develop'])
    assert.throws(() => run(wt, ['merge', '--no-edit', 'origin/develop']))
    assert.match(status(wt), /^UU a\.txt/m)
    writeFileSync(join(wt, 'a.txt'), 'mine and theirs\n')
    run(wt, ['add', 'a.txt'])
    run(wt, ['commit', '-qm', "Merge branch 'develop' into agent/x"])
    const localMerge = run(wt, ['rev-parse', 'HEAD']).trim()
    const localTree = run(wt, ['rev-parse', 'HEAD^{tree}']).trim()

    const head = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }))
    assert.equal(head.sha, pub.commit.sha)
    const out = await publishMerge({ git, client, owner: 'o', repo: 'r', branch: 'agent/x', head })
    assert.equal(out.kind, 'merge')
    assert.deepEqual(out.parents, [pub.commit.sha, develop2])
    assert.deepEqual(out.shipped.uploaded, ['a.txt']) // theirs.txt came from develop, already there

    const remoteHead = run(bare, ['rev-parse', 'refs/heads/agent/x']).trim()
    assert.equal(remoteHead, out.commit.sha)
    assert.equal(run(bare, ['rev-parse', `${remoteHead}^{tree}`]).trim(), localTree)
    assert.equal(
      run(bare, ['rev-list', '--parents', '-n', '1', remoteHead]).trim(),
      `${remoteHead} ${pub.commit.sha} ${develop2}`,
    )
    assert.equal(run(bare, ['show', `${remoteHead}:a.txt`]), 'mine and theirs\n')
    // The merge base advanced: develop is now an ancestor of the branch.
    run(bare, ['merge-base', '--is-ancestor', develop2, remoteHead])

    // Advance leaves the local merge commit behind for its Verified equivalent.
    run(wt, ['fetch', '-q', 'origin', 'agent/x'])
    const adv = advance({ git, target: out.commit.sha })
    assert.equal(adv.advanced, true, adv.reason)
    assert.notEqual(localMerge, out.commit.sha)
    assert.equal(run(wt, ['rev-parse', 'HEAD']).trim(), out.commit.sha)
    assert.equal(status(wt), '')
  } finally {
    s.cleanup()
  }
})

test('merge of a stale branch: the tree is built on the merged-in parent, and GitHub rebuilds the local tree exactly', async () => {
  const s = scenario()
  try {
    const { wt, bare, git, client } = s
    const develop = run(bare, ['rev-parse', 'refs/heads/develop']).trim()

    // agent/x on "GitHub": one edit to a.txt, published by the App.
    run(wt, ['checkout', '-q', '--detach', develop])
    writeFileSync(join(wt, 'a.txt'), 'mine\n')
    const pub = await publishWorktree({
      git,
      client,
      owner: 'o',
      repo: 'r',
      branch: 'agent/x',
      head: null,
      base: { sha: develop, tree: run(bare, ['rev-parse', `${develop}^{tree}`]).trim() },
      message: 'mine',
    })
    run(wt, ['fetch', '-q', 'origin'])
    advance({ git, target: pub.commit.sha })

    // develop runs far ahead: six new files, none touching a.txt.
    const devIndex = { GIT_INDEX_FILE: join(bare, 'dev-index') }
    run(bare, ['read-tree', develop], { env: devIndex })
    for (let i = 0; i < 6; i++) {
      const blob = run(bare, ['hash-object', '-w', '--stdin'], { input: `dev ${i}\n` }).trim()
      run(bare, ['update-index', '--add', '--cacheinfo', `100644,${blob},dev/${i}.txt`], { env: devIndex })
    }
    const devTree = run(bare, ['write-tree'], { env: devIndex }).trim()
    const develop2 = run(bare, ['commit-tree', devTree, '-p', develop, '-m', 'ahead']).trim()
    run(bare, ['update-ref', 'refs/heads/develop', develop2])

    run(wt, ['fetch', '-q', 'origin', 'develop'])
    run(wt, ['merge', '-q', '--no-edit', 'origin/develop'])
    const localTree = run(wt, ['rev-parse', 'HEAD^{tree}']).trim()

    const head = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }))
    /** @type {string[]} */
    const reports = []
    const before = client.calls.length
    const out = await publishMerge({
      git,
      client,
      owner: 'o',
      repo: 'r',
      branch: 'agent/x',
      head,
      report: (line) => reports.push(line),
    })
    assert.equal(out.kind, 'merge')
    assert.ok(
      reports.includes('building the merge tree on the merged-in parent (1 path, vs 6 from the head)'),
      reports.join('\n'),
    )
    const trees = client.calls.slice(before).filter((c) => c.path === '/repos/o/r/git/trees')
    assert.equal(trees.length, 1)
    assert.equal(trees[0].body.base_tree, devTree)
    assert.deepEqual(
      trees[0].body.tree.map((e) => e.path),
      ['a.txt'],
    )
    const shipped = /** @type {any} */ (out).shipped
    assert.deepEqual(shipped.uploaded, []) // a.txt's blob is already the head's

    const remoteHead = run(bare, ['rev-parse', 'refs/heads/agent/x']).trim()
    assert.equal(run(bare, ['rev-parse', `${remoteHead}^{tree}`]).trim(), localTree)
    assert.equal(
      run(bare, ['rev-list', '--parents', '-n', '1', remoteHead]).trim(),
      `${remoteHead} ${pub.commit.sha} ${develop2}`,
    )
  } finally {
    s.cleanup()
  }
})

test('the ref update is a fast-forward: a branch that moved under the publish is refused, and the worktree is untouched', async () => {
  const s = scenario()
  try {
    const { wt, bare, git, client } = s
    const develop = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    writeFileSync(join(wt, 'a.txt'), 'mine\n')
    // Someone else moves develop between resolve and publish.
    const idx = { GIT_INDEX_FILE: join(bare, 'x-index') }
    run(bare, ['read-tree', develop.sha], { env: idx })
    const blob = run(bare, ['hash-object', '-w', '--stdin'], { input: 'else\n' }).trim()
    run(bare, ['update-index', '--add', '--cacheinfo', `100644,${blob},else.txt`], { env: idx })
    const moved = run(bare, [
      'commit-tree',
      run(bare, ['write-tree'], { env: idx }).trim(),
      '-p',
      develop.sha,
      '-m',
      'else',
    ]).trim()
    run(bare, ['update-ref', 'refs/heads/develop', moved])

    await assert.rejects(
      publishWorktree({
        git,
        client,
        owner: 'o',
        repo: 'r',
        branch: 'develop',
        head: develop,
        base: null,
        message: 'race',
      }),
      /422/,
    )
    assert.equal(run(bare, ['rev-parse', 'refs/heads/develop']).trim(), moved)
    assert.equal(status(wt), ' M a.txt')
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The repository's git hooks, run by the publish path (git-hooks.mjs)
// ---------------------------------------------------------------------------

test('hooks: pre-commit sees exactly the published paths staged, and what it re-stages is what ships', async () => {
  const s = hookScenario({
    // A formatter: uppercases every staged .txt and re-stages it. It must
    // see a.txt (in scope) and never d/c.txt (dirty, out of scope).
    'pre-commit': [
      'set -e',
      'git diff --cached --name-only > "$AGIT_TEST_OUT"',
      'for f in $(git diff --cached --name-only -- "*.txt"); do',
      '  tr a-z A-Z < "$f" > "$f.tmp" && mv "$f.tmp" "$f" && git add -- "$f"',
      'done',
    ].join('\n'),
  })
  try {
    const { wt, bare, git, client } = s
    const seen = join(s.root, 'staged')
    process.env.AGIT_TEST_OUT = seen
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    writeFileSync(join(wt, 'd/c.txt'), 'out of scope\n')
    const base = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    const out = await publishWorktree({
      git, client, owner: 'o', repo: 'r', branch: 'agent/h', head: null, base,
      message: 'feat: h', paths: ['a.txt'], hooks: s.wire('agent/h', null),
    })
    assert.equal(readFileSync(seen, 'utf8'), 'a.txt\n')
    const head = run(bare, ['rev-parse', 'refs/heads/agent/h']).trim()
    assert.equal(head, out.commit.sha)
    assert.equal(run(bare, ['show', `${head}:a.txt`]), 'CHANGED\n')
    assert.equal(run(bare, ['show', `${head}:d/c.txt`]), 'three\n')
    assert.deepEqual(s.runner.ran, ['pre-commit'])
  } finally {
    delete process.env.AGIT_TEST_OUT
    s.cleanup()
  }
})

test('hooks: commit-msg may rewrite the message, and the rewritten message is the one GitHub commits', async () => {
  const s = hookScenario({
    'prepare-commit-msg': '[ "$2" = message ] || exit 3',
    'commit-msg': 'printf "\\nReviewed-by: hook\\n" >> "$1"',
  })
  try {
    const { wt, bare, git, client } = s
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    const base = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    await publishWorktree({
      git, client, owner: 'o', repo: 'r', branch: 'agent/m', head: null, base,
      message: 'feat: m', paths: ['a.txt'], hooks: s.wire('agent/m', null),
    })
    assert.equal(run(bare, ['log', '-1', '--format=%B', 'refs/heads/agent/m']).trim(), 'feat: m\n\nReviewed-by: hook')
    assert.deepEqual(s.runner.ran, ['prepare-commit-msg', 'commit-msg'])
  } finally {
    s.cleanup()
  }
})

test('hooks: pre-push gets git\'s stdin protocol for a local twin of the commit, before anything is sent', async () => {
  const s = hookScenario({ 'pre-push': 'cat > "$AGIT_TEST_OUT"; echo "$1 $2" >> "$AGIT_TEST_OUT"' })
  try {
    const { wt, bare, git, client, root } = s
    const seen = join(root, 'push')
    process.env.AGIT_TEST_OUT = seen
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    const base = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    const out = await publishWorktree({
      git, client, owner: 'o', repo: 'r', branch: 'agent/p', head: null, base,
      message: 'feat: p', paths: ['a.txt'], hooks: s.wire('agent/p', null),
    })
    const [line, argsLine] = readFileSync(seen, 'utf8').trim().split('\n')
    const [lref, lsha, rref, rsha] = line.split(' ')
    assert.equal(lref, 'refs/heads/agent/p')
    assert.equal(rref, 'refs/heads/agent/p')
    assert.equal(rsha, ZERO_SHA)
    // The twin has the published commit's tree and parent — only the sha differs.
    const published = run(bare, ['rev-parse', 'refs/heads/agent/p']).trim()
    assert.equal(published, out.commit.sha)
    assert.equal(run(wt, ['rev-parse', `${lsha}^{tree}`]).trim(), run(bare, ['rev-parse', `${published}^{tree}`]).trim())
    assert.equal(run(wt, ['rev-parse', `${lsha}^`]).trim(), base.sha)
    assert.match(argsLine, /^origin /)
  } finally {
    delete process.env.AGIT_TEST_OUT
    s.cleanup()
  }
})

test('hooks: a failing hook refuses the publish and nothing reaches GitHub', async () => {
  const s = hookScenario({ 'pre-push': 'echo "tests failed" >&2; exit 1' })
  try {
    const { wt, bare, git, client } = s
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    const base = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    const before = client.calls.length
    await assert.rejects(
      publishWorktree({
        git, client, owner: 'o', repo: 'r', branch: 'agent/f', head: null, base,
        message: 'feat: f', paths: ['a.txt'], hooks: s.wire('agent/f', null),
      }),
      (err) => err instanceof PublishError && /`pre-push` hook exited 1/.test(err.message),
    )
    assert.deepEqual(client.calls.slice(before), [])
    assert.throws(() => run(bare, ['rev-parse', '--verify', 'refs/heads/agent/f']))
  } finally {
    s.cleanup()
  }
})

test('hooks: a required hook that is missing refuses; a skipped runner runs nothing', async () => {
  const s = hookScenario({})
  try {
    const config = merge(DEFAULTS, { hooks: { path: '.githooks', required: ['pre-push'] } })
    const strict = hookRunner({ git: s.git, root: s.wt, config })
    assert.throws(() => strict.prePush({ branch: 'x', localSha: ZERO_SHA, remoteSha: null }), /`pre-push` hook is required/)
    const skipped = hookRunner({ git: s.git, root: s.wt, config, skip: true })
    skipped.prePush({ branch: 'x', localSha: ZERO_SHA, remoteSha: null })
    assert.deepEqual(skipped.ran, [])
  } finally {
    s.cleanup()
  }
})
