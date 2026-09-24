// @ts-check
/**
 * `agit setup project` — bootstrap one repository for agent work.
 *
 * Writes three files, each shown before it is written:
 *
 *   .agit.json              the project's policy (config.mjs): the base PRs
 *                           land on, what validates a tree, where the tracked
 *                           git hooks live, which bases agents may merge into.
 *   CODEOWNERS              the manifest of protected paths (protected.mjs).
 *                           At minimum it must own the files that define the
 *                           protection — itself, `.agit.json`, the Claude
 *                           settings, the hooks — or an agent could loosen its
 *                           own policy and merge that on green.
 *   .claude/settings.json   the credential helper, the Claude Code hooks and
 *                           the permissions (settings.mjs).
 *
 * Then it prints what only a human can do on GitHub — the rulesets that turn
 * CODEOWNERS from documentation into a boundary. The App cannot apply them: it
 * holds no Administration permission, on purpose.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CODEOWNERS_LOCATIONS, findCodeowners, ownersOf, parseCodeowners } from '../codeowners.mjs'
import { PROJECT_FILE } from '../config.mjs'
import { contextOptions } from '../cli/common.mjs'
import { flag, has, resolveContext } from '../context.mjs'
import { NoAppError, readAppCredentials } from '../github/app.mjs'
import { installUrl } from './manifest.mjs'
import { createPrompter } from './prompt.mjs'
import { claudeHooks, envToPairs, gitConfigEnv, mergeSettings } from './settings.mjs'

const say = (line = '') => console.log(line)

/** Tracked hook directories, in the order they are looked for. */
export const HOOK_DIRS = ['.githooks', '.husky', '.hooks']

/** A validate command from package.json scripts and the lockfile present. */
export function suggestValidate(root) {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return null
  let scripts = {}
  try {
    scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {}
  } catch {
    return null
  }
  const script = ['ci', 'test'].find((s) => scripts[s])
  if (!script) return null
  const pm = existsSync(join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(root, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))
        ? 'bun'
        : 'npm'
  return `${pm} run ${script}`
}

/** The first tracked hooks directory that exists, or null. */
export function detectHooksDir(root) {
  return HOOK_DIRS.find((d) => existsSync(join(root, d))) ?? null
}

/**
 * The CODEOWNERS lines the protection needs and the file does not have.
 *
 * @param {{ text: string, codeownersPath: string, hooksDir: string | null, owner: string }} input
 * @returns {string[]}
 */
export function missingCodeownersLines({ text, codeownersPath, hooksDir, owner }) {
  const rules = parseCodeowners(text)
  const wanted = [
    [`/${codeownersPath}`, codeownersPath],
    [`/${PROJECT_FILE}`, PROJECT_FILE],
    ['/.claude/settings.json', '.claude/settings.json'],
    ...(hooksDir ? [[`/${hooksDir}/`, `${hooksDir}/pre-commit`]] : []),
  ]
  return wanted.filter(([, sample]) => !ownersOf(rules, sample).length).map(([pattern]) => `${pattern}  ${owner}`)
}

/** A new CODEOWNERS, owning only the protection itself. */
export function newCodeowners(lines) {
  return [
    '# Paths a human must approve. agit reads this file as the manifest of',
    '# protected paths: agents cannot edit or publish them without a',
    '# maintainer grant, and with "Require review from Code Owners" on the',
    "# base branch's ruleset, GitHub will not merge them without the owner.",
    '#',
    '# Keep it short. List what changes what the gates catch, what an agent may',
    '# do, or what reaches production — not everything that is important.',
    '',
    '# The protection itself.',
    ...lines,
    '',
  ].join('\n')
}

/** Lines added/removed between two texts — enough to confirm a write by. */
export function lineDiff(before, after) {
  const a = (before ?? '').split('\n')
  const b = after.split('\n')
  const inA = new Set(a)
  const inB = new Set(b)
  return [...a.filter((l) => l.trim() && !inB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => l.trim() && !inA.has(l)).map((l) => `+ ${l}`)]
}

/** The GitHub-side checklist: what makes CODEOWNERS a boundary. */
export function githubChecklist({ owner, repo, base, requiredCheck, slug }) {
  const rules = `https://github.com/${owner}/${repo}/settings/rules`
  return [
    'On GitHub (a human with admin rights; the App deliberately cannot):',
    '',
    `  ${rules}  → New branch ruleset, target: ${base}`,
    '    [ ] Require a pull request before merging',
    '    [ ] Require review from Code Owners        ← this is what makes CODEOWNERS binding',
    `    [ ] Require status checks to pass${requiredCheck ? ` (${requiredCheck})` : ''}`,
    '    [ ] Require signed commits                 ← agit commits are Verified; pushes from agents are not',
    '    [ ] Block force pushes',
    '  Optional: a second ruleset limiting what the App may create, e.g. branches `agent/**` only.',
    `  Optional: Settings → General → Allow auto-merge, if agents will use \`agit pr merge --auto\`.`,
    ...(slug ? ['', `  App installation (repositories it may touch): ${installUrl(slug)}`] : []),
    '',
    'Then check everything with: agit doctor',
  ].join('\n')
}

const USAGE = `usage: agit setup project [--base <branch>] [--validate "<command>"] [--required-check <name>]
                          [--mergeable <a,b | none>] [--codeowner <@handle>] [--hooks-path <dir>]
                          [--no-claude] [--yes]`

/**
 * @param {string[]} argv
 * @param {{ prompt?: import('./prompt.mjs').Prompter, cwd?: string, env?: NodeJS.ProcessEnv }} [deps]
 */
