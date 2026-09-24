// @ts-check
/**
 * The publish plan against real git: the gates judge the CANDIDATE — the tree
 * as built — so what the pre-commit hook stages is judged like anything else,
 * displacement is judged over what lands, and a merge over its resolution.
 * See src/publish/plan.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULTS } from '../src/config.mjs'
import { judgeCandidate } from '../src/publish/plan.mjs'
import { PublishError, advance, publishMerge, publishWorktree, resolveBranch } from '../src/publish/publish.mjs'
import { policyFrom } from '../src/protected.mjs'
import { commitOn, hookScenario, must, run, scenario } from './fixtures.mjs'

/** A protection policy owning `secret/`, as a base's CODEOWNERS would. */
const POLICY = policyFrom((p) => (p === 'CODEOWNERS' ? '/secret/ @alice\n' : null))
const NO_GRANT = { state: 'none' }
const PROTECTED_GRANT = {
  state: 'active',
  session: 's',
  grant: { reason: 'rotate the key', scopes: ['protected'], grantedAt: '', expiresAt: '2099-01-01T00:00:00Z', session: 's', via: 't' },
}

/** The CLI's gate, minus the CLI: judgeCandidate with a fixed policy and grant; notes and candidates collected. */
function gateFor(git, { grant = NO_GRANT, policies = [POLICY], allowDisplacement = false } = {}) {
  /** @type {string[]} */
  const notes = []
  /** @type {import('../src/publish/publish.mjs').Candidate[]} */
  const seen = []
  const gate = (candidate) => {
    seen.push(candidate)
    notes.push(
      ...judgeCandidate({
        git,
        candidate,
        policies,
        grant: /** @type {any} */ (grant),
        payload: DEFAULTS.payload,
        overrides: { allowDisplacement },
        names: { base: 'develop', branch: 'agent/x' },
      }),
    )
  }
  return { gate, notes, seen }
}

const writesSince = (client, from) => client.calls.slice(from).filter((c) => c.method !== 'GET')

const STAGE_SECRET = 'mkdir -p secret && echo generated > secret/key.txt && git add secret/key.txt'

test('plan: a path the pre-commit hook stages is judged — a protected one refuses, and nothing is written', async () => {
  const s = hookScenario({ 'pre-commit': STAGE_SECRET })
  try {
    const { wt, bare, git, client } = s
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    const base = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    const before = client.calls.length
    const { gate, seen } = gateFor(git)
    await assert.rejects(
      publishWorktree({
        git, client, owner: 'o', repo: 'r', branch: 'agent/x', head: null, base,
        message: 'feat: x', paths: ['a.txt'], hooks: s.wire('agent/x', null), gate,
      }),
      (err) =>
        err instanceof PublishError &&
        /1 path is protected/.test(err.message) &&
        /secret\/key\.txt — owned by @alice/.test(err.message),
    )
    // The gate saw the tree as built: the hook's path alongside the named one.
    assert.deepEqual(seen[0].paths, ['a.txt', 'secret/key.txt'])
    assert.deepEqual(writesSince(client, before), [])
    assert.throws(() => run(bare, ['rev-parse', '--verify', 'refs/heads/agent/x']))
  } finally {
    s.cleanup()
  }
})

test("plan: with a protected grant the hook's path ships, the lift is a note, and the count is what landed", async () => {
  const s = hookScenario({ 'pre-commit': STAGE_SECRET })
  try {
    const { wt, bare, git, client } = s
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    const base = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    const { gate, notes } = gateFor(git, { grant: PROTECTED_GRANT })
    const out = await publishWorktree({
      git, client, owner: 'o', repo: 'r', branch: 'agent/x', head: null, base,
      message: 'feat: x', paths: ['a.txt'], hooks: s.wire('agent/x', null), gate,
    })
    assert.deepEqual(out.changed, ['a.txt', 'secret/key.txt']) // what "published N paths" counts
    assert.equal(run(bare, ['show', `${out.commit.sha}:secret/key.txt`]), 'generated\n')
    assert.match(notes.join('\n'), /published under maintainer grant \("rotate the key"\): secret\/key\.txt/)
  } finally {
    s.cleanup()
  }
})

