// @ts-check
/**
 * The base branch's ruleset — the half of `agit setup project` that lives on
 * GitHub. It is what turns CODEOWNERS from documentation into a boundary.
 *
 * Detection is the App's: it reads the rules in force on the base
 * (`GET /repos/o/r/rules/branches/<base>`, whichever rulesets they come from)
 * and compares them with what agit needs. Nothing missing, nothing to do.
 *
 * The write is the human's. The App holds no Administration permission, on
 * purpose — an agent's identity that could edit rulesets could change the
 * rules it is held to. So the ruleset is created through `gh`, as the human
 * running setup, and when that is not possible (no `gh`, not logged in, not an
 * admin) the ruleset is written to a file for GitHub's "Import a ruleset".
 *
 * The write only ever ADDS protection: a missing ruleset is created, an
 * existing `agit: <base>` ruleset gains the rules it lacks, and nothing is
 * removed or relaxed — its other rules, conditions and bypass list stay as the
 * human left them. So setup can run anywhere, even from an agent's shell,
 * without being a way to loosen the base.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agitHome } from '../config.mjs'

/** The ruleset agit owns on a base branch. Other rulesets are never touched. */
export const rulesetName = (base) => `agit: ${base}`

/**
 * Repository admins may bypass, through pull requests only: a solo maintainer
 * can merge their own PR (GitHub never lets an author approve it), but a
 * direct push to the base is held to the rules like anyone's. The App is
 * never a bypass actor. (RepositoryRole 5 is the admin role.)
 */
export const ADMIN_BYPASS = Object.freeze([{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }])

/**
 * The rules agit needs on the base.
 *
 * @param {{ requiredCheck?: string | null }} [input]
 * @returns {any[]}
 */
export function wantedRules({ requiredCheck = null } = {}) {
  return [
    {
      type: 'pull_request',
      parameters: {
        // CODEOWNERS is the manifest: owned paths need their owner, the rest
        // needs no approval beyond the required checks.
        required_approving_review_count: 0,
        require_code_owner_review: true,
        dismiss_stale_reviews_on_push: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
    { type: 'required_signatures' },
    { type: 'non_fast_forward' },
    { type: 'deletion' },
    ...(requiredCheck
      ? [
          {
            type: 'required_status_checks',
            parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: requiredCheck }] },
          },
        ]
      : []),
  ]
}

const checksOf = (r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context)

/** Does `rules` already provide what `want` asks for? */
function satisfies(rules, want) {
  const same = rules.filter((r) => r?.type === want.type)
  if (want.type === 'pull_request') return same.some((r) => r.parameters?.require_code_owner_review)
  if (want.type === 'required_status_checks') return checksOf(want).every((c) => same.some((r) => checksOf(r).includes(c)))
  return same.length > 0
}

/**
 * The wanted rules the rules in force do not provide.
 *
 * @param {any[]} effective  rules on the branch, from any ruleset
 * @param {any[]} wanted
 */
export function missingRules(effective, wanted) {
  return wanted.filter((w) => !satisfies(effective ?? [], w))
}

/** One line per rule, for the human reading what setup is about to add. */
export function describeRule(rule) {
  switch (rule.type) {
    case 'pull_request':
      return 'require a pull request, with review from Code Owners'
    case 'required_signatures':
      return 'require signed commits'
    case 'non_fast_forward':
      return 'block force pushes'
    case 'deletion':
      return 'block deletion'
    case 'required_status_checks':
      return `require status checks: ${checksOf(rule).join(', ')}`
    default:
      return rule.type
  }
}

/**
 * Add `missing` to an existing ruleset's rules — tighten what is there, append
 * what is not, drop nothing.
 *
 * @param {any[]} rules
 * @param {any[]} missing
 */
export function addRules(rules, missing) {
  const out = rules.map((r) => ({ ...r, ...(r.parameters ? { parameters: { ...r.parameters } } : {}) }))
  for (const m of missing) {
    const have = out.find((r) => r.type === m.type)
    if (have && m.type === 'pull_request') have.parameters = { ...have.parameters, require_code_owner_review: true }
    else if (have && m.type === 'required_status_checks') {
      const known = new Set(checksOf(have))
      have.parameters.required_status_checks = [
        ...(have.parameters.required_status_checks ?? []),
        ...m.parameters.required_status_checks.filter((c) => !known.has(c.context)),
      ]
    } else if (!have) out.push(m)
  }
  return out
}

/**
 * The body to POST (no `existing`) or PUT (`existing`, from GET .../rulesets/<id>).
 *
 * @param {{ base: string, wanted: any[], missing: any[], existing?: any }} input
 */
