// @ts-check
/**
 * The operations against REAL git, with a bare repository standing in for
 * GitHub.
 *
 * `publish.test.mjs` pins the request shapes with fakes. This file answers
 * the question the fakes cannot: does the tree the tool builds locally come
 * out byte-identical when GitHub rebuilds it from `base_tree` + entries? The
 * fake GitHub below implements the four Git Database endpoints with git
 * plumbing on a bare repo, so the sha equality check in `publishTree` is
 * exercised for real — modes, deletions, untracked files, a merge.
 *
 * No network, no credentials, no `git push`: the "remote" is a directory.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, merge } from '../src/config.mjs'
import { ZERO_SHA, hookRunner, previewCommit } from '../src/git-hooks.mjs'
import {
  PublishError,
  advance,
  publishMerge,
  publishWorktree,
  resolveBranch,
} from '../src/publish/publish.mjs'

/**
 * Every git call here runs with the global and system config MASKED. A
 * developer's `~/.gitconfig` may carry `commit.gpgsign=true` and a signing
 * program behind a biometric prompt — so an unmasked `git commit` in a scratch
 * repo reaches for that key, hangs, and dies.
 */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

/**
 * @param {string} dir
 * @param {string[]} args
 * @param {{ encoding?: 'utf8' | 'buffer', input?: string, env?: Record<string, string> }} [opts]
 * @returns {any} a string, or a Buffer under `encoding: 'buffer'`
 */
const run = (dir, args, opts = {}) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: opts.encoding === 'buffer' ? null : 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: opts.input,
    env: { ...process.env, ...GIT_ENV, ...(opts.env ?? {}) },
  })

/**
 * A value the test needs to exist. `resolveBranch` answers `null` for a branch
 * GitHub does not have, and `advance` reports `recorded` only when it moved.
 *
 * @template T
 * @param {T | null | undefined} value
 * @returns {T}
 */
const must = (value) => {
  assert.ok(value != null, 'expected a value')
  return value
}

/** The `git` the operations take: runs in the worktree, honours env + encoding. */
const gitIn =
  (dir) =>
  (args, opts = {}) =>
    run(dir, args, opts)

/**
 * A GitHub that is a bare repo. Each endpoint is the plumbing it corresponds
 * to; `POST /git/trees` in particular rebuilds the tree from `base_tree` and
 * the entries exactly as the API does, so its answer is an independent sha.
 */