test('plan: a *.log the pre-commit hook stages is refused by the payload gate', async () => {
  const s = hookScenario({ 'pre-commit': 'echo "build output" > build.log && git add build.log' })
  try {
    const { wt, git, client } = s
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    const base = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
    const before = client.calls.length
    await assert.rejects(
      publishWorktree({
        git, client, owner: 'o', repo: 'r', branch: 'agent/x', head: null, base,
        message: 'feat: x', paths: ['a.txt'], hooks: s.wire('agent/x', null), gate: gateFor(git).gate,
      }),
      (err) => err instanceof PublishError && /build\.log — never published/.test(err.message),
    )
    assert.deepEqual(writesSince(client, before), [])
  } finally {
    s.cleanup()
  }
})

/** develop moves on "GitHub": each of `files` gets new content in one new commit. */
const moveDevelop = (bare, files) => commitOn(bare, 'develop', files)

test('plan: displacement is judged over the paths that land — a stale path refuses, a stale bystander does not', async () => {
  const s = scenario()
  try {
    const { wt, bare, git, client } = s
    moveDevelop(bare, { 'a.txt': 'someone else\n' })
    run(wt, ['fetch', '-q', 'origin', 'develop'])
    const head = { ...must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' })), branch: 'develop' }
    const publish = (paths) =>
      publishWorktree({ git, client, owner: 'o', repo: 'r', branch: 'develop', head, base: null, message: 'm', paths, gate: gateFor(git).gate })

    // Publishing a.txt from a worktree that never saw the other change: refused.
    writeFileSync(join(wt, 'a.txt'), 'mine\n')
    await assert.rejects(
      publish(['a.txt']),
      (err) => err instanceof PublishError && /would revert 1 file/.test(err.message) && /^ {2}a\.txt$/m.test(err.message),
    )

    // Publishing only b.txt — even with --all — lands no a.txt: the stale
    // a.txt is not in the tree's diff, so nothing is displaced.
    run(wt, ['checkout', '--', 'a.txt'])
    writeFileSync(join(wt, 'b.txt'), 'mine\n')
    const out = await publish(null)
    assert.deepEqual(out.changed, ['b.txt'])
    assert.equal(run(bare, ['show', `${out.commit.sha}:a.txt`]), 'someone else\n')
  } finally {
    s.cleanup()
  }
})

/** agent/x published from develop with a.txt changed; the worktree advanced onto it. */
async function onAgentBranch({ wt, git, client }) {
  run(wt, ['checkout', '-q', '-b', 'agent/x'])
  writeFileSync(join(wt, 'a.txt'), 'mine\n')
  const develop = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'develop' }))
  const pub = await publishWorktree({ git, client, owner: 'o', repo: 'r', branch: 'agent/x', head: null, base: develop, message: 'mine' })
  run(wt, ['fetch', '-q', 'origin'])
  advance({ git, target: pub.commit.sha })
}

