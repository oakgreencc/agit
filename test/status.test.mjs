// @ts-check
/**
 * `agit status`: is anything in this worktree not on GitHub? Real git, with
 * the bare-repo fake standing in for GitHub — the answer must come from the
 * API, never from the worktree's own (possibly stale or pruned) remote refs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { advance, publishWorktree, resolveBranch } from '../src/publish/publish.mjs'
import { localOnly, statusLines, verdict } from '../src/status.mjs'
import { must, run, scenario } from './fixtures.mjs'

/** Publish `a.txt` to agent/x and advance the worktree onto it, as `agit publish` does. */
async function published(s) {
  const { wt, git, client } = s
  writeFileSync(join(wt, 'a.txt'), 'changed\n')
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
    paths: ['a.txt'],
  })
  run(wt, ['fetch', '-q', 'origin', 'agent/x'])
  must(advance({ git, target: out.commit.sha }).advanced)
  return out.commit.sha
}

/** A local commit on top of HEAD — work nobody published. */
function wip(s) {
  writeFileSync(join(s.wt, 'b.txt'), 'wip\n')
  run(s.wt, ['commit', '-qam', 'wip'])
  return run(s.wt, ['rev-parse', 'HEAD']).trim()
}

const ask = (s, branch = null) =>
  localOnly({ git: s.git, client: s.client, owner: 'o', repo: 'r', base: 'develop', branch })

test('the verdict: nothing local, or exactly what a removal would lose', () => {
  const clean = { head: 'a'.repeat(40), local: 'wt', dirty: [], unpublished: [], pulls: [], checkedAgainst: ['develop'] }
  assert.equal(verdict(clean), 'nothing local that GitHub does not have')
  assert.equal(
    verdict({ ...clean, dirty: ['b.txt'], unpublished: ['c'.repeat(40), 'd'.repeat(40)] }),
    'local only (not on GitHub): 1 uncommitted path, 2 commits',
  )
  const out = statusLines({
    ...clean,
    unpublished: ['c'.repeat(40)],
    pulls: [{ number: 3, merged: true, state: 'closed', head: 'agent/x', headSha: 'e'.repeat(40), base: 'develop', url: 'u' }],
  })
  assert.ok(out.includes('  ccccccc'), out.join('\n'))
  assert.ok(out.includes('PR #3 (agent/x → develop): merged  u'), out.join('\n'))
  assert.equal(out.at(-1), 'local only (not on GitHub): 1 commit')
})

test('after a publish, only the uncommitted paths it left behind are local', async () => {
  const s = scenario()
  try {
    const sha = await published(s)
    writeFileSync(join(s.wt, 'b.txt'), 'not published\n')
    const out = await ask(s)
    assert.equal(out.head, sha)
    assert.deepEqual(out.dirty, ['b.txt'])
    assert.deepEqual(out.unpublished, [])
  } finally {
    s.cleanup()
  }
})

test('a local commit GitHub does not have is reported; the published one under it is not', async () => {
  const s = scenario()
  try {
    await published(s)
    const w = wip(s)
    // No <branch> named, and the local branch is not on GitHub: the
    // remote-tracking ref for agent/x is the claim, and GitHub confirms it.
    const out = await ask(s)
    assert.deepEqual(out.unpublished, [w])
    assert.deepEqual(out.dirty, [])
  } finally {
    s.cleanup()
  }
})

test('with every remote-tracking ref pruned, the named branch still clears what it holds', async () => {
  const s = scenario()
  try {
    await published(s)
    const w = wip(s)
    run(s.wt, ['update-ref', '-d', 'refs/remotes/origin/agent/x'])
    run(s.wt, ['update-ref', '-d', 'refs/remotes/origin/develop'])
    assert.deepEqual((await ask(s, 'agent/x')).unpublished, [w])
  } finally {
    s.cleanup()
  }
})

test('a squash-merged PR whose branch is gone is not local work (#5)', async () => {
  const s = scenario()
  try {
    const sha = await published(s)
    // GitHub: #3 squash-merges into develop, agent/x is deleted. Only the PR
    // still knows the commit (refs/pull/3/head).
    s.client.openPull(3, 'agent/x', 'develop')
    const squash = run(s.bare, ['commit-tree', `${sha}^{tree}`, '-p', 'refs/heads/develop', '-m', 'x (#3)']).trim()
    run(s.bare, ['update-ref', 'refs/heads/develop', squash])
    must(s.client.pulls.get(3)).merged = true
    run(s.bare, ['update-ref', '-d', 'refs/heads/agent/x'])
    // Locally: the tracking ref is pruned, and develop was never re-fetched.
    run(s.wt, ['update-ref', '-d', 'refs/remotes/origin/agent/x'])

    const out = await ask(s)
    assert.deepEqual(out.unpublished, [])
    assert.deepEqual(
      out.pulls.map((p) => [p.number, p.merged]),
      [[3, true]],
    )
  } finally {
    s.cleanup()
  }
})

test('a stale remote-tracking ref does not vouch for a commit GitHub no longer has', async () => {
  const s = scenario()
  try {
    const sha = await published(s)
    // GitHub: agent/x is force-moved back to develop. Locally origin/agent/x
    // still points at the published commit — and so does HEAD.
    run(s.bare, ['update-ref', 'refs/heads/agent/x', 'refs/heads/develop'])
    assert.deepEqual((await ask(s, 'agent/x')).unpublished, [sha])
    const w = wip(s)
    assert.deepEqual((await ask(s, 'agent/x')).unpublished, [w, sha])
  } finally {
    s.cleanup()
  }
})

test('the branch named is asked for its PR even when HEAD is not on GitHub', async () => {
  const s = scenario()
  try {
    await published(s)
    s.client.openPull(4, 'agent/x', 'develop')
    wip(s)
    assert.deepEqual(
      (await ask(s, 'agent/x')).pulls.map((p) => [p.number, p.merged]),
      [[4, false]],
    )
  } finally {
    s.cleanup()
  }
})
