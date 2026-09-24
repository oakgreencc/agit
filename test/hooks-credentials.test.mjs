// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as guard from '../src/hooks/guard-credentials.mjs'
import { respond } from '../src/hooks/index.mjs'

const { violation, signingDisabled, sshRewriteActive } = guard
import { gitConfigEnv } from '../src/setup/settings.mjs'

// A session that HAS the SSH→HTTPS rewrite. Cases carry their own env so the
// verdict does not depend on the environment of whoever runs the suite.
const REWRITE_ENV = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_0: 'git@github.com:',
}
// A session that HAS signing disabled.
const SIGNING_OFF_ENV = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'tag.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
}
// The shape of the block `agit setup project` writes.
// The env block exactly as `agit setup project` writes it — the rules are
// specified against fixtures, and this is what every session actually loads.
const SETUP_ENV = gitConfigEnv({ owners: ['acme'] })

/** @type {[string, string | null, Record<string, string>?][]} */
const cases = [
  ['gh issue list', 'gh'],
  ['env -u GITHUB_TOKEN gh issue list', 'gh'],
  ['/opt/homebrew/bin/gh issue list', 'gh'],
  ['./gh pr create', 'gh'],
  ['bash -c "gh issue list"', 'gh'],
  ["sh -c 'gh pr merge 12'", 'gh'],
  ['GH_TOKEN=abc gh pr create', 'gh'],
  ['eval gh issue list', 'gh'],
  ['curl -H "Authorization: bearer $GITHUB_TOKEN" https://api.github.com/user', 'token'],
  ['git push origin main', 'push'],
  ['ssh-add ~/.ssh/id_ed25519', 'ssh'],
  ['op read op://Private/gh/token', 'op'],
  // Setting the signing program is a violation; reading it is diagnosis.
  ['git config gpg.ssh.program /usr/bin/op-ssh-sign', 'ssh'],
  ['git config --global gpg.ssh.program op-ssh-sign', 'ssh'],
  ['git config --add gpg.ssh.program op-ssh-sign', 'ssh'],
  ['git config --unset gpg.ssh.program', 'ssh'],
  ['git config --replace-all gpg.ssh.program op-ssh-sign', 'ssh'],
  // A read bolted onto an act is the act.
  ['git config --get gpg.ssh.program && ssh-add ~/.ssh/id_ed25519', 'ssh'],
  ['git config --get gpg.ssh.program && ssh-add ~/.ssh/id_ed25519', 'ssh', REWRITE_ENV],
  ['git config --get gpg.ssh.program && git push origin main', 'push'],
  ['git push origin main; git config --get gpg.ssh.program', 'push'],
  ['git config --get gpg.ssh.program && git push origin main', 'push', REWRITE_ENV],
  ['export GIT_SSH_COMMAND=op-ssh-sign', 'ssh'],
  // A read in one statement launders nothing in the next.
  ['git config --get gpg.ssh.program; git config gpg.ssh.program /usr/bin/op-ssh-sign', 'ssh'],
  ['git config --get gpg.ssh.program && export GIT_SSH_COMMAND=op-ssh-sign', 'ssh'],
  ['git config --get gpg.ssh.program | tee ~/.gitconfig', 'ssh'],
  ['git config --get gpg.ssh.program > ~/.gitconfig', 'ssh'],
  ['git config --get gpg.ssh.program\ngit config gpg.ssh.program op-ssh-sign', 'ssh'],
  // Flipping the signing switch.
  ['git config --unset commit.gpgsign', 'ssh'],
  ['git config commit.gpgsign true', 'ssh'],
  ['git config --global tag.gpgsign true', 'ssh'],
  ['git config --get commit.gpgsign', null],
  ['git config commit.gpgsign', null],
  ['git config --get commit.gpgsign 2>/dev/null', null],
  ['grep -n commit.gpgsign .claude/settings.json', null],
  // Commit-creating commands with signing ON.
  ["git commit -m 'x'", 'sign'],
  ['git commit --amend', 'sign'],
  ['git merge main', 'sign'],
  ['git rebase origin/main', 'sign'],
  ['git cherry-pick abc123', 'sign'],
  ['git revert abc123', 'sign'],
  ['git tag -a v1 -m v1', 'sign'],
  ['git am /tmp/patch.mbox', 'sign'],
  // Creating nothing.
  ['git rebase --abort', null],
  ['git merge --abort', null],
  ['git cherry-pick --quit', null],
  ['git tag -l', null],
  ['git tag --list', null],
  ['git tag -d v1', null],
  ['git status --short', null],
  ['git merge --ff-only', null],
  ['git merge --ff-only origin/main', null],
  ['git merge --no-commit --no-ff agent/topic', null],
  ['git rebase --continue', null],
  ['git tag v1', null],
  ['git tag', null],
  ['git tag -f v1 abc123', null],
  ['git tag --contains abc123', null],
  ['git tag -s v1', 'sign'],
  ['git tag -m "v1" v1', 'sign'],
  ['git tag --annotate v1', 'sign'],
  ['git tag -l && git commit -m x', 'sign'],
  ['git merge --abort; git merge main', 'sign'],
  // Must NOT fire — the false positives that get a hook disabled.
  ['grep -e "gh issue\\|gh pr" CLAUDE.md', null],
  ['echo "run gh issue list to see them"', null],
  ['npm run build && npx tsc --noEmit', null],
  ['ls /opt/homebrew/bin/', null],
  ['agit api GET /repos/o/r/issues/295', null],
  ['node bin/agit.mjs api GET /repos/o/r/issues/295', null],
  ['high --graph', null],
  ['git log --oneline | head -5', null],
  ['grep GITHUB_TOKEN README.md', null],
  ['git config --get gpg.ssh.program', null],
  ['git config --get-all gpg.ssh.program', null],
  ['git config --global --get gpg.ssh.program', null],
  ['git config gpg.ssh.program', null],
  ['git config --list | grep gpg.ssh.program', null],
  ['git config --get-regexp gpg.ssh.program', null],
  // Heredocs: a python/cat body is data, a shell body is executed.
  ["python3 - <<'EOF'\nprint('run gh issue list')\nEOF", null],
  ["cat > f.md <<'EOF'\nUse `gh issue list` to see them\nEOF", null],
  ["bash <<'EOF'\ngh issue list\nEOF", 'gh'],
  ["sh <<'EOF'\ngit push origin main\nEOF", 'push'],
  // Network git with NO rewrite.
  ['git fetch origin main -q', 'net-git'],
  ['cd ~/src/app && git fetch origin -q', 'net-git'],
  ['git -C /tmp/w fetch origin main', 'net-git'],
  ['git clone https://github.com/o/r.git', 'net-git'],
  ['git ls-remote origin -h refs/heads/main', 'net-git'],
  ['git pull --rebase', 'net-git'],
  // Local-only git is never network git.
  ['git worktree add --detach /tmp/w origin/main', null, {}],
  ['git reset --hard origin/main', null, {}],
  ['git remote -v', null, {}],
  ['echo "run git fetch origin first"', null, {}],
  // With the rewrite, fetches are sanctioned.
  ['git fetch origin main -q', null, REWRITE_ENV],
  ['git clone https://github.com/o/r.git', null, REWRITE_ENV],
  // A push is refused whatever the transport.
  ['git push origin main', 'push', REWRITE_ENV],
  ['git -C /tmp/repo push origin agent/topic', 'push', REWRITE_ENV],
  ['git push --force-with-lease origin agent/topic', 'push', REWRITE_ENV],
  ['git push git@github.com:someone/other.git main', 'ssh', REWRITE_ENV],
  // Signing off: ordinary commands, rule silent. Push still refused.
  ["git commit -m 'x'", null, SIGNING_OFF_ENV],
  ['git commit --amend', null, SIGNING_OFF_ENV],
  ['git merge main', null, SIGNING_OFF_ENV],
  ['git rebase origin/main', null, SIGNING_OFF_ENV],
  ['git cherry-pick abc123', null, SIGNING_OFF_ENV],
  ['git revert abc123', null, SIGNING_OFF_ENV],
  ['git tag -a v1 -m v1', null, SIGNING_OFF_ENV],
  ['git push origin main', 'push', SIGNING_OFF_ENV],
  // git's other spellings of false.
  ["git commit -m 'x'", null, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'no' }],
  ["git commit -m 'x'", null, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'off' }],
  ["git commit -m 'x'", null, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'FALSE' }],
  ["git commit -m 'x'", 'sign', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true' }],
  ["git commit -m 'x'", 'sign', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'tag.gpgsign', GIT_CONFIG_VALUE_0: 'false' }],
]

