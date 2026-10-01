// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unknownVerbs, verbsNamedIn } from '../src/verb-drift.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('reads fenced code and inline spans, never prose', () => {
  const md = ['agit publishes for you', '```sh', 'agit publish x "m" --all  # then agit bogus', '```', 'Run `agit pr merge 7`.'].join('\n')
  assert.deepEqual(verbsNamedIn(md), [
    { line: 3, verb: 'publish', action: null },
    { line: 5, verb: 'pr', action: 'merge' },
  ])
})

test('a double-quoted string inside code is text, not an invocation; help is a builtin', () => {
  assert.deepEqual(unknownVerbs('`agit --version || echo "NO — agit is not on PATH"` `agit help`'), [])
})

test('a noun with a placeholder after it is the noun; flags and placeholders name nothing', () => {
  assert.deepEqual(verbsNamedIn('`agit issue <action>` `agit --version` `agit <verb>`'), [{ line: 1, verb: 'issue', action: null }])
})

test('an unknown verb, and a known noun with an action it lacks, are drift', () => {
  const md = '`agit frobnicate` `agit pr squash 3` `agit issue label 4 --add bug` `agit hook guard-protected` `agit hook nope`'
  assert.deepEqual(unknownVerbs(md), [
    { line: 1, verb: 'frobnicate' },
    { line: 1, verb: 'pr squash' },
    { line: 1, verb: 'hook nope' },
  ])
})

test('the shipped docs name only verbs agit runs', () => {
  const files = [
    'README.md',
    ...['docs', 'skills'].flatMap((d) =>
      readdirSync(join(ROOT, d), { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.md'))
        .map((f) => join(d, f)),
    ),
  ]
  const drift = files.flatMap((f) =>
    unknownVerbs(readFileSync(join(ROOT, f), 'utf8')).map(({ line, verb }) => `${relative(ROOT, join(ROOT, f))}:${line} agit ${verb}`),
  )
  assert.deepEqual(drift, [])
})
