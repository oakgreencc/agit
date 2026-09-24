// @ts-check
/**
 * Shared fixtures for the tests that run the publish path against REAL git,
 * with a bare repository standing in for GitHub. Not a test file itself (no
 * `.test.` in the name), so the runner does not execute it.
 *
 * `fakeGitHub` is the one fake GitHub adapter: it implements the Git
 * Database endpoints with plumbing on a bare repo, so tree shas are real.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, merge } from '../src/config.mjs'
import { hookRunner } from '../src/git-hooks.mjs'

/**
 * Every git call here runs with the global and system config MASKED. A
 * developer's `~/.gitconfig` may carry `commit.gpgsign=true` and a signing
 * program behind a biometric prompt — so an unmasked `git commit` in a scratch
 * repo reaches for that key, hangs, and dies.
 */
export const GIT_ENV = {
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
export const run = (dir, args, opts = {}) =>
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
export const must = (value) => {
  assert.ok(value != null, 'expected a value')
  return value
}

/** The `git` the operations take: runs in the worktree, honours env + encoding. */
export const gitIn =
  (dir) =>
  (args, opts = {}) =>
    run(dir, args, opts)

/**
 * A GitHub that is a bare repo. Each endpoint is the plumbing it corresponds
 * to; `POST /git/trees` in particular rebuilds the tree from `base_tree` and
 * the entries exactly as the API does, so its answer is an independent sha.
 */
export function fakeGitHub(bare) {
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
export function scenario() {
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

export const status = (wt) => run(wt, ['status', '--porcelain', '-uall']).replace(/\n$/, '')

/** A worktree with tracked hooks in `.githooks`, and the runner publish builds. */
export function hookScenario(hooks) {
  const s = scenario()
  const dir = join(s.wt, '.githooks')
  mkdirSync(dir)
  for (const [name, body] of Object.entries(hooks)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  const config = merge(DEFAULTS, { hooks: { path: '.githooks' } })
  const runner = hookRunner({ git: s.git, root: s.wt, config, spawn: quietSpawn })
  /** The wiring the CLI uses: `runner.forPublish`. */
  const wire = (branch, remoteSha) => runner.forPublish({ branch, remoteSha })
  return { ...s, runner, wire }
}

/** The runner's spawn, with the hook's output captured instead of sent to stderr. */
export const quietSpawn = (file, args, opts) =>
  spawnSync(file, args, { ...opts, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], encoding: 'utf8', env: { ...opts.env, ...GIT_ENV } })
