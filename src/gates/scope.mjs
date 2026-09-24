// @ts-check
/**
 * What a publish is allowed to carry: the scope gate (`--paths` or `--all`,
 * never an implied sweep) and the payload gate (no `*.log`, no path that grows
 * by more than a ceiling in one publish).
 *
 * ---------------------------------------------------------------------------
 * THE INCIDENT.
 *
 * In the harness agit was ported from, a mangled invocation — `publish` with `--api` in the branch
 * slot, a `GET /repos/…` path as the message, no `--paths`, no `--pr` — swept
 * a 55,130-line `androidfailedbuild.log` out of an agent worktree into a
 * Verified commit on a branch named `--api`. Nothing ran on it: no PR, so no
 * CI; no local `git commit`/`push`, so no hook. Three things let it through and
 * each has a gate here:
 *
 *   - `--paths` was optional, and absent meant "everything `git status` lists,
 *     untracked included". The docs said "`--paths` always"; a sentence is
 *     not a gate. Now a publish names its paths or says `--all`, and a missing
 *     flag is refused BEFORE any API call, with the list of what the sweep
 *     would have taken — so the refusal is also the review.
 *   - Nothing looked at what a blob was or how big. `inlineable()` in
 *     `tree.mjs` decides inline-vs-posted, never yes-vs-no. Now a `*.log` is
 *     refused at any size, and any path that gains more than
 *     {@link ADDED_BYTES_CEILING} in one publish is refused.
 *   - A publish without `--pr` lands a branch nothing ever runs on. That is
 *     legitimate — stacking, a second commit to an open PR — so it is a note
 *     on stdout, not a refusal: see {@link noPrNote}.
 *
 * The branch-name half (`--api` as a ref) belongs to a branch-name ruleset
 * on GitHub (see docs/github-setup.md), and is deliberately not duplicated here.
 *
 * ---------------------------------------------------------------------------
 * WHY ADDED BYTES, NOT BLOB SIZE.
 *
 * The ticket proposed a flat 512 KiB per-blob ceiling. Two tracked files
 * already exceed it — `pnpm-lock.yaml` (~816 KB) and
 * an OpenAPI spec (~930 KB) — so a flat ceiling fires
 * on every dependency bump and every schema edit, and an override that fires
 * on routine work is an override that gets typed by reflex. The question that
 * separates a lockfile bump from a dumped log is not "how big is this file"
 * but "how much is this publish adding to it": a bump adds kilobytes to a
 * large file; a log adds megabytes to nothing. So the gate is
 * `size on disk − size on the branch head`, and the ceiling stays at 512 KiB.
 *
 * `*.log` is the exception that is about identity, not size: a ten-byte log
 * is still not source, so it is refused regardless.
 *
 * `--allow-large <path,path>` lifts both refusals, for exactly the paths it
 * names — an override that has to spell the path cannot be typed by reflex.
 *
 * Pure but for {@link payloadRefusalsInTree}: the rest take what git printed
 * and what the caller measured, and return findings. The CLI prints.
 */

import { patternToRegExp } from '../codeowners.mjs'

/** The most one publish may add to a single path, in bytes. */
export const ADDED_BYTES_CEILING = 512 * 1024

/** The default never-published patterns: the one shape the incident produced. */
export const NEVER_PUBLISH = ['*.log']

/**
 * A path that is never published, whatever its size — `payload.neverPublish`
 * in `.agit.json`, CODEOWNERS syntax, matched case-insensitively (a `Build.LOG`
 * is still a log).
 *
 * @param {string} path
 * @param {string[]} [patterns]
 */
export function isNeverPublished(path, patterns = NEVER_PUBLISH) {
  return patterns.some((p) => {
    const re = patternToRegExp(p)
    return re ? new RegExp(re.source, 'i').test(path) : false
  })
}

/**
 * Blob sizes on a tree-ish, from `git ls-tree -r -l -z <tree-ish>`. Records
 * are `<mode> blob <sha> <size-right-aligned>\t<path>`; a gitlink's size is
 * `-` and is skipped, as is anything that is not a blob.
 *
 * @param {string} lsTreeLZ
 * @returns {Map<string, number>} path → bytes
 */
export function blobSizes(lsTreeLZ) {
  const sizes = new Map()
  for (const rec of lsTreeLZ.split('\0')) {
    const m = /^\d{6} blob [0-9a-f]{40} +(\d+)\t(.*)$/s.exec(rec)
    if (m) sizes.set(m[2], Number(m[1]))
  }
  return sizes
}

/**
 * @typedef {{ path: string, reason: 'log' | 'added-bytes', bytes: number, before: number, added: number }} PayloadRefusal
 */

/**
 * The in-scope paths this publish may not carry.
 *
 * `size(path)` is the path's size on disk now, or `null` when it is gone — a
 * deletion adds nothing and is never refused, `*.log` included. `before` is
 * {@link blobSizes} of the branch head; a path absent from it is new, so its
 * whole size is what it adds.
 *
 * @param {object} input
 * @param {string[]} input.changed            in-scope paths the publish would write
 * @param {(path: string) => number | null} input.size
 * @param {Map<string, number>} input.before  sizes on the branch head
 * @param {string[]} [input.allow]            `--allow-large`, exact paths
 * @param {number} [input.ceiling]
 * @param {string[]} [input.neverPublish]
 * @returns {PayloadRefusal[]}
 */
