// @ts-check
/**
 * A failed call used to surface as a stack trace with GitHub's JSON buried
 * mid-line, which reads like agit crashed rather than like GitHub said no. The
 * common causes have specific fixes, so name them.
 */
export function explain(err) {
  const msg = String(/** @type {any} */ (err)?.message ?? err)
  const status = /: (\d{3}) /.exec(msg)?.[1]
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
  if (/ENOENT.*(private-key\.pem|app\.json)/i.test(msg)) {
    return 'Missing App credentials. Run `agit setup app`, or set AGIT_APP_ID and AGIT_PRIVATE_KEY_PATH.'
  }
  return null
}
