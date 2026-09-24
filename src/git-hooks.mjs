// @ts-check
/**
 * Run the repository's git hooks at the moments git would have.
 *
 * ---------------------------------------------------------------------------
 * WHY AGIT RUNS THEM ITSELF.
 *
 * A publish never runs `git commit` and never runs `git push` — GitHub creates
 * the commit through the API, which is what makes it Verified. So without this
 * module every hook a project relies on (format, lint, commit-message policy,
 * the pre-push test run) would be silently skipped for every agent commit.
 * In the harness this was ported from, a 55,000-line build log reached a
 * Verified commit that way: no local commit, so no hook; no PR, so no CI.
 *
 * So the publish path calls them at the equivalent points:
 *
 *   pre-commit           after the publish's index is built and before its tree
 *                        is written — with GIT_INDEX_FILE pointing at that
 *                        index, so `git diff --cached` shows exactly what is
 *                        being published, and a formatter's `git add` lands in
 *                        the tree that ships.
 *   prepare-commit-msg   on the message, in a file, as git passes it
 *   commit-msg           ditto; a hook may rewrite the message, and the
 *                        rewritten message is the one GitHub commits.
 *   pre-push             before anything is sent to GitHub, with git's stdin
 *                        protocol, for a local commit object with the same tree
 *                        and parent as the one GitHub will create.
 *
 * A hook exiting non-zero refuses the publish, and nothing reaches GitHub.
 * Skipping them is `--no-verify`, which needs a maintainer grant with the
 * `no-verify` scope: skipping a gate is a human's call.
 *
 * Hooks see `AGIT=1` in their environment, so a hook that must behave
 * differently under a publish (it cannot, say, rely on a real HEAD commit) can.
 */

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { PublishError } from './errors.mjs'

export const ZERO_SHA = '0'.repeat(40)

/**
 * The hooks directory agit uses: `.agit.json`'s `hooks.path` when set (so a
 * clone that never configured `core.hooksPath` still runs the tracked hooks),
 * else wherever git would look.
 *
 * @param {{ git: (args: string[]) => string, root: string, config: import('./config.mjs').ProjectConfig }} input
 */
export function hooksDir({ git, root, config }) {
  if (config.hooks?.path) return resolve(root, config.hooks.path)
  const p = git(['rev-parse', '--git-path', 'hooks']).trim()
  return isAbsolute(p) ? p : resolve(root, p)
}

/** The hook's path if it exists and is executable, else `null`. */
export function findHook(dir, name) {
  const p = join(dir, name)
  if (!existsSync(p)) return null
  try {
    accessSync(p, constants.X_OK)
    return p
  } catch {
    return null // git ignores a non-executable hook (with a hint); so do we
  }
}

/**
 * @typedef {object} HookRunnerInput
 * @property {(args: string[], opts?: any) => any} git
 * @property {string} root               the worktree root; hooks run here
 * @property {import('./config.mjs').ProjectConfig} config
 * @property {boolean} [skip]            --no-verify, already authorised by the caller
 * @property {(line: string) => void} [report]
 * @property {(file: string, args: string[], opts: any) => { status: number | null, error?: Error }} [spawn]
 */

/**
 * A runner bound to one worktree. Each method is a no-op for a hook that is
 * absent or not in `hooks.run`, and throws a PublishError for one that fails
 * or — when listed in `hooks.required` — is missing.
 *
 * @param {HookRunnerInput} input
 */
