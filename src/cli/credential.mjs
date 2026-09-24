// @ts-check
/**
 * `agit credential get` — git's credential helper, so plain `git fetch` and
 * `git clone` authenticate as the App over HTTPS instead of reaching for a
 * human's SSH key (which, headless, is a hang or "communication with agent
 * failed"; interactively, a biometric prompt nobody asked for).
 *
 * Wired by the GIT_CONFIG_* env block `agit setup project` writes into
 * `.claude/settings.json`: an `insteadOf` rewrite of `git@github.com:<owner>/`
 * to HTTPS, `credential.useHttpPath=true` (without it git sends the host
 * alone, and there is no repo to scope a token to), and this helper.
 *
 * It is the READ path. The same token would carry a push, and that is exactly
 * why `git push` is refused by `agit hook guard-credentials` on every
 * transport: a pushed commit is whatever the local binary made — unsigned,
 * authored as a human — while a commit the App creates through the API is
 * Verified as the App.
 *
 * SILENCE MEANS "NOT MINE". Anything that is not https://github.com, a repo no
 * App is configured for, or a failure of any kind returns no answer, so git
 * falls through to its next helper instead of having a wrong answer forced on
 * it. Failures are said on stderr.
 */

import { readFileSync } from 'node:fs'
import { projectFor } from '../context.mjs'
import { readAppCredentials, cachedInstallationToken } from '../github/app.mjs'

/** Parse git's `key=value` credential protocol. */
export function parseCredentialInput(text) {
  return Object.fromEntries(
    String(text)
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  )
}

/**
 * The helper's answer to one `get`, or `null` for "not mine". `mint` is the
 * token source, injectable so a test can see which App was chosen.
 *
 * @param {Record<string, string>} fields
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, mint?: typeof cachedInstallationToken }} [deps]
 */
export async function answer(fields, { cwd = process.cwd(), env = process.env, mint = cachedInstallationToken } = {}) {
  if (fields.protocol !== 'https' || fields.host !== 'github.com') return null
  const [owner, repo] = (fields.path ?? '').replace(/\.git$/, '').split('/')
  if (!owner || !repo) return null

  // The project's `app` pin governs the fetch exactly as it governs the
  // publish: git and the API must act as the same App.
  let creds
  try {
    creds = readAppCredentials({ owner, project: projectFor({ owner, repo, cwd, env }), env })
  } catch {
    return null // no App for this owner: not mine
  }
  try {
    const token = await mint({ owner, repo, appId: creds.appId, keyPem: creds.keyPem, env })
    return `username=x-access-token\npassword=${token}\n`
  } catch (err) {
    console.error(`agit credential: ${owner}/${repo}: ${/** @type {Error} */ (err).message.split('\n')[0]}`)
    return null
  }
}

export async function run(argv) {
  // `get` is the only operation with an answer. store/erase are no-ops:
  // nothing is persisted by git — the token comes from agit's own cache.
  if (argv[0] !== 'get') return 0
  let fields
  try {
    fields = parseCredentialInput(readFileSync(0, 'utf8'))
  } catch {
    return 0
  }
  const out = await answer(fields)
  if (out) process.stdout.write(out)
  return 0
}