for (const [cmd, want, env = {}] of cases) {
  test(`${want ?? 'allow'}: ${cmd.replace(/\n/g, '⏎')}${env === REWRITE_ENV ? ' [rewrite]' : env === SIGNING_OFF_ENV ? ' [signing off]' : ''}`, () => {
    assert.equal(violation(cmd, env)?.id ?? null, want)
  })
}

test('the env block agit setup writes: signing off, rewrite on, fetch quiet, push refused', () => {
  assert.equal(signingDisabled(SETUP_ENV), true)
  assert.equal(sshRewriteActive(SETUP_ENV), true)
  assert.equal(violation("git commit -m 'x'", SETUP_ENV), null)
  assert.equal(violation('git fetch origin main', SETUP_ENV), null)
  assert.equal(violation('git push origin main', SETUP_ENV)?.id, 'push')
})

test('nested sh -c is followed to any depth; quoted text inside a payload is still data', () => {
  assert.equal(violation(`bash -c "sh -c 'gh pr list'"`, {})?.id, 'gh')
  assert.equal(violation(`sh -c "bash -c 'zsh -c \\"git push\\"'"`, {})?.id, 'push')
  assert.equal(violation(`bash -c "echo 'gh pr list'"`, {}), null)
})

test('a denial names the rule and points at agit, through the hook host', async () => {
  const line = await respond(guard, JSON.stringify({ tool_input: { command: 'gh pr list' } }), { env: {} })
  const out = JSON.parse(String(line))
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Blocked \(gh\)/)
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /agit publish/)
})
