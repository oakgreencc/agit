// @ts-check
/**
 * PreToolUse/Bash hook — keep agent sessions off human credentials.
 *
 *   agit hook guard-credentials
 *
 * Agents reach GitHub only as the project's GitHub App, through `agit`.
 * Everything else on a developer's machine authenticates as the HUMAN: the
 * `gh` keyring login, any GH_TOKEN in the environment, the SSH key (often
 * behind a biometric-gated agent such as 1Password's `op-ssh-sign`). Work done
 * through those is attributed to them and, for signing and pushing, needs a
 * fingerprint no headless session can supply.
 *
 * Seven rule families, each reported by id:
 *
 *   gh        the GitHub CLI, at any path, through any wrapper
 *   token     GITHUB_TOKEN / GH_TOKEN expanded to reach the API directly
 *   ssh       ssh to GitHub, ssh-add, the signing program and signing
 *             switches (a read-only `git config` lookup is allowed: diagnosis)
 *   push      `git push`, on every transport
 *   sign      commit-creating git in a session that has not disabled local
 *             signing — a tripwire, quiet in a session `agit setup` configured
 *   op        1Password CLI credential reads
 *   net-git   fetch/pull/clone in a session with no SSH→HTTPS rewrite
 *
 * WHY `git push` IS REFUSED EVEN OVER HTTPS AS THE APP. A pushed commit is
 * whatever the local binary made: unsigned, authored as whichever `user.name`
 * resolved — the human's. A commit the App creates through the API is signed
 * by GitHub and lands Verified as the App. `agit publish`/`agit merge` cover
 * every shape a push could, so there is nothing a push does that the boundary
 * wants. In the harness agit was ported from, an HTTPS push was allowed for
 * three days on the reasoning that the SSH key was the only objection; it was
 * not.
 *
 * Quoted text is DATA and a `sh -c` payload is a COMMAND — see shell-text.mjs.
 *
 * Fails OPEN: any crash or unparseable payload exits 0 rather than wedging
 * every Bash call in the session.
 */
import { readFileSync } from 'node:fs'
import { maskQuoted, shellPayloads, statements } from './shell-text.mjs'

/** Start of a command: string start, or after a real (unquoted) separator. */
const CMD_START = '(?:^|[;&|(\\n`]|&&|\\|\\|)\\s*'

/** Prefix tokens that can precede the real command word (env -u FOO, sudo, …). */
const PREFIX =
  '(?:(?:\\w+=\\S*|env|sudo|nohup|command|time|xargs|eval|exec|-{1,2}\\S+|[A-Za-z_][A-Za-z0-9_]*)\\s+)*'

/**
 * `gh` as a command word, with an optional path in front so `/opt/homebrew/bin/gh`
 * and `./gh` are caught too. Deliberately not a bare \bgh\b — that matches "high"
 * and "gh-pages", and a hook with false positives gets switched off.
 */
const GH = new RegExp(`${CMD_START}${PREFIX}(?:[\\w./~-]*/)?gh(?=\\s|$)`)

