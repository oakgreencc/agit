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
