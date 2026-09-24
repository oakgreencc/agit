// @ts-check
/**
 * Which paths an agent may not change without a human.
 *
 * Three tiers, checked in this order:
 *
 *   IMPOSSIBLE   no grant unlocks it, because the App cannot write it at all
 *                (`.github/workflows/**` without the Workflows permission).
 *                Saying so up front stops an agent hunting for a switch.
 *   PROTECTED    CODEOWNERS says a human must approve it, or `.agit.json`
 *                lists it in `protected.extra`, or it is one of the files that
 *                define the protection itself (below). Editing or publishing
 *                it needs a maintainer grant with the `protected` scope, and
 *                the PR still needs the code owner's review on GitHub.
 *   ordinary     everything else. CI is the gate.
 *
 * WHAT THIS IS NOT. An agent has a shell and can write any file on disk. The
 * boundary is CODEOWNERS enforced by a ruleset on GitHub, where the agent
 * cannot reach. What this buys locally is intent: a protected path is never
 * edited by accident, and every deliberate edit is preceded by a grant the
 * human made with a reason and an expiry.
 *
 * SELF-PROTECTION. The files that DEFINE the protection are protected whether
 * or not CODEOWNERS lists them — CODEOWNERS itself, `.agit.json`, and the
 * Claude settings that wire the hooks. A policy an agent could quietly edit is
 * decorative. `agit doctor` warns when CODEOWNERS does not also own them,
 * because locally-protected-but-unowned merges with no review.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODEOWNERS_LOCATIONS, findCodeowners, ownersOf, parseCodeowners, patternToRegExp } from './codeowners.mjs'
import { DEFAULTS, PROJECT_FILE, loadProjectConfig, merge } from './config.mjs'

/** Protected regardless of CODEOWNERS: the files that define the protection. */
export const SELF_PROTECTED = [...CODEOWNERS_LOCATIONS.map((p) => `/${p}`), `/${PROJECT_FILE}`, '/.claude/settings.json']

/**
 * @typedef {{ tier: 'impossible' | 'protected', path: string, why: string, owners: string[] }} Protection
 */

/**
 * A policy over repo-relative paths, from the project config and CODEOWNERS text.
 *
 * @param {{ config?: import('./config.mjs').ProjectConfig, codeowners?: { path: string | null, text: string } }} input
 */
export function createPolicy({ config = /** @type {any} */ (DEFAULTS), codeowners = { path: null, text: '' } } = {}) {
  const prot = config.protected ?? DEFAULTS.protected
  const rules = prot.codeowners === false ? [] : parseCodeowners(codeowners.text)
  const compile = (list) =>
    (list ?? []).map((pattern) => ({ pattern, re: patternToRegExp(pattern) })).filter((x) => x.re)
  const impossible = compile(prot.impossible)
  const extra = compile(prot.extra)
  const self = compile(SELF_PROTECTED)

  /**
   * @param {string} path repo-relative POSIX path
   * @returns {Protection | null}
   */
  function check(path) {
    const p = normalise(path)
    if (!p) return null
    const imp = impossible.find((x) => x.re?.test(p))
    if (imp) return { tier: 'impossible', path: p, why: `matches \`${imp.pattern}\` (protected.impossible)`, owners: [] }
    const owners = ownersOf(rules, p, prot.owners ?? [])
    if (owners.length)
      return { tier: 'protected', path: p, why: `owned by ${owners.join(' ')} in ${codeowners.path}`, owners }
    const ex = extra.find((x) => x.re?.test(p))
    if (ex) return { tier: 'protected', path: p, why: `matches \`${ex.pattern}\` (protected.extra)`, owners: [] }
    const s = self.find((x) => x.re?.test(p))
    if (s) return { tier: 'protected', path: p, why: 'defines the protection itself', owners: [] }
    return null
  }

  /** Every protected or impossible path in a list, deduplicated, in order. */
  function checkAll(paths) {
    const seen = new Set()
    const out = []
    for (const path of paths ?? []) {
      const hit = check(path)
      if (hit && !seen.has(hit.path)) {
        seen.add(hit.path)
        out.push(hit)
      }
    }
    return out
  }

  return {
    check,
    checkAll,
    codeownersPath: codeowners.path,
    unsupported: rules.filter((r) => r.unsupported).map((r) => /** @type {string} */ (r.unsupported)),
  }
}

/** @typedef {ReturnType<typeof createPolicy>} Policy */

/** Repo-relative POSIX form: `./a`, `a/../a` and `a` agree; a path climbing out is `''`. */
export function normalise(path) {
  const out = []
  for (const seg of String(path ?? '').replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return ''
      out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}

/**
 * The policy of the checkout at `root`, reading CODEOWNERS and `.agit.json`
 * from its working tree. Used by the editor hooks, which judge the file as it
 * sits on disk. `agit publish` reads CODEOWNERS from the BASE instead — see
 * `policyAtRef` — because a worktree's copy is exactly what an agent could
 * have edited.
 */
export function policyAtRoot(root) {
  const config = loadProjectConfig(root)
  const codeowners = findCodeowners((p) => {
    const f = join(root, p)
    return existsSync(f) ? readFileSync(f, 'utf8') : null
  })
  return createPolicy({ config, codeowners })
}

/**
 * The policy as of a git ref (`origin/<base>`): CODEOWNERS and `.agit.json` as
 * GitHub will enforce them, not as the worktree has them.
 *
 * @param {{ git: (args: string[]) => string, ref: string, root: string }} input
 */
export function policyAtRef({ git, ref, root }) {
  const show = (p) => {
    try {
      return git(['show', `${ref}:${p}`])
    } catch {
      return null
    }
  }
  const rawConfig = show(PROJECT_FILE)
  let config
  try {
    config = rawConfig ? merge(DEFAULTS, JSON.parse(rawConfig)) : loadProjectConfig(root)
  } catch {
    config = loadProjectConfig(root)
  }
  return createPolicy({ config, codeowners: findCodeowners(show) })
}
