// @ts-check
/**
 * Configuration — two files, two owners.
 *
 *   `<repo>/.agit.json`             the PROJECT's policy: where PRs land, what
 *                                   validates a tree, which hooks must run, what
 *                                   is protected beyond CODEOWNERS. Tracked, and
 *                                   protected by default (see protected.mjs), so
 *                                   an agent cannot loosen the policy it runs under
 *                                   without a human's grant and a code-owner review.
 *
 *   `$AGIT_HOME/config.json`        the MACHINE's identity: which GitHub App acts
 *   (`~/.config/agit` by default)   for which owner. App keys live beside it in
 *                                   `apps/<slug>/`. Never tracked. The only key
 *                                   material an agent session ever holds is the
 *                                   App's, never a human's.
 *
 * Every field of the project file is optional; `DEFAULTS` is the policy of a
 * repository that ran `agit setup project` and changed nothing.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The project file, at the repository root. */
export const PROJECT_FILE = '.agit.json'

export const DEFAULTS = Object.freeze({
  /** `owner/name`. `null` reads it from the `origin` remote. */
  repo: /** @type {string | null} */ (null),

  /**
   * Where agent PRs land when `--base` is not given. `null` asks GitHub for the
   * repository's default branch. Set it when the branch that runs CI is not
   * the default one (a develop → main flow): an agent PR opened against an
   * ungated branch is the opposite of what the gates are for.
   */
  baseBranch: /** @type {string | null} */ (null),

  /**
   * Bases an agent may merge a PR into itself (`agit pr merge`). `null` means
   * `[baseBranch]`; `[]` means agents never merge — a human clicks every one.
   */
  mergeableBases: /** @type {string[] | null} */ (null),

  /**
   * The required status check on the base, by name — what "green" means for
   * the stop-the-line rule in `agit pr merge`. `null` turns that rule off.
   */
  requiredCheck: /** @type {string | null} */ (null),

  /** `agit validate` runs this in the worktree and records the base it was green on. */
  validate: {
    command: /** @type {string | null} */ (null),
  },

  /** Git hooks agit runs itself, because a publish never runs `git commit` or `git push`. */
  hooks: {
    /**
     * Repo-relative hooks directory. `null` asks git (`core.hooksPath`, else
     * `.git/hooks`). Set it when the repo tracks its hooks (`.githooks`,
     * `.husky`): a clone that never ran `git config core.hooksPath` would
     * otherwise run none of them, silently.
     */
    path: /** @type {string | null} */ (null),
    /** Which hooks run. Absent hooks are skipped unless `required`. */
    run: ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'pre-push'],
    /** Hooks whose ABSENCE refuses a publish — a gate that is missing is not a gate that passed. */
    required: /** @type {string[]} */ ([]),
  },

  protected: {
    /** Use CODEOWNERS as the manifest of protected paths. */
    codeowners: true,
    /**
     * Only CODEOWNERS lines naming one of these owners count (`@alice`,
     * `@org/team`). Empty: any line with an owner counts.
     */
    owners: /** @type {string[]} */ ([]),
    /** More patterns, CODEOWNERS syntax, protected locally whether or not GitHub enforces them. */
    extra: /** @type {string[]} */ ([]),
    /**
     * Paths no local grant can unlock, because the App cannot write them at
     * all. `.github/workflows/**` needs the Workflows permission, which the
     * App deliberately does not hold; listing it here stops an agent looking
     * for a switch that cannot exist.
     */
    impossible: ['.github/workflows/**'],
  },

  payload: {
    /** The most one publish may ADD to a single path. See gates/scope.mjs. */
    ceilingBytes: 512 * 1024,
    /** Never published, at any size. CODEOWNERS syntax. */
    neverPublish: ['*.log'],
  },

  /** Refuse to run when agit is older than this — the policy may rely on gates it lacks. */
  minVersion: /** @type {string | null} */ (null),

  /** The App (by slug, in $AGIT_HOME/apps/) that acts for this repo. `null`: by owner, then default. */
  app: /** @type {string | null} */ (null),
})

/** @typedef {typeof DEFAULTS} ProjectConfig */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Deep merge; arrays are replaced, not concatenated — a policy list means what it says. */
export function merge(base, over) {
  if (!isObject(over)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue // $schema, $comment
    out[k] = isObject(v) && isObject(base?.[k]) ? merge(base[k], v) : v
  }
  return out
}

/**
 * The project config at `root`, merged over the defaults. A file that exists
 * and does not parse THROWS: a policy that silently fell back to defaults
 * would be a policy nobody wrote.
 *
 * @param {string} root the repository (worktree) root
 * @returns {ProjectConfig}
 */
export function loadProjectConfig(root) {
  const path = join(root, PROJECT_FILE)
  return parseProjectConfig(existsSync(path) ? readFileSync(path, 'utf8') : null)
}

/**
 * The project config from the text of `.agit.json` wherever it was read — a
 * worktree, a ref, the contents API — merged over the defaults. `null` (no
 * file) is the defaults; text that does not parse throws.
 *
 * @param {string | null} text
 * @returns {ProjectConfig}
 */
export function parseProjectConfig(text) {
  if (text === null || text === undefined) return /** @type {ProjectConfig} */ (merge(DEFAULTS, {}))
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`${PROJECT_FILE}: ${/** @type {Error} */ (err).message}`)
  }
  return /** @type {ProjectConfig} */ (merge(DEFAULTS, raw))
}

/** The bases `agit pr merge` accepts. */
export function mergeableBases(config, baseBranch) {
  return config.mergeableBases ?? (baseBranch ? [baseBranch] : [])
}

// ---------------------------------------------------------------------------
// Machine config
// ---------------------------------------------------------------------------

/** Where machine config and App credentials live. */
export function agitHome(env = process.env) {
  if (env.AGIT_HOME) return env.AGIT_HOME
  const xdg = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return join(xdg, 'agit')
}

/**
 * `owners` maps a GitHub owner (user or org login, lowercased) to an App slug.
 *
 * @typedef {{ defaultApp?: string | null, owners?: Record<string, string> }} UserConfig
 */

/** @returns {UserConfig} */
export function loadUserConfig(env = process.env) {
  const path = join(agitHome(env), 'config.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${path}: ${/** @type {Error} */ (err).message}`)
  }
}

/**
 * Which App acts for `owner`: the environment, then the project's pin, then the
 * owner map, then the machine default. `null` when nothing names one — the
 * credential helper reads that as "not mine" and stays silent.
 *
 * @param {{ owner?: string, project?: { app?: string | null } | null, user?: UserConfig, env?: NodeJS.ProcessEnv }} input
 */
export function appFor({ owner, project, user = {}, env = process.env }) {
  if (env.AGIT_APP) return env.AGIT_APP
  if (project?.app) return project.app
  const byOwner = owner ? user.owners?.[owner.toLowerCase()] : undefined
  return byOwner ?? user.defaultApp ?? null
}

/** `{ owner, repo }` from a github.com remote URL, or `null`. */
export function parseRemote(url) {
  const m =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      String(url ?? '').trim(),
    )
  return m ? { owner: m[1], repo: m[2] } : null
}
