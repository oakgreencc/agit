// @ts-check
/**
 * What a raw `git fetch` in THIS process would authenticate as.
 *
 * agit's own verbs never depend on the session: every remote read passes its
 * own config (context.mjs `remoteAsApp`). Raw git does. Its only binding to
 * the App is the `GIT_CONFIG_*` block `agit setup project` writes into
 * `.claude/settings.json` — and Claude Code loads that once, when the session
 * starts. A session opened before setup, or launched from a process carrying
 * another project's block, has raw git that reaches for the human's SSH key
 * or answers through someone else's helper, and nothing says so.
 *
 * So this asks git itself, under the process's environment, the two questions
 * that decide it — both local, neither touches the network:
 *
 *   where    `git ls-remote --get-url origin` (insteadOf rewrites applied)
 *   who      the credential helpers git would run for that URL, in config
 *            order, an empty value resetting the list as git does
 *
 * and compares the process's block with the one the project's settings name.
 * `agit doctor` reports the answer; the SessionStart hook (hooks/session-check)
 * says it in-session when it is wrong.
 */

import { execFileSync } from 'node:child_process'
import { envToPairs, isAgitHelper } from './setup/settings.mjs'

/** @typedef {import('./setup/doctor.mjs').Finding} Finding */
/** @typedef {{ key: string, value: string, scope: string }} HelperEntry */

const SSH_URL = /^(?:git@|ssh:\/\/)/
const GITHUB_HTTPS = /^https:\/\/github\.com\//

/**
 * The helpers git would run for `url`: every `credential.helper` and
 * `credential.<prefix>.helper` whose prefix matches, in config order, an
 * empty value clearing what came before.
 *
 * @param {HelperEntry[]} entries
 * @param {string} url
 * @returns {HelperEntry[]}
 */
export function effectiveHelpers(entries, url) {
  /** @type {HelperEntry[]} */
  let list = []
  for (const e of entries) {
    const m = /^credential\.(?:(.+)\.)?helper$/i.exec(e.key)
    if (!m) continue
    const prefix = m[1]?.replace(/\/$/, '')
    // On a URL boundary: `https://github.com` is not a prefix of `https://github.com.evil/`.
    if (prefix && !(url === prefix || url.startsWith(`${prefix}/`))) continue
    if (e.value === '') list = []
    else list.push(e)
  }
  return list
}

/**
 * Ask git, under `env`, where `origin` resolves and which helpers answer it.
 * `url` is empty when there is no `origin`.
 *
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} input
 * @returns {{ url: string, helpers: HelperEntry[] }}
 */
export function readRawGit({ cwd, env = process.env }) {
  const git = (args) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
  let url = ''
  try {
    // insteadOf applied; unlike `ls-remote --get-url`, fails rather than echoing a missing remote's name.
    url = git(['remote', 'get-url', 'origin']).trim()
  } catch {
    return { url: '', helpers: [] }
  }
  let raw = ''
  try {
    raw = git(['config', '--show-scope', '-z', '--get-regexp', '^credential\\..*helper$'])
  } catch {
    raw = '' // exit 1: no helper configured anywhere
  }
  // -z: scope NUL key LF value NUL, repeated.
  const parts = raw.split('\0')
  /** @type {HelperEntry[]} */
  const entries = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const nl = parts[i + 1].indexOf('\n')
    entries.push({
      scope: parts[i],
      key: nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl),
      value: nl < 0 ? '' : parts[i + 1].slice(nl + 1),
    })
  }
  return { url, helpers: effectiveHelpers(entries, url) }
}

/** Where a helper came from, in words: the env block is scope `command`. */
const scopeLabel = (scope) => (scope === 'command' ? 'session env' : scope)

const RESTART =
  'This session is not bound to the App for raw git. Use agit verbs (`agit api`, `agit validate`, `agit advance`) and no raw fetch/pull/clone; restart the session so it loads .claude/settings.json.'

/**
 * The verdict, pure.
 *
 * @param {{
 *   url: string,
 *   helpers: HelperEntry[],
 *   processEnv: NodeJS.ProcessEnv | Record<string, string>,
 *   settingsEnv: Record<string, string> | null,
 * }} input
 * @returns {Finding[]}
 */
export function sessionFindings({ url, helpers, processEnv, settingsEnv }) {
  /** @type {Finding[]} */
  const out = []
  if (SSH_URL.test(url)) {
    out.push({ level: 'fail', label: `raw \`git fetch\` goes over SSH (${url}) — the human's key`, detail: RESTART })
  } else if (!GITHUB_HTTPS.test(url)) {
    out.push({ level: 'ok', label: `origin ${url} is not on github.com — raw git there is out of agit's scope` })
  } else if (helpers.length === 1 && isAgitHelper(helpers[0].value)) {
    out.push({ level: 'ok', label: `raw \`git fetch\` authenticates as the App (${url})` })
  } else if (!helpers.length) {
    out.push({
      level: 'warn',
      label: `raw \`git fetch\` has no credential helper for ${url}`,
      detail: 'nothing answers as anyone: a private repo fails. The session env should name `agit credential`.',
    })
  } else {
    const named = helpers.map((h) => `${h.value} (${scopeLabel(h.scope)})`).join(', ')
    out.push({ level: 'fail', label: `raw \`git fetch\` would authenticate through ${named}`, detail: RESTART })
  }

  const want = envToPairs(settingsEnv ?? {})
  if (want.length) {
    const have = envToPairs(processEnv)
    const same = have.length === want.length && have.every(([k, v], i) => want[i][0] === k && want[i][1] === v)
    if (same) out.push({ level: 'ok', label: "carries .claude/settings.json's GIT_CONFIG block" })
    else {
      const wanted = new Set(want.map(([k, v]) => `${k}=${v}`))
      const foreign = have.map(([k, v]) => `${k}=${v}`).filter((p) => !wanted.has(p))
      out.push({
        level: 'warn',
        label: 'its GIT_CONFIG block differs from .claude/settings.json',
        detail:
          (have.length ? '' : 'it has none. ') +
          (foreign.length ? `not from the settings: ${foreign.join('; ')}. ` : '') +
          'The session started before the settings were written, or inherited another project\'s block; restart it.',
      })
    }
  }
  return out
}
