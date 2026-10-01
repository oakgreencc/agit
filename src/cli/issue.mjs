// @ts-check
/**
 * `agit issue` — read and write issues as the App. Bodies come from files,
 * answers are JSON on stdout.
 *
 *   agit issue read <n>
 *   agit issue create --title <t> --body-file <f> [--labels a,b]
 *   agit issue comment <n> --body-file <f>
 *   agit issue close <n> --body-file <f> [--reason completed|not_planned|duplicate]
 *   agit issue edit <n> --body-file <f> --etag <etag from issue read>
 *   agit issue assign <n> --login <l>
 *   agit issue label <n> [--add a,b] [--remove c,d]
 *
 * An inline `--body` is refused: a body on a command line is where the shell
 * eats the backticks. `--body-file -` reads stdin. A read that cannot
 * complete is one line on stderr and exit 1, with nothing on stdout — so a
 * caller piping the JSON never parses a failure as an issue.
 */

import { readFileSync } from 'node:fs'
import { flag, has, positionals } from '../context.mjs'
import { PublishError } from '../errors.mjs'
import {
  assignIssue,
  closeIssue,
  commentOnIssue,
  createIssue,
  editIssueBody,
  labelIssue,
  readIssue,
  UNREADABLE,
} from '../github/issues.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

const USAGE = `usage: agit issue read <n>
       agit issue create --title <t> --body-file <f> [--labels a,b]
       agit issue comment <n> --body-file <f>
       agit issue close <n> --body-file <f> [--reason completed|not_planned|duplicate]
       agit issue edit <n> --body-file <f> --etag <etag from issue read>
       agit issue assign <n> --login <login>
       agit issue label <n> [--add a,b] [--remove c,d]
(--body-file - reads stdin; common: -C <dir>, --repo <owner/repo>)`

const VALUE_FLAGS = [
  ...COMMON_VALUE_FLAGS,
  '--title',
  '--body-file',
  '--labels',
  '--reason',
  '--etag',
  '--login',
  '--add',
  '--remove',
  '--body',
]

const usage = () => new PublishError(USAGE)

/** `12` or `#12` → 12; anything else → null. @param {string | undefined} arg */
const issueNumber = (arg) => (/^#?\d+$/.test(arg ?? '') ? Number(String(arg).replace('#', '')) : null)

/** @param {string[]} argv @param {string} name */
const list = (argv, name) => (flag(argv, name) ?? '').split(',').map((s) => s.trim()).filter(Boolean)

/**
 * The command line → what to do, or a usage refusal before anything runs.
 *
 * @param {string[]} argv
 */
export function parse(argv) {
  // Bodies come from files: an inline body is refused with the flag to use.
  if (has(argv, '--body')) throw new PublishError(`refusing: --body — write the body to a file and pass --body-file (or --body-file - for stdin)\n${USAGE}`)
  const [action, numberArg, ...extra] = positionals(argv, VALUE_FLAGS)
  const bodyFile = flag(argv, '--body-file')
  if (action === 'create') {
    const title = flag(argv, '--title')
    if (numberArg !== undefined || !title || !bodyFile) throw usage()
    return { action, title, bodyFile, labels: list(argv, '--labels') }
  }
  const number = issueNumber(numberArg)
  if (number === null || extra.length) throw usage()
  switch (action) {
    case 'read':
      return { action, number }
    case 'comment':
      if (!bodyFile) throw usage()
      return { action, number, bodyFile }
    case 'close':
      if (!bodyFile) throw usage()
      return { action, number, bodyFile, reason: flag(argv, '--reason') ?? 'completed' }
    case 'edit': {
      // No --etag, no write: a blind body replace is the clobber this verb exists to prevent.
      const etag = flag(argv, '--etag')
      if (!bodyFile || !etag) throw usage()
      return { action, number, bodyFile, etag }
    }
    case 'assign': {
      const login = flag(argv, '--login')
      if (!login) throw usage()
      return { action, number, login }
    }
    case 'label': {
      const add = list(argv, '--add')
      const remove = list(argv, '--remove')
      if (!add.length && !remove.length) throw usage()
      return { action, number, add, remove }
    }
  }
  throw usage()
}

/**
 * @param {string[]} argv
 * @param {{ client?: import('../github/app.mjs').Client, readFile?: (path: string) => string,
 *   stdin?: () => string, say?: (line: string) => void }} [deps]
 */
export async function run(
  argv,
  {
    client: given,
    readFile = (p) => readFileSync(p, 'utf8'),
    stdin = () => readFileSync(0, 'utf8'),
    say = console.log,
  } = {},
) {
  const intent = /** @type {any} */ (parse(argv))
  // The body is read before any request: a missing file writes nothing.
  const body = intent.bodyFile ? (intent.bodyFile === '-' ? stdin() : readFile(intent.bodyFile)) : null
  const ctx = contextFrom(argv, { needRoot: false, client: given })
  const { owner, repo } = ctx.repo()
  const client = await ctx.client()
  const at = { client, owner, repo }
  const print = (/** @type {unknown} */ value) => say(JSON.stringify(value, null, 2))
  const { number } = intent

  switch (intent.action) {
    case 'read': {
      /** @type {import('../github/issues.mjs').Failure[]} */
      const failures = []
      const issue = await readIssue({ ...at, number, failures })
      if (issue === UNREADABLE) {
        const [{ what, error }] = failures
        throw new PublishError(`issue read: ${what} is unreadable: ${error}`)
      }
      return print(issue)
    }
    case 'create':
      return print(await createIssue({ ...at, title: intent.title, body, labels: intent.labels }))
    case 'comment':
      return print(await commentOnIssue({ ...at, number, body }))
    case 'close':
      return print(await closeIssue({ ...at, number, body, reason: intent.reason }))
    case 'edit':
      return print(await editIssueBody({ ...at, number, body, etag: intent.etag }))
    case 'assign':
      return print(await assignIssue({ ...at, number, login: intent.login }))
    case 'label':
      return print(await labelIssue({ ...at, number, add: intent.add, remove: intent.remove }))
  }
}