/** Token env vars used to hit the API directly, sidestepping the CLI block. */
const TOKEN = /\$\{?(?:GITHUB_TOKEN|GH_TOKEN|GH_PACKAGES_TOKEN|GITHUB_PAT|GH_PAT)\b/

/** The half of the SSH rule that is an ACT: opens a socket, reaches for the key. */
const SSH_ACT = new RegExp(
  [
    `${CMD_START}${PREFIX}ssh-add\\b`,
    `${CMD_START}${PREFIX}ssh\\s+[^\\n]*git@github\\.com`,
    'git@github\\.com:',
  ].join('|'),
)

/**
 * The half that is a NAME: the signing program, anywhere, and the signing
 * switches when a `git config` names them. Setting any of these is a
 * violation; reading one is diagnosis — `sshConfigReadOnly` tells them apart.
 */
const SIGNING_KEY = 'gpg\\.ssh\\.program|(?:commit|tag)\\.gpgsign'
const SSH_SIGNING_NAME =
  /op-ssh-sign|gpg\.ssh\.program|\bconfig\b[^\n;|&]*\b(?:commit|tag)\.gpgsign\b/

const SSH = new RegExp([SSH_ACT.source, SSH_SIGNING_NAME.source].join('|'))

const GIT_CONFIG_READ_VERB = /\s(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l)(?=\s|$)/
const GIT_CONFIG_WRITE_VERB = /\s(?:--replace-all|--add|--unset(?:-all)?|--edit|-e)(?=\s|$)/
const GIT_CONFIG = new RegExp(`${CMD_START}${PREFIX}git\\s+(?:-[cC]\\s+\\S+\\s+)*config(?=\\s|$)`)
const GIT_CONFIG_BARE_KEY = new RegExp(
  `config\\s+(?:--\\S+\\s+)*[\\w.]*(?:op-ssh-sign|${SIGNING_KEY})\\S*\\s*$`,
)

/**
 * A read whose OUTPUT goes somewhere that is not a terminal or a read-only
 * filter — `| tee ~/.gitconfig`, `> file` — is a write. `2>/dev/null` is not.
 */
const READ_OUTPUT_WRITTEN =
  /\|\s*(?:tee|dd|xargs|eval|(?:ba|z|k|da)?sh|git\s+config)\b|(?:^|[^<>])[0-9]?>>?\s*(?!\/dev\/null)[^\s&<>]/

/**
 * Is this STATEMENT nothing but a read-only inspection of the signing config?
 * Asked per statement: one `--get` must not launder a write beside it
 * (`git config --get gpg.ssh.program; git config gpg.ssh.program x`).
 */
function sshConfigReadOnly(s) {
  if (!SSH_SIGNING_NAME.test(s)) return false
  if (SSH_ACT.test(s)) return false // a read bolted onto an act is the act
  if (!GIT_CONFIG.test(s)) return false
  if (GIT_CONFIG_WRITE_VERB.test(s)) return false
  if (READ_OUTPUT_WRITTEN.test(s)) return false
  return GIT_CONFIG_READ_VERB.test(s) || GIT_CONFIG_BARE_KEY.test(s.trim())
}

const sshAllowed = (s) =>
  statements(s).every((st) => !SSH.test(st.text) || sshConfigReadOnly(st.text))

/** 1Password CLI — reading a secret out of the vault needs the human's biometrics. */
const OP = new RegExp(`${CMD_START}${PREFIX}op\\s+(?:read|run|item|signin|inject)\\b`)

/**
 * Git commands that talk to the remote — the ones that quietly reach for the
 * SSH key when the remote is a `git@github.com:` URL. `git worktree add` is
 * not here: it resolves an already-fetched ref locally.
 */
const NET_GIT = new RegExp(
  `${CMD_START}${PREFIX}git\\s+(?:-[cC]\\s+\\S+\\s+)*(?:fetch|pull|clone|ls-remote|remote\\s+update|submodule\\s+(?:update|sync))\\b`,
)

/** `git push` — refused on every transport. `-C`/`-c` forms are the same command. */
const PUSH = new RegExp(`${CMD_START}${PREFIX}git\\s+(?:-[cC]\\s+\\S+\\s+)*push\\b`)

/**
 * Git commands that CREATE a commit or an annotated tag, and so invoke the
 * configured signing program. Several create commits without the word
 * "commit" appearing, which is why credential rules alone never caught them.
 */
const COMMIT_CREATING = new RegExp(
  `${CMD_START}${PREFIX}git\\s+(?:-[cC]\\s+\\S+\\s+)*(?:commit|merge|rebase|cherry-pick|revert|am|tag)\\b`,
)

/**
 * Forms of the above that create nothing: aborting; a merge that only
 * fast-forwards or stops short of the commit; a resumed rebase; `git tag`
 * listing, deleting, or making a LIGHTWEIGHT tag (a ref, nothing to sign).
 */
const NON_CREATING =
  /\s--(?:abort|quit|skip)(?=\s|$)|\bmerge\b[^\n;|&]*\s--(?:ff-only|no-commit)(?=\s|$)|\brebase\b[^\n;|&]*\s--continue(?=\s|$)/
const GIT_TAG = /\bgit\s+(?:-[cC]\s+\S+\s+)*tag(?=\s|$)([^\n;|&]*)/
const TAG_OBJECT_FLAG = /^-[A-Za-z]*[asumF]|^--(?:annotate|sign|local-user|message|file)\b/

function tagCreatesNothing(s) {
  const m = GIT_TAG.exec(s)
  return (
    !!m &&
    !m[1]
      .trim()
      .split(/\s+/)
      .some((a) => TAG_OBJECT_FLAG.test(a))
  )
}

/** Per statement, so `git tag -l && git commit` is not excused by its first half. */
const createsNothing = (s) =>
  statements(s).every(
    (st) =>
      !COMMIT_CREATING.test(st.text) || NON_CREATING.test(st.text) || tagCreatesNothing(st.text),
  )

/**
 * The `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_i` / `GIT_CONFIG_VALUE_i` block as
 * `[key, value]` pairs. Hooks inherit the session environment, so the block
 * `agit setup project` writes into `.claude/settings.json` is readable here.
 */
function* injectedConfig(env) {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0)
  for (let i = 0; i < count; i++)
    yield [env[`GIT_CONFIG_KEY_${i}`] ?? '', env[`GIT_CONFIG_VALUE_${i}`] ?? '']
}

