// @ts-check
/**
 * Everything a verb needs to know about where it is running, resolved once.
 *
 * A verb gets a `Context` from `resolveContext({ cwd })` and asks it for what
 * it uses: the worktree root, a `git` bound to it, the project policy, the
 * `owner/repo`, the base branch, an authenticated client. The expensive parts
 * (the base branch may need an API call; a client needs a token) are lazy and
 * memoised, so a verb that never talks to GitHub never mints a token.
 */

import { execFileSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { loadProjectConfig, parseRemote } from './config.mjs'
import { clientFor } from './github/app.mjs'
import { grantPath, logPath, readGrant } from './maintainer.mjs'
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
  const config = root ? loadProjectConfig(root) : loadProjectConfig(start)

  const memo = new Map()
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn())
    return memo.get(key)
  }

  const ctx = {
    root,
    git,
    config,
    env,

    /** The root, or a refusal: most verbs need a checkout. */
    requireRoot() {
      if (!root) throw new Error(`not inside a git working tree: ${start}`)
      return root
    },

    /** `{ owner, repo, full }` from the argument, `.agit.json`, or `origin`. */
    repo() {
      return once('repo', () => {
        const named = repoArg ?? config.repo
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
        return clientFor({ owner, repo, project: config, env, report: progress })
      })
    },

    /** The branch PRs land on: `.agit.json`'s `baseBranch`, else the repo's default. */
    async baseBranch() {
      if (config.baseBranch) return config.baseBranch
      return once('base', async () => {
        const { owner, repo } = ctx.repo()
        const meta = await (await ctx.client()).api(`/repos/${owner}/${repo}`)
        return meta.default_branch
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

    /** The maintainer grant as this process's session sees it. */
    grant(session) {
      const dir = ctx.gitCommonDir()
      return readGrant({ path: grantPath(dir), ...(session !== undefined ? { session } : {}) })
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
