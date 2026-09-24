// @ts-check
/**
 * Refuse to run when agit is older than the project requires.
 *
 * The harness agit was ported from vendored its publish tool into the repo, so
 * the gate that ran was whichever copy you executed — and a stale copy ran a
 * stale gate, or none, for days (its displacement gate was on the branch and
 * inert in practice). The fix there was a freshness check comparing the running
 * source to the branch's.
 *
 * agit is installed, not vendored, so the same hazard has a simpler shape: a
 * machine running an old agit against a project whose policy relies on a newer
 * gate. `.agit.json` names `minVersion`; an older agit refuses, rather than
 * silently enforcing less than the policy says.
 */

import { readFileSync } from 'node:fs'

/** The running agit's version, from its own package.json. */
export const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version

/** -1, 0 or 1. Plain `x.y.z`; a pre-release suffix sorts before its release. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map((n) => Number(n) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** `null` when fine, else the refusal. */
export function versionRefusal(minVersion, running = VERSION) {
  if (!minVersion || compareVersions(running, minVersion) >= 0) return null
  return (
    `refusing to run: this project's .agit.json requires agit >= ${minVersion}, and this is ${running}.\n` +
    'Its policy may rely on a gate this version does not have, and enforcing less than the\n' +
    'policy says, silently, is the failure this check exists for. Update agit:\n\n' +
    '  npm install -g @oakgreencc/agit   # or however this machine installed it'
  )
}