export function findPayloadRefusals({
  changed,
  size,
  before,
  allow = [],
  ceiling = ADDED_BYTES_CEILING,
  neverPublish = NEVER_PUBLISH,
}) {
  const allowed = new Set(allow)
  /** @type {PayloadRefusal[]} */
  const refused = []
  for (const path of changed) {
    if (allowed.has(path)) continue
    const bytes = size(path)
    if (bytes === null) continue // a deletion: nothing is added
    const was = before.get(path) ?? 0
    const added = bytes - was
    if (isNeverPublished(path, neverPublish)) {
      refused.push({ path, reason: 'log', bytes, before: was, added })
    } else if (added > ceiling) {
      refused.push({ path, reason: 'added-bytes', bytes, before: was, added })
    }
  }
  return refused
}

/**
 * {@link findPayloadRefusals} over the tree a publish would land: `paths`
 * (what the tree changes), their sizes IN `tree`, and their sizes on `base`.
 *
 * Measured on the built tree rather than on disk, so what is judged is what
 * ships — including anything the pre-commit hook staged or rewrote — and the
 * size is the one git stores (a symlink is its target string). A path absent
 * from `tree` is a deletion.
 *
 * @param {object} input
 * @param {(args: string[]) => string} input.git
 * @param {string} input.base           the commit the publish builds on
 * @param {string} input.tree           the tree it would land
 * @param {string[]} input.paths        the paths that tree changes
 * @param {string[]} [input.allow]
 * @param {number} [input.ceiling]
 * @param {string[]} [input.neverPublish]
 * @returns {PayloadRefusal[]}
 */
export function payloadRefusalsInTree({ git, base, tree, paths, allow, ceiling, neverPublish }) {
  if (!paths.length) return []
  const before = blobSizes(git(['ls-tree', '-r', '-l', '-z', base]))
  const after = blobSizes(git(['ls-tree', '-r', '-l', '-z', tree]))
  const size = (p) => after.get(p) ?? null
  return findPayloadRefusals({ changed: paths, size, before, allow, ceiling, neverPublish })
}

/** `1234` → `1.2 KiB`; bytes under 1 KiB stay whole. */
export function humanBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * The payload refusal. Every offending path with its size and why, then the
 * one override, spelled with the exact paths so accepting it means naming
 * them.
 *
 * @param {PayloadRefusal[]} refused
 * @param {{ ceiling?: number }} [opts]
 */
export function payloadMessage(refused, { ceiling = ADDED_BYTES_CEILING } = {}) {
  if (!refused.length) return ''
  const n = refused.length
  const describe = ({ path, reason, bytes, before, added }) =>
    reason === 'log'
      ? `  ${path} — never published (payload.neverPublish in .agit.json; ${humanBytes(bytes)})`
      : `  ${path} — adds ${humanBytes(added)} (${humanBytes(before)} → ${humanBytes(bytes)}); ` +
        `the ceiling is ${humanBytes(ceiling)} per path per publish`
  return [
    `refusing to publish: ${n} path${n === 1 ? ' is' : 's are'} not something a publish carries.`,
    '',
    ...refused.map(describe),
    '',
    'A build log, a dump or a binary belongs in artifact storage behind a tracked',
    'manifest, not in git history. If a path',
    'above really is source, name it:',
    '',
    `  --allow-large ${refused.map((r) => r.path).join(',')}`,
    '',
    'Nothing was committed.',
  ].join('\n')
}

/** The scope refusal for `--paths` and `--all` on the same command line. */
export const BOTH_SCOPES_MESSAGE = 'refusing to publish: pass --paths or --all, not both.'

/**
 * The scope refusal: `publish` was given neither `--paths` nor `--all`.
 * Lists what the sweep would have taken, so the reader can decide which of
 * the two flags is true. `usage` is the verb's usage line, printed first so
 * the refusal is also the reference.
 *
 * @param {string[]} wouldSweep  every uncommitted path, untracked included
 * @param {{ usage?: string }} [opts]
 */
export function sweepMessage(wouldSweep, { usage } = {}) {
  const n = wouldSweep.length
  const listing = n
    ? [
        `Without --paths a publish sweeps every uncommitted change in the worktree — ${n} path${n === 1 ? '' : 's'} here:`,
        '',
        ...wouldSweep.map((p) => `  ${p}`),
      ]
    : [
        'Without --paths a publish sweeps every uncommitted change in the worktree (nothing is uncommitted here).',
      ]
  return [
    ...(usage ? [usage, ''] : []),
    'refusing to publish: no --paths and no --all.',
    '',
    ...listing,
    '',
    'Name what you mean to publish:',
    '',
    '  --paths <a,b>     these paths, and directories under them',
    '  --all             everything listed above, on purpose',
    '',
    'Nothing was sent to GitHub.',
  ].join('\n')
}

/**
 * The note a publish without `--pr` prints when the branch has no open PR
 * either. Not a refusal — a stacked layer or a second commit to a branch
 * whose PR is already open is exactly this shape — but a branch with no PR is
 * a branch CI typically never runs on (most workflows trigger on `pull_request` and
 * `merge_group` only), and that silence is how the incident's commit sat
 * unexamined.
 *
 * @param {{ branch: string, base: string }} input
 */
export function noPrNote({ branch, base }) {
  return (
    `note: ${branch} has no open pull request, so no CI runs on it. ` +
    `Open one with --pr "<title>" (targets ${base}), or stack it on a branch that has one.`
  )
}
