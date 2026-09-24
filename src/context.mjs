// @ts-check
/**
 * Everything agit needs to know about where it is running, resolved once —
 * the one answer to "where am I", for every entry point:
 *
 *   resolveContext({ cwd })        a verb, from its working directory (`-C`)
 *   contextForPath(path, cwd)      a hook, from a path a tool call names — the
 *                                  checkout that path sits in, wherever it is
 *   projectFor({ owner, repo })    the credential helper: the project config
 *                                  that pins which App acts for this repo
 *
 * A caller asks the Context for what it uses: the worktree root, a `git`
 * bound to it, the project policy, the `owner/repo`, the base branch, the
 * common git dir and the maintainer grant in it, an authenticated client. The
 * expensive parts (the base branch may need an API call; a client needs a
 * token) are lazy and memoised, so a verb that never talks to GitHub never
 * mints a token — and `config` itself is read on first use, so a hook that
 * only needs the protection policy is not refused by a config it can survive.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadProjectConfig, parseRemote } from './config.mjs'
import { clientFor } from './github/app.mjs'
import { currentSession, grantPath, logPath, readGrant } from './maintainer.mjs'
import { policyAtRef, policyAtRoot } from './protected.mjs'

/**
 * git in a directory. stderr is piped rather than inherited: several calls in
 * the publish path ask git questions it answers on stderr with a "fatal:" that
 * is not one (a path absent from a ref), and inheriting would print failures
 * that are not failures. It stays in `err.message` for callers that read it.
 *
 * @param {string} dir
 * @returns {(args: string[], opts?: { env?: Record<string, string>, encoding?: 'utf8' | 'buffer', input?: string }) => any}
 */
export const gitIn =
  (dir) =>
  (args, { env, encoding = 'utf8', input } = {}) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: encoding === 'buffer' ? null : encoding,
      maxBuffer: 100 * 1024 * 1024,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      input,
      env: env ? { ...process.env, ...env } : process.env,
    })

/** Progress on stderr, so stdout stays parseable for `api`/`graphql`. */
export const progress = (line) => console.error(line)

/**
 * @param {{ cwd?: string, repo?: string | null, env?: NodeJS.ProcessEnv }} [input]
 */
export function resolveContext({ cwd = process.cwd(), repo: repoArg = null, env = process.env } = {}) {
  const start = isAbsolute(cwd) ? cwd : resolve(cwd)
  let root
  try {
    root = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    root = null
  }
  const git = gitIn(root ?? start)

  const memo = new Map()
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn())
    return memo.get(key)
  }

  const ctx = {
    root,
    git,
    env,

    /**
     * The project config at the root, merged over the defaults. Read on first
     * use; an `.agit.json` that does not parse throws THEN (see config.mjs).
     *
     * @returns {import('./config.mjs').ProjectConfig}
     */
    get config() {
      return once('config', () => loadProjectConfig(root ?? start))
    },

    /** The root, or a refusal: most verbs need a checkout. */
    requireRoot() {
      if (!root) throw new Error(`not inside a git working tree: ${start}`)
      return root
    },

    /** `{ owner, repo, full }` from the argument, `.agit.json`, or `origin`. */
    repo() {
      return once('repo', () => {
        const named = repoArg ?? ctx.config.repo
        if (named) {
          const [owner, repo] = String(named).split('/')
          if (!owner || !repo) throw new Error(`not an owner/repo: ${named}`)
          return { owner, repo, full: `${owner}/${repo}` }
        }
        let url = ''
        try {
          url = git(['remote', 'get-url', 'origin']).trim()
        } catch {
          // handled below
        }
        const parsed = parseRemote(url)
        if (!parsed)
          throw new Error(
            'cannot tell which GitHub repository this is: no github.com `origin` remote. ' +
              'Pass --repo <owner/repo> or set "repo" in .agit.json.',
          )
        return { ...parsed, full: `${parsed.owner}/${parsed.repo}` }
      })
    },

    /** An authenticated client for the repo's owner, as the App. */
    client() {
      return once('client', () => {
        const { owner, repo } = ctx.repo()
        return clientFor({ owner, repo, project: ctx.config, env, report: progress })
      })
    },

    /**
     * The branch PRs land on. ONE rule, in two strengths:
     *
     *   baseBranch()         `.agit.json`'s `baseBranch`, else the repository's
     *                        default branch as GitHub reports it now
     *   baseBranchOffline()  `.agit.json`'s `baseBranch`, else `origin/HEAD` —
     *                        the default branch as of the last fetch — for a
     *                        hook that must not mint a token; `null` if neither
     */
    async baseBranch() {
      return ctx.config.baseBranch ?? (await ctx.defaultBranch())
    },
    baseBranchOffline() {
      try {
        if (ctx.config.baseBranch) return ctx.config.baseBranch
      } catch {
        // An unreadable .agit.json falls through to the remote's HEAD.
      }
      try {
        return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace(/^origin\//, '')
      } catch {
        return null
      }
    },

    /** The repository's default branch, from GitHub. */
    defaultBranch() {
      return once('defaultBranch', async () => {
        const { owner, repo } = ctx.repo()
        const meta = await (await ctx.client()).api(`/repos/${owner}/${repo}`)
        return /** @type {string} */ (meta.default_branch)
      })
    },

    gitDir() {
      return once('gitDir', () => git(['rev-parse', '--absolute-git-dir']).trim())
    },

    gitCommonDir() {
      return once('commonDir', () => {
        const d = git(['rev-parse', '--git-common-dir']).trim()
        return isAbsolute(d) ? d : resolve(root ?? start, d)
      })
    },

    /** The maintainer grant as `session` (default: this process's) sees it. */
    grant(session = currentSession(env)) {
      return readGrant({ path: grantPath(ctx.gitCommonDir()), session })
    },
    grantFiles() {
      const dir = ctx.gitCommonDir()
      return { path: grantPath(dir), log: logPath(dir) }
    },

    /** The protection policy as the worktree has it. */
    localPolicy() {
      return once('localPolicy', () => policyAtRoot(ctx.requireRoot()))
    },

    /** The protection policy as `ref` has it — what GitHub will enforce. */
    policyAt(ref) {
      return once(`policy:${ref}`, () => policyAtRef({ git, ref, root: ctx.requireRoot() }))
    },
  }
  return ctx
}