test('plan: a merge is judged on its resolution — a protected path taken whole from the other side passes, a resolved one refuses', async () => {
  const s = scenario()
  try {
    const { wt, bare, git, client } = s
    await onAgentBranch(s)
    // develop gains a protected file (reviewed there) and conflicts on a.txt.
    moveDevelop(bare, { 'a.txt': 'theirs\n', 'secret/theirs.txt': 'reviewed upstream\n' })
    run(wt, ['fetch', '-q', 'origin', 'develop'])
    assert.throws(() => run(wt, ['merge', '--no-edit', 'origin/develop']))
    writeFileSync(join(wt, 'a.txt'), 'mine and theirs\n')
    run(wt, ['add', 'a.txt'])
    run(wt, ['commit', '-qm', "Merge branch 'develop' into agent/x"])
    const head = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }))

    // a.txt protected: the resolution is the agent's own, so it refuses — before any write.
    const strict = policyFrom((p) => (p === 'CODEOWNERS' ? '/a.txt @alice\n/secret/ @alice\n' : null))
    const before = client.calls.length
    const refusing = gateFor(git, { policies: [strict] })
    await assert.rejects(
      publishMerge({ git, client, owner: 'o', repo: 'r', branch: 'agent/x', head, gate: refusing.gate }),
      (err) => err instanceof PublishError && /^ {2}a\.txt — owned by @alice/m.test(err.message),
    )
    assert.deepEqual(refusing.seen[0].paths, ['a.txt'])
    assert.deepEqual(writesSince(client, before), [])

    // Only secret/ protected: secret/theirs.txt came whole from develop, so it passes.
    const out = await publishMerge({ git, client, owner: 'o', repo: 'r', branch: 'agent/x', head, gate: gateFor(git).gate })
    assert.equal(out.kind, 'merge')
    assert.equal(run(bare, ['show', `${out.commit.sha}:secret/theirs.txt`]), 'reviewed upstream\n')
  } finally {
    s.cleanup()
  }
})

test('plan: a merge runs commit-msg on a --message override, and pre-push on a twin of what lands', async () => {
  const s = hookScenario({
    'commit-msg': 'printf "\\nChecked-by: hook\\n" >> "$1"',
    'pre-push': 'cat > "$AGIT_TEST_OUT"',
  })
  try {
    const { wt, bare, git, client, root } = s
    const seen = join(root, 'push')
    process.env.AGIT_TEST_OUT = seen
    await onAgentBranch(s)
    moveDevelop(bare, { 'b.txt': 'theirs\n' })
    run(wt, ['fetch', '-q', 'origin', 'develop'])
    run(wt, ['merge', '--no-edit', 'origin/develop'])
    const localMergeSha = run(wt, ['rev-parse', 'HEAD']).trim()
    const head = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }))

    const out = await publishMerge({
      git, client, owner: 'o', repo: 'r', branch: 'agent/x', head, message: 'merge develop', hooks: s.wire('agent/x', head.sha),
    })
    assert.equal(run(bare, ['log', '-1', '--format=%B', out.commit.sha]).trim(), 'merge develop\n\nChecked-by: hook')
    // The message changed, so pre-push saw a twin with the merge's tree — not the local commit.
    const [, lsha] = readFileSync(seen, 'utf8').trim().split(' ')
    assert.notEqual(lsha, localMergeSha)
    assert.equal(run(wt, ['rev-parse', `${lsha}^{tree}`]).trim(), run(wt, ['rev-parse', `${localMergeSha}^{tree}`]).trim())
    assert.deepEqual(s.runner.ran, ['commit-msg', 'pre-push'])
  } finally {
    delete process.env.AGIT_TEST_OUT
    s.cleanup()
  }
})

test('plan: an unchanged merge message runs no commit-msg, and pre-push sees the local merge commit itself', async () => {
  const s = hookScenario({
    'commit-msg': 'exit 1',
    'pre-push': 'cat > "$AGIT_TEST_OUT"',
  })
  try {
    const { wt, bare, git, client, root } = s
    const seen = join(root, 'push')
    process.env.AGIT_TEST_OUT = seen
    await onAgentBranch(s)
    moveDevelop(bare, { 'b.txt': 'theirs\n' })
    run(wt, ['fetch', '-q', 'origin', 'develop'])
    run(wt, ['merge', '--no-edit', 'origin/develop'])
    const localMergeSha = run(wt, ['rev-parse', 'HEAD']).trim()
    const head = must(await resolveBranch({ client, owner: 'o', repo: 'r', branch: 'agent/x' }))

    await publishMerge({ git, client, owner: 'o', repo: 'r', branch: 'agent/x', head, hooks: s.wire('agent/x', head.sha) })
    assert.equal(readFileSync(seen, 'utf8').trim().split(' ')[1], localMergeSha)
    assert.deepEqual(s.runner.ran, ['pre-push'])
  } finally {
    delete process.env.AGIT_TEST_OUT
    s.cleanup()
  }
})
