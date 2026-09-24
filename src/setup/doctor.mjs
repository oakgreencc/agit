// @ts-check
/**
 * `agit doctor` — is this machine and this repository actually protected?
 *
 * Every piece of the arrangement fails quietly when it is missing: a hook not
 * wired is a hook that never fires, a CODEOWNERS the ruleset does not enforce
 * is documentation, an App holding Workflows can make itself green. None of
 * that shows up as an error anywhere else. So this checks each piece and says
 * which are there:
 *
 *   ✓  in place
 *   !  works, but weaker than it looks — read the line
 *   ✗  broken; agit or the protection will not work. Exit 1.
 *
 * Reads only. The one GitHub read that needs the App's JWT rather than an
 * installation token is the installation's permissions.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ownersOf, parseCodeowners } from '../codeowners.mjs'
import { mergeableBases } from '../config.mjs'
import { flag, has, resolveContext } from '../context.mjs'
import { findHook, hooksDir } from '../git-hooks.mjs'
import { appJwt, readAppCredentials, request } from '../github/app.mjs'
import { describe } from '../maintainer.mjs'
import { SELF_PROTECTED } from '../protected.mjs'
import { WITHHELD_PERMISSIONS } from './manifest.mjs'
import { missingFromSettings } from './settings.mjs'

/** @typedef {{ level: 'ok' | 'warn' | 'fail', label: string, detail?: string }} Finding */

const ok = (label, detail) => ({ level: /** @type {const} */ ('ok'), label, ...(detail ? { detail } : {}) })
const warn = (label, detail) => ({ level: /** @type {const} */ ('warn'), label, ...(detail ? { detail } : {}) })
const fail = (label, detail) => ({ level: /** @type {const} */ ('fail'), label, ...(detail ? { detail } : {}) })

/** Node major version check. */
export function nodeFinding(version = process.versions.node) {
  const major = Number(version.split('.')[0])
  return major >= 22 ? ok(`node ${version}`) : fail(`node ${version}`, 'agit needs node >= 22')
}

/**
 * The installation's permissions, judged.
 *
 * @param {Record<string, string>} perms
 * @returns {Finding[]}
 */
export function permissionFindings(perms = {}) {
  const out = []
  for (const p of ['contents', 'pull_requests']) {
    out.push(
      perms[p] === 'write'
        ? ok(`App permission ${p}: write`)
        : fail(`App permission ${p}: ${perms[p] ?? 'none'}`, 'publishing needs write; edit the App and accept the change on the installation'),
    )
  }
  for (const p of WITHHELD_PERMISSIONS) {
    if (perms[p])
      out.push(
        warn(
          `App holds ${p}: ${perms[p]}`,
          `an agent App should not — with ${p} it can change the rules it is held to. Remove it from the App's permissions.`,
        ),
      )
  }
  if (!out.some((f) => f.level !== 'ok')) out.push(ok(`App withholds ${WITHHELD_PERMISSIONS.join(', ')}`))
  return out
}

/**
 * The base branch's rules (`GET /repos/o/r/rules/branches/<base>`), judged.
 *
 * @param {any[]} rules
 * @param {string} base
 * @returns {Finding[]}
 */
export function rulesFindings(rules, base) {
  const by = (t) => (rules ?? []).filter((r) => r?.type === t)
  const out = []
  const pr = by('pull_request')
  if (!pr.length) out.push(warn(`${base}: no "require a pull request" rule`, 'anything with write access can land on it directly'))
  else if (!pr.some((r) => r.parameters?.require_code_owner_review))
    out.push(warn(`${base}: code owner review not required`, 'CODEOWNERS is documentation until "Require review from Code Owners" is on'))
  else out.push(ok(`${base}: pull requests with code owner review required`))
  out.push(
    by('required_signatures').length
      ? ok(`${base}: signed commits required`)
      : warn(`${base}: signed commits not required`, 'agit commits are Verified; requiring it keeps unsigned pushes out'),
  )
  out.push(
    by('required_status_checks').length
      ? ok(`${base}: required status checks`)
      : warn(`${base}: no required status checks`, 'CI is the acceptance gate; nothing makes it required'),
  )
  return out
}

/**
 * Does CODEOWNERS own the files that define the protection?
 *
 * @param {{ path: string | null, text: string }} codeowners
 * @param {string[]} [unsupported]
 * @returns {Finding[]}
 */
export function codeownersFindings(codeowners, unsupported = []) {
  if (!codeowners.path)
    return [fail('no CODEOWNERS', 'nothing is protected on GitHub. Run: agit setup project')]
  const rules = parseCodeowners(codeowners.text)
  const out = [ok(`CODEOWNERS at ${codeowners.path}`)]
  // Only the locations that exist matter; the other two CODEOWNERS paths are
  // protected locally in case the file moves, but need no owner line.
  const wanted = SELF_PROTECTED.map((p) => p.slice(1)).filter(
    (p) => !/CODEOWNERS$/.test(p) || p === codeowners.path,
  )
  for (const p of wanted) {
    if (!ownersOf(rules, p).length)
      out.push(
        warn(
          `CODEOWNERS does not own ${p}`,
          'agit protects it locally, but a PR changing it merges with no review. Add: ' + `/${p}  @<owner>`,
        ),
      )
  }
  for (const u of unsupported) out.push(warn(`CODEOWNERS ${u}`))
  return out
}

/** @param {Finding[]} findings */
export function render(findings) {
  const mark = { ok: '✓', warn: '!', fail: '✗' }
  return findings.map((f) => `${mark[f.level]} ${f.label}${f.detail ? `\n    ${f.detail}` : ''}`).join('\n')
}