const GIT_FALSE = /^(?:false|0|no|off)$/i

/**
 * Is local commit signing disabled in this session? With it off, a local
 * commit (a merge to publish with `agit merge`, work parked mid-session) never
 * reaches the human's key and never leaves the machine, so the `sign` rule is
 * quiet. It fires only where the command would actually hit the key — a
 * session that did not load the settings `agit setup` wrote.
 */
export function signingDisabled(env) {
  for (const [key, val] of injectedConfig(env))
    if (key === 'commit.gpgsign' && GIT_FALSE.test(val)) return true
  return false
}

/**
 * Is an SSH→HTTPS rewrite for github.com active? With it, `git fetch` runs over
 * HTTPS and authenticates as the App through `agit credential`, so `net-git`
 * is quiet. Loose about which owner is rewritten: any rewrite of a github.com
 * SSH URL means someone has thought about this.
 */
export function sshRewriteActive(env) {
  for (const [key, val] of injectedConfig(env))
    if (/^url\..*\.insteadof$/i.test(key) && /git@github\.com:/.test(val)) return true
  return false
}

const GUIDANCE = `Act on GitHub as the project's App, through agit, instead:

  # uncommitted changes → one Verified commit (+ branch, + PR); the worktree advances
  agit publish <branch> "<message>" --paths a,b --pr "<title>"

  # a completed local merge (git merge → resolve → git commit) → a Verified merge commit
  agit merge <branch>

  # bring the worktree onto a branch head without discarding work
  agit advance <branch>

  # read or write the API (issues, PRs, runs, comments)
  agit api GET /repos/<owner>/<repo>/issues --paginate

\`api\` prints JSON — pipe it to jq or python3. Use --paginate on any list; a first
page of 30 otherwise reads as the whole set. The App holds no Workflows permission,
so \`.github/workflows/**\` is the human's to edit — describe the patch and hand it over.`