export async function setupProject(argv, deps = {}) {
  if (has(argv, '--help')) return say(USAGE)
  const prompt = deps.prompt ?? createPrompter({ yes: has(argv, '--yes') })
  try {
    const ctx = resolveContext(contextOptions(argv, deps))
    const root = ctx.requireRoot()
    const { owner, repo, full } = ctx.repo()
    say(`Setting up ${full} in ${root}`)

    // --- the App must reach this repo -----------------------------------
    let meta
    let slug = null
    try {
      const client = await ctx.client()
      meta = await client.api(`/repos/${owner}/${repo}`)
    } catch (err) {
      if (err instanceof NoAppError) throw new Error(`${err.message}\nCreate one first: agit setup app`)
      if (/: 404 /.test(String(/** @type {Error} */ (err)?.message))) {
        throw new Error(
          `the App is not installed on ${full} (GitHub answered 404).\n` +
            'Install it on this repository — https://github.com/apps/<your-app>/installations/new — and run this again.',
        )
      }
      throw err
    }
    say(`✓ the App can reach ${full} (default branch: ${meta.default_branch})`)
    try {
      slug = readAppCredentials({ owner, project: ctx.config, env: ctx.env }).slug
    } catch {
      slug = null
    }

    // --- .agit.json ------------------------------------------------------
    const projectPath = join(root, PROJECT_FILE)
    const current = existsSync(projectPath) ? JSON.parse(readFileSync(projectPath, 'utf8')) : {}
    const baseBranch =
      flag(argv, '--base') ??
      (await prompt.ask('Base branch agent PRs target', { default: current.baseBranch ?? meta.default_branch, flag: '--base' }))
    const validate =
      flag(argv, '--validate') ??
      (await prompt.ask('Command that validates a worktree (empty for none)', {
        default: current.validate?.command ?? suggestValidate(root) ?? '',
        flag: '--validate',
      }))
    const requiredCheck =
      flag(argv, '--required-check') ??
      (await prompt.ask('Required status check on the base, for stop-the-line (empty for none)', {
        default: current.requiredCheck ?? '',
        flag: '--required-check',
      }))
    const mergeableRaw =
      flag(argv, '--mergeable') ??
      (await prompt.ask("Bases agents may merge PRs into themselves (comma-separated, 'none' = never)", {
        default: (current.mergeableBases ?? [baseBranch]).join(',') || 'none',
        flag: '--mergeable',
      }))
    const mergeable = mergeableRaw.trim() === 'none' ? [] : mergeableRaw.split(',').map((s) => s.trim()).filter(Boolean)
    const hooksDir = flag(argv, '--hooks-path') ?? current.hooks?.path ?? detectHooksDir(root)

    const project = { ...current }
    if (baseBranch !== meta.default_branch || current.baseBranch) project.baseBranch = baseBranch
    if (mergeable.length !== 1 || mergeable[0] !== baseBranch) project.mergeableBases = mergeable
    else delete project.mergeableBases
    if (requiredCheck) project.requiredCheck = requiredCheck
    else delete project.requiredCheck
    if (validate) project.validate = { ...(current.validate ?? {}), command: validate }
    if (hooksDir) project.hooks = { ...(current.hooks ?? {}), path: hooksDir }
    await writeWithConfirm(prompt, projectPath, `${JSON.stringify(project, null, 2)}\n`, root)

    // --- CODEOWNERS ------------------------------------------------------
    const found = findCodeowners((p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null))
    const isOrg = meta.owner?.type === 'Organization'
    const handle =
      flag(argv, '--codeowner') ??
      (await prompt.ask(
        isOrg ? 'Code owner for protected paths (@user or @org/team)' : 'Code owner for protected paths',
        { default: isOrg ? null : `@${owner}`, flag: '--codeowner' },
      ))
    const coPath = found.path ?? CODEOWNERS_LOCATIONS[0]
    const missing = missingCodeownersLines({ text: found.text, codeownersPath: coPath, hooksDir, owner: handle })
    if (missing.length) {
      const next = found.path
        ? `${found.text.replace(/\n*$/, '\n')}\n# The protection itself (added by agit setup).\n${missing.join('\n')}\n`
        : newCodeowners(missing)
      await writeWithConfirm(prompt, join(root, coPath), next, root)
    } else say(`✓ ${coPath} already owns the protection itself`)

    // --- .claude/settings.json ------------------------------------------
    if (!has(argv, '--no-claude')) {
      const settingsPath = join(root, '.claude', 'settings.json')
      const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
      // Keep rewrites for other owners the file already names.
      const owners = new Set([owner])
      for (const [k, v] of envToPairs(existing.env)) {
        const m = /^git@github\.com:([^/]+)\/$/.exec(v)
        if (/^url\..*\.insteadOf$/.test(k) && m) owners.add(m[1])
      }
      const next = mergeSettings(existing, { env: gitConfigEnv({ owners: [...owners] }), hooks: claudeHooks() })
      await writeWithConfirm(prompt, settingsPath, `${JSON.stringify(next, null, 2)}\n`, root)
    }

    say('')
    say(githubChecklist({ owner, repo, base: baseBranch, requiredCheck: requiredCheck || null, slug }))
  } finally {
    prompt.close()
  }
}

/** Show what would change, confirm, write. Unchanged files are left alone. */
async function writeWithConfirm(prompt, path, content, root) {
  const rel = path.slice(root.length + 1)
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (before === content) {
    say(`✓ ${rel} is up to date`)
    return false
  }
  say(`\n${before === null ? 'create' : 'update'} ${rel}:`)
  for (const l of lineDiff(before, content).slice(0, 40)) say(`  ${l}`)
  if (!(await prompt.confirm(`write ${rel}?`, { default: true, flag: '--yes' }))) {
    say(`  skipped ${rel}`)
    return false
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  say(`  wrote ${rel}`)
  return true
}
