// @ts-check
import { join, sep } from 'node:path'
import { agitHome } from '../config.mjs'

/**
 * A failed call used to surface as a stack trace with GitHub's JSON buried
 * mid-line, which reads like agit crashed rather than like GitHub said no. The
 * common causes have specific fixes, so name them.
 *
 * @param {unknown} err
 * @param {NodeJS.ProcessEnv} [env] where `AGIT_PRIVATE_KEY_PATH` and `AGIT_HOME` are read
 * @returns {string | null}
 */
export function explain(err, env = process.env) {
  const msg = String(/** @type {any} */ (err)?.message ?? err)
  // `request` attaches the status; the `<path>: <status>` message is the fallback.
  const status = String(/** @type {any} */ (err)?.status ?? /: (\d{3}) /.exec(msg)?.[1] ?? '')
  if (/** @type {any} */ (err)?.name === 'NoAppError') return null // its message is the advice
  if (status === '403' && /not accessible by integration/.test(msg)) {
    return (
      'The App lacks permission for this endpoint. Workflows, Administration and secrets are\n' +
      'deliberately withheld from it, so `.github/workflows/**`, rulesets and secrets are the\n' +
      "human's to change: describe the change and hand it over."
    )
  }
  if (status === '404') {
    return (
      'Not found — or the App is not installed on that repository. Check the repository, and\n' +
      'that the App\'s installation covers it (`agit doctor`).'
    )
  }
  if (status === '422' && /git\/refs\/heads\//.test(msg)) {
    return (
      'The branch moved since this run started, so the fast-forward was refused and nothing\n' +
      'on the branch changed. Bring the worktree up to it and retry:\n' +
      '  agit advance <branch>'
    )
  }
  // Only a missing CREDENTIAL file gets the credentials hint — a typo'd
  // --pr-body-file is an ENOENT too, and blaming the App for it sends an agent
  // debugging keys that are fine. A real fs error carries the path on `path`.
  const missing = /** @type {any} */ (err)?.path ?? /ENOENT[^']*'([^']+)'/.exec(msg)?.[1]
  const isCredential =
    typeof missing === 'string' &&
    ((!!env.AGIT_PRIVATE_KEY_PATH && missing === env.AGIT_PRIVATE_KEY_PATH) ||
      missing.startsWith(join(agitHome(env), 'apps') + sep))
  if (/ENOENT|no such file/i.test(msg) && isCredential) {
    return 'Missing App credentials. Run `agit setup app`, or set AGIT_APP_ID and AGIT_PRIVATE_KEY_PATH.'
  }
  return null
}
