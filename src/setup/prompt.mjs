// @ts-check
/**
 * Questions for the human running setup — and a refusal, not a hang, when
 * there is nobody to answer.
 *
 * Every question has a flag. Without a TTY (an agent's Bash call, CI) a
 * question with a default takes it under `--yes`, and one without a default
 * fails naming the flag that answers it, so an unattended run never blocks on
 * stdin that will never come.
 */

import { createInterface } from 'node:readline/promises'

/**
 * @typedef {{
 *   ask: (question: string, opts?: { default?: string | null, flag?: string }) => Promise<string>,
 *   confirm: (question: string, opts?: { default?: boolean, flag?: string }) => Promise<boolean>,
 *   close: () => void,
 * }} Prompter
 */

/**
 * @param {{ yes?: boolean, interactive?: boolean, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [opts]
 * @returns {Prompter}
 */
export function createPrompter({
  yes = false,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  input = process.stdin,
  output = process.stdout,
} = {}) {
  /** @type {import('node:readline/promises').Interface | null} */
  let rl = null
  const line = async (q) => {
    rl ??= createInterface({ input, output })
    return (await rl.question(q)).trim()
  }
  const unanswerable = (question, flag) =>
    new Error(`setup needs an answer to "${question}" and has no terminal to ask on.${flag ? ` Pass ${flag}.` : ''}`)

  return {
    async ask(question, { default: def = null, flag } = {}) {
      if (yes && def !== null) return def
      if (!interactive) {
        if (def !== null && yes) return def
        throw unanswerable(question, flag)
      }
      for (;;) {
        const got = await line(`${question}${def ? ` [${def}]` : ''}: `)
        if (got) return got
        if (def !== null) return def
      }
    },
    async confirm(question, { default: def = true, flag } = {}) {
      if (yes) return true
      if (!interactive) throw unanswerable(question, flag ?? '--yes')
      const got = (await line(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase()
      if (!got) return def
      return got.startsWith('y')
    },
    close() {
      rl?.close()
      rl = null
    },
  }
}

/**
 * A scripted prompter for tests: answers come from `answers` by question
 * substring, else the default.
 *
 * @param {Record<string, string | boolean>} [answers]
 * @returns {Prompter & { asked: string[] }}
 */
export function scriptedPrompter(answers = {}) {
  const asked = []
  const find = (q) => Object.entries(answers).find(([k]) => q.includes(k))?.[1]
  return {
    asked,
    async ask(q, { default: def = null } = {}) {
      asked.push(q)
      const a = find(q)
      if (a !== undefined) return String(a)
      if (def === null) throw new Error(`scripted prompter: no answer for "${q}"`)
      return def
    },
    async confirm(q, { default: def = true } = {}) {
      asked.push(q)
      const a = find(q)
      return a === undefined ? def : Boolean(a)
    },
    close() {},
  }
}