function fakeGitHub(bare) {
  const g = (args, opts) => run(bare, args, opts)
  const err = (status, path) => new Error(`${path}: ${status} {"message":"nope"}`)
  const calls = []
  async function handle(method, path, body) {
    calls.push({ method, path, body })
    const key = `${method} ${path}`
    const ref = /^GET \/repos\/o\/r\/git\/ref\/heads\/(.+)$/.exec(key)
    if (ref) {
      try {
        return { object: { sha: g(['rev-parse', '--verify', `refs/heads/${ref[1]}`]).trim() } }
      } catch {
        throw err(404, path)
      }
    }
    const commit = /^GET \/repos\/o\/r\/git\/commits\/([0-9a-f]{40})$/.exec(key)
    if (commit) {
      try {
        return { sha: commit[1], tree: { sha: g(['rev-parse', `${commit[1]}^{tree}`]).trim() } }
      } catch {
        throw err(404, path)
      }
    }
    if (key === 'POST /repos/o/r/git/blobs') {
      return {
        sha: g(['hash-object', '-w', '--stdin'], {
          input: Buffer.from(body.content, 'base64'),
        }).trim(),
      }
    }
    if (key === 'POST /repos/o/r/git/trees') {
      const env = { GIT_INDEX_FILE: join(bare, 'api-index') }
      try {
        unlinkSync(env.GIT_INDEX_FILE)
      } catch {}
      g(['read-tree', body.base_tree], { env })
      for (const e of body.tree) {
        // "Use either tree.sha or content" — both, or neither, is a 422.
        assert.notEqual(e.sha !== undefined, e.content !== undefined, `tree entry ${e.path}`)
        // `content` is a JSON string, so what GitHub stores is its UTF-8 bytes.
        const sha =
          e.content !== undefined
            ? g(['hash-object', '-w', '--stdin'], { input: Buffer.from(e.content, 'utf8') }).trim()
            : e.sha
        // --force-remove insists on a work tree even with nothing to touch; any directory will do.
        if (sha === null)
          g(['update-index', '--force-remove', '--', e.path], {
            env: { ...env, GIT_WORK_TREE: bare },
          })
        else g(['update-index', '--add', '--cacheinfo', `${e.mode},${sha},${e.path}`], { env })
      }
      return { sha: g(['write-tree'], { env }).trim() }
    }
    if (key === 'POST /repos/o/r/git/commits') {
      // The contract under test: no author/committer/signature. The fake
      // signs by refusing anything else, the way GitHub silently would not.
      assert.deepEqual(Object.keys(body).sort(), ['message', 'parents', 'tree'])
      // GitHub fills in the App as author and itself as committer — which is
      // also what makes the App's commit a different object from a local one
      // with the same tree, parents and message.
      const sha = g(
        ['commit-tree', body.tree, ...body.parents.flatMap((p) => ['-p', p]), '-m', body.message],
        {
          env: {
            GIT_AUTHOR_NAME: 'sektor-agents[bot]',
            GIT_AUTHOR_EMAIL: 'bot@users.noreply.github.com',
            GIT_COMMITTER_NAME: 'GitHub',
            GIT_COMMITTER_EMAIL: 'noreply@github.com',
          },
        },
      ).trim()
      return {
        sha,
        html_url: `https://github.com/o/r/commit/${sha}`,
        verification: { verified: true, reason: 'valid' },
      }
    }
    const patch = /^PATCH \/repos\/o\/r\/git\/refs\/heads\/(.+)$/.exec(key)
    if (patch) {
      const old = g(['rev-parse', `refs/heads/${patch[1]}`]).trim()
      try {
        g(['merge-base', '--is-ancestor', old, body.sha])
      } catch {
        throw err(422, path)
      }
      g(['update-ref', `refs/heads/${patch[1]}`, body.sha, old])
      return {}
    }
    if (key === 'POST /repos/o/r/git/refs') {
      g(['update-ref', body.ref, body.sha])
      return {}
    }
    // The release path's one extra endpoint (release.mjs): the repository
    // node id `updateRefs` addresses. No `POST /git/tags` — the release
    // makes no tag object (see `graphql` below).
    if (key === 'GET /repos/o/r') return { node_id: 'R_bare' }
    throw err(404, path)
  }
  /**
   * GraphQL `updateRefs`, as a `git update-ref --stdin` transaction: every
   * line is checked before any ref moves, so a stale `beforeOid` or an
   * existing tag rejects the whole batch — the property the release path
   * relies on for "branch and tags together or not at all".
   *
   * `afterOid` must name a COMMIT. GitHub refuses a tag object with
   * `Invalid object type tag, expected commit` — which is what the first
   * live run of the release path hit (CD 34903903689, 2026-09-14) and why
   * the tags are lightweight. The fake refuses the same way.
   */
  async function graphql(query, variables) {
    calls.push({ method: 'GRAPHQL', path: 'updateRefs', body: variables })
    assert.match(query, /updateRefs\(/)
    const lines = variables.input.refUpdates.map(({ name, beforeOid, afterOid, force }) => {
      assert.equal(force, false)
      const type = g(['cat-file', '-t', afterOid]).trim()
      if (type !== 'commit') {
        throw new Error(
          `graphql: [{"type":"UNPROCESSABLE","path":["updateRefs"],"message":"Invalid object type ${type}, expected commit"}]`,
        )
      }
      return /^0{40}$/.test(beforeOid)
        ? `create ${name} ${afterOid}`
        : `update ${name} ${afterOid} ${beforeOid}`
    })
    try {
      g(['update-ref', '--stdin'], { input: `start\n${lines.join('\n')}\ncommit\n` })
    } catch (e) {
      throw new Error(
        `graphql: [{"type":"UNPROCESSABLE","message":${JSON.stringify(String(/** @type {any} */ (e).stderr ?? /** @type {any} */ (e).message))}}]`,
      )
    }
    return { updateRefs: { clientMutationId: null } }
  }
  return {
    calls,
    api: (path, init = {}) =>
      handle(
        (init.method ?? 'GET').toUpperCase(),
        path,
        init.body ? JSON.parse(init.body) : undefined,
      ),
    json: (path, method, body) => handle(method, path, body),
    graphql,
  }
}

/** A worktree cloned from a fresh bare "GitHub" with one base commit on `develop`. */
function scenario() {
  const root = mkdtempSync(join(tmpdir(), 'publish-it-'))
  const seed = join(root, 'seed')
  mkdirSync(seed)
  run(seed, ['init', '-q', '-b', 'develop'])
  writeFileSync(join(seed, 'a.txt'), 'one\n')
  writeFileSync(join(seed, 'b.txt'), 'two\n')
  mkdirSync(join(seed, 'd'))
  writeFileSync(join(seed, 'd/c.txt'), 'three\n')
  run(seed, ['add', '.'])
  run(seed, ['commit', '-qm', 'base'])
  const bare = join(root, 'origin.git')
  run(root, ['clone', '-q', '--bare', seed, bare])
  const wt = join(root, 'wt')
  run(root, ['clone', '-q', bare, wt])
  run(wt, ['config', 'commit.gpgsign', 'false'])
  return {
    root,
    bare,
    wt,
    git: gitIn(wt),
    client: fakeGitHub(bare),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

const status = (wt) => run(wt, ['status', '--porcelain', '-uall']).replace(/\n$/, '')

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

/** A worktree with tracked hooks in `.githooks`, and the runner publish builds. */
function hookScenario(hooks) {
  const s = scenario()
  const dir = join(s.wt, '.githooks')
  mkdirSync(dir)
  for (const [name, body] of Object.entries(hooks)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  const config = merge(DEFAULTS, { hooks: { path: '.githooks' } })
  const runner = hookRunner({ git: s.git, root: s.wt, config, spawn: quietSpawn })
  const wire = (branch, remoteSha) => ({
    preCommit: (env) => runner.preCommit(env),
    commitMessage: (m) => runner.commitMessage(m),
    prePush: ({ tree, parents, message }) =>
      runner.prePush({ branch, localSha: previewCommit({ git: s.git, tree, parents, message }), remoteSha }),
  })
  return { ...s, runner, wire }
}

/** The runner's spawn, with the hook's output captured instead of sent to stderr. */
const quietSpawn = (file, args, opts) =>
  spawnSync(file, args, { ...opts, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], encoding: 'utf8', env: { ...opts.env, ...GIT_ENV } })

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