export function rulesetBody({ base, wanted, missing, existing = null }) {
  if (existing)
    return {
      name: existing.name,
      target: existing.target,
      // A disabled or evaluate-only ruleset enforces nothing; turning it on
      // is part of adding the protection.
      enforcement: 'active',
      conditions: existing.conditions,
      bypass_actors: existing.bypass_actors ?? [],
      rules: addRules(existing.rules ?? [], missing),
    }
  return {
    name: rulesetName(base),
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: [`refs/heads/${base}`], exclude: [] } },
    bypass_actors: ADMIN_BYPASS.map((a) => ({ ...a })),
    rules: wanted,
  }
}

/**
 * The human's GitHub access, through `gh`. Every failure — not installed, not
 * logged in, not an admin — throws, and the caller falls back to a file.
 *
 * @param {{ run?: typeof spawnSync }} [deps]
 * @returns {{ who: string, api: (method: string, path: string, body?: any) => Promise<any> }}
 */
export function ghAdmin({ run = spawnSync } = {}) {
  return {
    who: 'you, through gh',
    async api(method, path, body) {
      const args = ['api', '-X', method, path.replace(/^\//, ''), '-H', 'Accept: application/vnd.github+json']
      if (body !== undefined) args.push('--input', '-')
      const r = run('gh', args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8' })
      if (r.error) throw new Error(/** @type {any} */ (r.error).code === 'ENOENT' ? 'gh is not installed' : r.error.message)
      if (r.status !== 0) throw new Error(`gh: ${String(r.stderr || r.stdout).trim().slice(0, 300)}`)
      const out = String(r.stdout).trim()
      return out ? JSON.parse(out) : null
    },
  }
}

/**
 * Make the base's rules include what agit needs: detect, then create or
 * extend `agit: <base>` as the human, else leave a file to import.
 *
 * @param {{
 *   owner: string, repo: string, base: string, requiredCheck?: string | null,
 *   effective: any[],
 *   admin: { who: string, api: (method: string, path: string, body?: any) => Promise<any> },
 *   prompt: import('./prompt.mjs').Prompter,
 *   say?: (line?: string) => void,
 *   env?: NodeJS.ProcessEnv,
 * }} input
 * @returns {Promise<{ state: 'ok' | 'created' | 'updated' | 'skipped' | 'file', file?: string }>}
 */
export async function ensureBaseRuleset({ owner, repo, base, requiredCheck = null, effective, admin, prompt, say = console.log, env = process.env }) {
  const wanted = wantedRules({ requiredCheck })
  const missing = missingRules(effective, wanted)
  if (!missing.length) {
    say(`✓ ${base} on GitHub: ${wanted.map(describeRule).join('; ')}`)
    return { state: 'ok' }
  }
  const name = rulesetName(base)
  const rulesets = `/repos/${owner}/${repo}/rulesets`
  say(`\n${base} on GitHub lacks:`)
  for (const m of missing) say(`  + ${describeRule(m)}`)

  const toFile = (why) => {
    const file = join(agitHome(env), 'rulesets', `${owner}-${repo}-${base.replace(/[^\w.-]/g, '_')}.json`)
    mkdirSync(join(agitHome(env), 'rulesets'), { recursive: true })
    writeFileSync(file, `${JSON.stringify(rulesetBody({ base, wanted, missing }), null, 2)}\n`)
    say(`! could not apply it as you (${why}).`)
    say(`  A repository admin can import ${file}`)
    say(`  at https://github.com/${owner}/${repo}/settings/rules → New ruleset → Import a ruleset,`)
    say(`  or log in with \`gh auth login\` and run agit setup project again.`)
    return /** @type {const} */ ({ state: 'file', file })
  }

  let existing = null
  try {
    const list = (await admin.api('GET', rulesets)) ?? []
    const hit = list.find((r) => r.name === name && r.target === 'branch')
    existing = hit ? await admin.api('GET', `${rulesets}/${hit.id}`) : null
  } catch (err) {
    return toFile(/** @type {Error} */ (err).message)
  }
  const body = rulesetBody({ base, wanted, missing, existing })
  const verb = existing ? 'update' : 'create'
  if (!existing) say(`  bypass: repository admins, through pull requests only (the App never)`)
  if (!(await prompt.confirm(`${verb} ruleset "${name}" on ${owner}/${repo}, as ${admin.who}?`, { default: true }))) {
    say(`  skipped the ruleset`)
    return { state: 'skipped' }
  }
  try {
    await admin.api(existing ? 'PUT' : 'POST', existing ? `${rulesets}/${existing.id}` : rulesets, body)
  } catch (err) {
    return toFile(/** @type {Error} */ (err).message)
  }
  say(`  ${verb}d ruleset "${name}"`)
  return { state: existing ? 'updated' : 'created' }
}