export function hookRunner({ git, root, config, skip = false, report = () => {}, spawn = defaultSpawn }) {
  const dir = hooksDir({ git, root, config })
  const enabled = new Set(config.hooks?.run ?? [])
  const required = new Set(config.hooks?.required ?? [])
  /** @type {string[]} */
  const ran = []

  /** Resolve a hook, or null; refuse a missing required one. */
  const want = (name) => {
    if (skip || !enabled.has(name)) return null
    const path = findHook(dir, name)
    if (!path && required.has(name))
      throw new PublishError(
        `refusing to publish: the \`${name}\` hook is required by .agit.json but is not an executable file in ${dir}.\n` +
          'A gate that is missing is not a gate that passed. Restore it, or fix `hooks.path`.',
      )
    return path
  }

  const run = (name, path, args, { env = {}, input } = {}) => {
    report(`hook: ${name}`)
    const res = spawn(path, args, {
      cwd: root,
      env: { ...process.env, AGIT: '1', ...env },
      input,
      // The hook's own output is progress, not agit's result: stderr.
      stdio: [input === undefined ? 'ignore' : 'pipe', 2, 2],
    })
    ran.push(name)
    if (res.error) throw new PublishError(`refusing to publish: the \`${name}\` hook could not run: ${res.error.message}`)
    if (res.status !== 0)
      throw new PublishError(
        `refusing to publish: the \`${name}\` hook exited ${res.status}. Nothing was sent to GitHub.\n\n` +
          'Fix what it reported and publish again. Skipping hooks is --no-verify, which needs a\n' +
          'maintainer grant with the `no-verify` scope — that is the human\'s call, not a retry flag.',
      )
  }

  return {
    dir,
    ran,

    /** @param {Record<string, string>} env carries GIT_INDEX_FILE for the publish index */
    preCommit(env) {
      const path = want('pre-commit')
      if (path) run('pre-commit', path, [], { env })
    },

    /**
     * prepare-commit-msg then commit-msg, on a file, as git runs them.
     * Returns the message as the hooks left it.
     *
     * @param {string} message
     * @param {Record<string, string>} [env]
     */
    commitMessage(message, env = {}) {
      const prepare = want('prepare-commit-msg')
      const check = want('commit-msg')
      if (!prepare && !check) return message
      const gitDir = git(['rev-parse', '--absolute-git-dir']).trim()
      const file = join(gitDir, 'agit', 'COMMIT_EDITMSG')
      mkdirSync(join(gitDir, 'agit'), { recursive: true })
      writeFileSync(file, message.endsWith('\n') ? message : `${message}\n`)
      if (prepare) run('prepare-commit-msg', prepare, [file, 'message'], { env })
      if (check) run('commit-msg', check, [file], { env })
      const out = cleanMessage(readFileSync(file, 'utf8'))
      if (!out) throw new PublishError('refusing to publish: the commit message is empty after the commit-msg hooks ran.')
      return out
    },

    /**
     * @param {{ branch: string, localSha: string, remoteSha: string | null, remote?: string, url?: string }} input
     */
    prePush({ branch, localSha, remoteSha, remote = 'origin', url }) {
      const path = want('pre-push')
      if (!path) return
      let remoteUrl = url
      if (!remoteUrl) {
        try {
          remoteUrl = git(['remote', 'get-url', remote]).trim()
        } catch {
          remoteUrl = remote
        }
      }
      const ref = `refs/heads/${branch}`
      run('pre-push', path, [remote, remoteUrl], {
        input: `${ref} ${localSha} ${ref} ${remoteSha ?? ZERO_SHA}\n`,
      })
    },
  }
}

/** git's default `cleanup=strip`: drop `#` comment lines and trailing blank lines. */
export function cleanMessage(text) {
  return text
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .replace(/\s+$/, '')
}

/**
 * A local commit object with `tree` and `parents` — what pre-push is shown.
 *
 * It is never published: GitHub creates the real commit, signed, from the same
 * tree and parents. So it is made with `--no-gpg-sign` and a placeholder
 * identity: signing a throwaway object would reach for whatever key the human
 * configured, and attributing it to them would be false.
 *
 * @param {{ git: (args: string[], opts?: any) => any, tree: string, parents: string[], message: string }} input
 */
export function previewCommit({ git, tree, parents, message }) {
  return git(['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], {
    env: {
      GIT_AUTHOR_NAME: 'agit preview',
      GIT_AUTHOR_EMAIL: 'agit@localhost',
      GIT_COMMITTER_NAME: 'agit preview',
      GIT_COMMITTER_EMAIL: 'agit@localhost',
    },
  }).trim()
}

function defaultSpawn(file, args, opts) {
  return spawnSync(file, args, { ...opts, encoding: 'utf8' })
}