const onPath = (cmd) => {
  try {
    return execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [deps]
 */
export async function run(argv, deps = {}) {
  /** @type {Finding[]} */
  const findings = []
  const add = (...f) => findings.push(...f)

  add(nodeFinding())
  add(onPath('git') ? ok('git present') : fail('git not found'))
  const agitBin = onPath('agit')
  add(
    agitBin
      ? ok(`agit on PATH (${agitBin})`)
      : fail('agit is not on PATH', 'the hooks and the credential helper call `agit`. Install it: npm install -g <this repo>, or npm link'),
  )

  let ctx
  try {
    ctx = resolveContext({ cwd: deps.cwd ?? (flag(argv, '-C') ? resolve(/** @type {string} */ (flag(argv, '-C'))) : undefined), repo: flag(argv, '--repo'), env: deps.env })
  } catch (err) {
    add(fail('.agit.json', /** @type {Error} */ (err).message))
    return finish(findings, argv)
  }
  if (!ctx.root) {
    add(warn('not inside a git repository — repository checks skipped'))
    return finish(findings, argv)
  }
  add(ok(existsSync(join(ctx.root, '.agit.json')) ? '.agit.json parses' : 'no .agit.json (defaults apply)'))

  let owner = ''
  let repo = ''
  try {
    ;({ owner, repo } = ctx.repo())
    add(ok(`repository ${owner}/${repo}`))
  } catch (err) {
    add(fail('repository', /** @type {Error} */ (err).message))
  }

  // --- the App ------------------------------------------------------------
  let base = ctx.config.baseBranch
  if (owner) {
    let creds = null
    try {
      creds = readAppCredentials({ owner, project: ctx.config, env: ctx.env })
      add(ok(`App credentials${creds.slug ? ` (${creds.slug})` : ''}`))
    } catch (err) {
      add(fail('App credentials', /** @type {Error} */ (err).message))
    }
    if (creds) {
      try {
        const headers = { Authorization: `Bearer ${appJwt(creds)}` }
        const { json } = await request(`/repos/${owner}/${repo}/installation`, { headers })
        add(ok(`App installed on ${owner}/${repo}`))
        add(...permissionFindings(json?.permissions))
      } catch (err) {
        add(
          fail(
            `App not installed on ${owner}/${repo}`,
            `${String(/** @type {Error} */ (err).message).slice(0, 200)}${creds.slug ? `\n    Install: https://github.com/apps/${creds.slug}/installations/new` : ''}`,
          ),
        )
        creds = null
      }
    }
    if (creds) {
      try {
        const client = await ctx.client()
        add(ok('installation token mints'))
        base = base ?? (await ctx.baseBranch())
        try {
          const rules = await client.api(`/repos/${owner}/${repo}/rules/branches/${encodeURIComponent(base)}`)
          add(...rulesFindings(rules, base))
        } catch (err) {
          add(warn(`could not read the rules on ${base}`, String(/** @type {Error} */ (err).message).slice(0, 200)))
        }
      } catch (err) {
        add(fail('installation token', /** @type {Error} */ (err).message))
      }
    }
  }
  if (base) {
    const bases = mergeableBases(ctx.config, base)
    add(ok(`base ${base}; agents may merge into: ${bases.length ? bases.join(', ') : 'nothing (humans merge)'}`))
  }

  // --- CODEOWNERS -----------------------------------------------------------
  const policy = ctx.localPolicy()
  const coPath = policy.codeownersPath
  add(
    ...codeownersFindings(
      { path: coPath, text: coPath ? readFileSync(join(ctx.root, coPath), 'utf8') : '' },
      policy.unsupported,
    ),
  )

  // --- git hooks ------------------------------------------------------------
  try {
    const dir = hooksDir({ git: ctx.git, root: ctx.root, config: ctx.config })
    const required = new Set(ctx.config.hooks?.required ?? [])
    const present = []
    for (const name of ctx.config.hooks?.run ?? []) {
      if (findHook(dir, name)) present.push(name)
      else if (required.has(name)) add(fail(`required hook ${name} missing from ${dir}`))
    }
    if (present.length) add(ok(`git hooks agit will run: ${present.join(', ')} (${dir})`))
    else
      add(
        warn(
          `no git hooks in ${dir}`,
          'publishes run no local checks. If the repo tracks hooks elsewhere, set hooks.path in .agit.json',
        ),
      )
  } catch (err) {
    add(fail('git hooks directory', /** @type {Error} */ (err).message))
  }

  // --- Claude settings ------------------------------------------------------
  const settingsPath = join(ctx.root, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) add(warn('no .claude/settings.json', 'Claude Code sessions get no hooks or credential helper. Run: agit setup project'))
  else {
    try {
      const missing = missingFromSettings(JSON.parse(readFileSync(settingsPath, 'utf8')))
      if (missing.length) for (const m of missing) add(warn(`.claude/settings.json lacks ${m}`))
      else add(ok('.claude/settings.json wires the credential helper and the agit hooks'))
    } catch (err) {
      add(fail('.claude/settings.json', /** @type {Error} */ (err).message))
    }
  }

  // --- maintainer mode ------------------------------------------------------
  try {
    add(ok(describe(ctx.grant())))
  } catch {
    // no git dir: nothing to report
  }

  return finish(findings, argv)
}

function finish(findings, argv) {
  if (has(argv, '--json')) console.log(JSON.stringify(findings, null, 2))
  else console.log(render(findings))
  const failed = findings.some((f) => f.level === 'fail')
  if (failed) process.exitCode = 1
  return findings
}