/** @typedef {ReturnType<typeof resolveContext>} Context */

/**
 * The repository root containing `absPath`: the nearest ancestor holding a
 * `.git` entry — a directory for a clone, a file for a linked worktree. So a
 * file in ANY worktree, wherever the harness put it, is judged by its position
 * in its own checkout. (The harness agit was ported from stripped `.claude/worktrees/<name>/`
 * prefixes and was off for every session whose worktree lived elsewhere.)
 * A walk rather than `git rev-parse`, because the path a hook is asked about
 * may not exist yet.
 *
 * @param {string} absPath
 * @returns {{ root: string, rel: string } | null}
 */
export function locate(absPath) {
  const dir = resolve(absPath)
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) {
      const rel = relative(d, dir).split(sep).join('/')
      return rel.startsWith('..') ? null : { root: d, rel }
    }
    if (dirname(d) === d) return null
  }
}

/**
 * A resolver from paths a hook is asked about to `{ ctx, rel }` — the Context
 * of the checkout each path sits in, and the path relative to it. Contexts are
 * memoised per checkout for the life of the resolver (one hook call), so a
 * command naming ten files in one repo reads its policy and grant once.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {(path: string, cwd: string) => { ctx: Context, rel: string } | null}
 */
export function contextForPath({ env = process.env } = {}) {
  const contexts = new Map()
  return (path, cwd) => {
    const loc = locate(isAbsolute(path) ? path : resolve(cwd, path))
    if (!loc) return null
    let ctx = contexts.get(loc.root)
    if (!ctx) {
      ctx = resolveContext({ cwd: loc.root, env })
      contexts.set(loc.root, ctx)
    }
    return { ctx, rel: loc.rel }
  }
}

/**
 * The project config that governs `owner/repo` from `cwd` — for the
 * credential helper, which git runs inside the repository it is fetching. It
 * applies only when the checkout at `cwd` IS that repository, and it never
 * throws: an unreadable config is no pin, and the helper falls back to the
 * owner map like any other repo.
 *
 * @param {{ owner: string, repo: string, cwd?: string, env?: NodeJS.ProcessEnv }} input
 * @returns {import('./config.mjs').ProjectConfig | null}
 */
export function projectFor({ owner, repo, cwd = process.cwd(), env = process.env }) {
  try {
    const ctx = resolveContext({ cwd, env })
    if (!ctx.root) return null
    const here = ctx.repo()
    return here.owner.toLowerCase() === owner.toLowerCase() && here.repo.toLowerCase() === repo.toLowerCase()
      ? ctx.config
      : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Argument helpers shared by the verbs
// ---------------------------------------------------------------------------

/** The value after `name`, or null. */
export const flag = (argv, name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}
export const has = (argv, name) => argv.includes(name)

/**
 * Positional arguments: everything that is not a flag or a flag's value.
 * `valueFlags` names the flags that take a value.
 *
 * @param {string[]} argv
 * @param {string[]} valueFlags
 */
export function positionals(argv, valueFlags) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      out.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('-') && a.length > 1) {
      if (valueFlags.includes(a)) i++
      continue
    }
    out.push(a)
  }
  return out
}