export const RULES = [
  {
    id: 'gh',
    re: GH,
    why: "The `gh` CLI authenticates as the human personally, so anything it does is attributed to them rather than to the project's App.",
  },
  {
    id: 'token',
    re: TOKEN,
    // Scanned RAW: the token is almost always inside a quoted header, which
    // masking would hide. Safe because the pattern requires a `$` expansion;
    // a bare mention (`grep GITHUB_TOKEN README.md`) is text and passes.
    raw: true,
    why: "That token is a personal credential. Reaching the API with it attributes the write to a human and bypasses the App's permission envelope.",
  },
  {
    id: 'ssh',
    re: SSH,
    allow: sshAllowed,
    why: "Pushing or signing over SSH uses the human's key — often biometric-gated, which no headless session can satisfy — and attributes the work to them. Commits published through the App are signed by GitHub server-side instead.",
  },
  {
    id: 'push',
    re: PUSH,
    why: 'Agents never `git push`. A pushed commit is whatever the local binary made — unsigned, authored as the human — while a commit the App creates through the API is Verified as the App. Local git is read-only toward GitHub.',
    fix: `Publish instead. It does everything a push would:

  # uncommitted changes → one Verified commit (+ branch, + PR); the worktree advances
  agit publish <branch> "<message>" --paths a,b --pr "<title>"

  # a completed local merge (git merge → resolve → git commit) → Verified merge commit
  agit merge <branch>

  # bring the worktree onto the branch head without discarding work
  agit advance <branch>

The repository's pre-commit, commit-msg and pre-push hooks run inside publish.`,
  },
  {
    id: 'sign',
    re: COMMIT_CREATING,
    unless: signingDisabled,
    allow: createsNothing,
    why: "This command creates a commit or an annotated tag, and this session has NOT disabled local signing — so git will invoke the signing program, reach the human's key, and either hang on a prompt no headless session can answer or fail. Sessions configured by `agit setup project` disable local signing; this one did not load that configuration.",
    fix: `Do NOT work around this per-command — \`--no-gpg-sign\`, \`-c commit.gpgsign=false\`
and rewriting git config are all off-limits: agent work is signed by GitHub when the
App creates it, not locally as a human.

To publish work, use the App — it needs no local commit at all:

  agit publish <branch> "<message>" --paths <a,b> --pr "<title>"

A local commit is legitimate in a session with signing off (a merge to publish with
\`agit merge\`). A session that SHOULD have signing off is missing the \`env\` block
\`agit setup project\` writes into .claude/settings.json; report that, or run
\`agit doctor\`.`,
  },
  {
    id: 'op',
    re: OP,
    why: "The 1Password CLI reads human credentials out of the vault. The App's credentials live in agit's config directory (`agit doctor` shows where).",
  },
  {
    id: 'net-git',
    re: NET_GIT,
    unless: sshRewriteActive,
    why: "This reaches the remote, and with a `git@github.com:` remote that means the human's SSH key. This session has no SSH→HTTPS rewrite configured to send it through the App instead.",
    fix: `Fetching is fine — reaching for the key is not. The \`env\` block \`agit setup project\`
writes into .claude/settings.json rewrites github.com SSH remotes to HTTPS and answers
git's credential request as the App:

  GIT_CONFIG_KEY_n = url.https://github.com/.insteadOf
  GIT_CONFIG_VALUE_n = git@github.com:
  GIT_CONFIG_KEY_n = credential.https://github.com.helper
  GIT_CONFIG_VALUE_n = !agit credential

If you are seeing this, that block is missing or was unset — run \`agit doctor\`.
It is the READ path only: \`git push\` stays refused either way.`,
  },
]

/**
 * The rule a command breaks, or `null`.
 *
 * @param {string} command
 * @param {Record<string, string | undefined>} [env]
 */
export function violation(command, env = process.env) {
  const payloads = shellPayloads(command)
  const masked = [maskQuoted(command), ...payloads.map(maskQuoted)]
  const raw = [command, ...payloads]
  for (const rule of RULES) {
    // `unless` asks about the session; `allow` asks about this command.
    if (rule.unless?.(env)) continue
    if ((rule.raw ? raw : masked).some((s) => rule.re.test(s) && !rule.allow?.(s))) return rule
  }
  return null
}

/** The hook's JSON answer for a hit. */
export function denial(hit) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      // A rule with its own `fix` replaces the general guidance: "publish with
      // agit" is the wrong answer to "your fetch was about to touch the key".
      permissionDecisionReason: `Blocked (${hit.id}): ${hit.why}\n\n${hit.fix ?? GUIDANCE}`,
    },
  }
}

export async function main() {
  let command = ''
  try {
    command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? ''
  } catch {
    return // no stdin or unparseable payload — fail open
  }
  let hit = null
  try {
    hit = violation(command)
  } catch {
    return // a bug in here must not wedge the session
  }
  if (hit) console.log(JSON.stringify(denial(hit)))
}
