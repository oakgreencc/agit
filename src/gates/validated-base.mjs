// @ts-check
/**
 * The receipt that ties a green validation run to the base it was green ON.
 *
 * ---------------------------------------------------------------------------
 * THE HOLE THIS CLOSES.
 *
 * An agent validates its worktree, reads a green, and publishes. But a publish
 * lands file CONTENTS onto whatever the base is at that moment. If the base
 * moved in between, CI runs `new base + the agent's files` — a combination
 * nothing has executed. In the harness this was ported from, a PR went green
 * locally on 140 suites and red on the runner over 40 tests that had never run
 * in the worktree, because the base was five commits further on.
 *
 * Discipline cannot close that window: with several agents merging through the
 * day, the base can move between an agent's last validation and its publish.
 * So `agit validate` records which base it was green on, and `agit publish`
 * refuses when it is about to cut from a different one.
 *
 * ---------------------------------------------------------------------------
 * TWO SHAS. The receipt records `origin/<base>` at validation (`baseSha`) AND
 * the commit the worktree sat on (`headSha`). For a worktree cut from the base
 * they coincide. For a STACKED publish (`--base <parent-branch>`, cutting from
 * a parent PR's tip that the worktree was advanced onto) the second is the one
 * that matters. Knowing only the first refused every stacked publish, which
 * taught agents to pass the override by reflex — the laundering the gate
 * exists to stop.
 *
 * ---------------------------------------------------------------------------
 * WHERE. `<git-dir>/agit/validated-base.json`: the per-worktree git dir, so the
 * receipt is per worktree (the unit validated and published), never tracked,
 * and needs no `.gitignore` line.
 *
 * NOT A SECURITY CONTROL. An agent can write this file. What it buys is that
 * the ordinary path — validate, then publish — carries its own evidence, so a
 * drifted base cannot be published through by accident.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The receipt's path inside a worktree's git dir. */
export const receiptPath = (gitDir) => join(gitDir, 'agit', 'validated-base.json')

/**
 * @typedef {{ ref: string, baseSha: string, headSha?: string, command?: string, validatedAt: string }} Receipt
 */

/**
 * Record a green run. Never throws: a receipt that cannot be written must not
 * turn a green run red; the cost is a refusal at publish time, which is safe.
 *
 * @param {{ gitDir: string, ref: string, baseSha: string | null, headSha?: string | null, command?: string }} input
 * @returns {Receipt | null}
 */
export function writeReceipt({ gitDir, ref, baseSha, headSha = null, command }) {
  if (!baseSha) return null
  const path = receiptPath(gitDir)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const receipt = {
      ref,
      baseSha,
      ...(headSha ? { headSha } : {}),
      ...(command ? { command } : {}),
      validatedAt: new Date().toISOString(),
    }
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`)
    return receipt
  } catch {
    return null
  }
}

/** @returns {Receipt | null} */
export function readReceipt({ gitDir }) {
  const path = receiptPath(gitDir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed?.baseSha ? parsed : null
  } catch {
    return null
  }
}

/**
 * `null` when publishing is fine, or a refusal message.
 *
 * Deliberately quiet when there is NO receipt: this catches a
 * validated-then-drifted tree; it does not make local validation mandatory
 * (the pre-push hook and CI do that). A missing receipt is "unknown", and
 * unknown is not "stale". A project that wants validation mandatory lists
 * `pre-push` in `hooks.required` instead.
 *
 * @param {{ receipt: Partial<Receipt> | null, publishBaseSha: string | null, ref: string }} input
 */
export function checkValidatedBase({ receipt, publishBaseSha, ref }) {
  if (!receipt?.baseSha) return null
  if (!publishBaseSha) return null
  if (receipt.baseSha === publishBaseSha) return null
  if (receipt.headSha && receipt.headSha === publishBaseSha) return null

  const short = (s) => (s ?? '').slice(0, 12)
  const branch = ref.replace(/^origin\//, '')
  const validated =
    receipt.headSha && receipt.headSha !== receipt.baseSha
      ? `  validated against  ${short(receipt.baseSha)}  (${receipt.ref}) on HEAD ${short(receipt.headSha)}  (at ${receipt.validatedAt})\n`
      : `  validated against  ${short(receipt.baseSha)}  (${receipt.ref}, at ${receipt.validatedAt})\n`
  return (
    `refusing to publish: validation ran against a different ${ref} than this publish is cutting from.\n\n` +
    validated +
    `  publishing onto    ${short(publishBaseSha)}  (${ref})\n\n` +
    'This publish lands your files on the second one, so what CI tests is `that base +\n' +
    'your files` — a combination nothing has executed.\n\n' +
    'Bring the worktree up to the base (keeps uncommitted work) and validate again:\n\n' +
    `    agit advance ${branch}\n` +
    '    agit validate\n\n' +
    'If the intervening commits provably cannot affect this change, pass --stale-base-ok.\n' +
    'That is reported in the output, so the decision is visible rather than silent.'
  )
}
