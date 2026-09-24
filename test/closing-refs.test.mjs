// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseClosingRefs,
  parseClosesFlag,
  partitionBodyRefs,
  withClosingTrailers,
} from '../src/closing-refs.mjs'

// --- parseClosingRefs ------------------------------------------------------

test('finds the keyword forms GitHub documents', () => {
  assert.deepEqual(parseClosingRefs('Closes #82.'), ['#82'])
  assert.deepEqual(parseClosingRefs('closed #1'), ['#1'])
  assert.deepEqual(parseClosingRefs('Fix #2'), ['#2'])
  assert.deepEqual(parseClosingRefs('fixes #3'), ['#3'])
  assert.deepEqual(parseClosingRefs('Fixed #4'), ['#4'])
  assert.deepEqual(parseClosingRefs('Resolve #5'), ['#5'])
  assert.deepEqual(parseClosingRefs('resolves #6'), ['#6'])
  assert.deepEqual(parseClosingRefs('Resolved #7'), ['#7'])
  assert.deepEqual(parseClosingRefs('Closes: #8'), ['#8'])
})

test('a bare mention is not a closing reference', () => {
  assert.deepEqual(parseClosingRefs('See #82 for context.'), [])
  assert.deepEqual(parseClosingRefs('Note #383: stacked PRs get no CI.'), [])
})

test('empty and missing input', () => {
  assert.deepEqual(parseClosingRefs(''), [])
  assert.deepEqual(parseClosingRefs(undefined), [])
})

test('deduplicates, preserving first-seen order', () => {
  assert.deepEqual(parseClosingRefs('Closes #9. Fixes #4. Closes #9 again.'), ['#9', '#4'])
})

// The one that matters: a cross-repo ref must never be flattened to a bare
// number, because that would close an unrelated issue in THIS repo.
test('a cross-repo reference keeps its owner/repo prefix', () => {
  assert.deepEqual(parseClosingRefs('Closes sektorapp/wiki#48'), ['sektorapp/wiki#48'])
  assert.deepEqual(parseClosingRefs('Fixes sektorapp/monorepo#294'), ['sektorapp/monorepo#294'])
})

test('an unkeyworded cross-repo mention is not lifted at all', () => {
  // Real prose from this repo's CLAUDE.md and issue bodies.
  assert.deepEqual(parseClosingRefs('Decided in sektorapp/wiki#31.'), [])
  assert.deepEqual(
    parseClosingRefs('which the App cannot write by design (see sektorapp/wiki#48)'),
    [],
  )
})

test('conventional-commit subjects are not mistaken for closing keywords', () => {
  assert.deepEqual(
    parseClosingRefs('fix(convert): stop claiming every XML document as GPX (#377)'),
    [],
  )
  assert.deepEqual(
    parseClosingRefs('fix(mobile): stop nesting Nx inside the native build targets'),
    [],
  )
  assert.deepEqual(parseClosingRefs('fix: resolve conflict'), [])
})

test('a merge-commit subject carrying a bare PR number closes nothing', () => {
  // This is precisely the shape that let 38 fixed issues stay open.
  assert.deepEqual(
    parseClosingRefs('Merge pull request #382 from sektorapp/agent/convert-xml-detect'),
    [],
  )
})

// --- parseClosesFlag -------------------------------------------------------

test('accepts the spellings an agent would plausibly type', () => {
  assert.deepEqual(parseClosesFlag('82'), ['#82'])
  assert.deepEqual(parseClosesFlag('#82'), ['#82'])
  assert.deepEqual(parseClosesFlag('82,196'), ['#82', '#196'])
  assert.deepEqual(parseClosesFlag('#82, #196'), ['#82', '#196'])
  assert.deepEqual(parseClosesFlag('sektorapp/wiki#48'), ['sektorapp/wiki#48'])
})

test('empty flag yields nothing', () => {
  assert.deepEqual(parseClosesFlag(undefined), [])
  assert.deepEqual(parseClosesFlag(''), [])
})

test('a malformed --closes throws rather than silently closing nothing', () => {
  assert.throws(() => parseClosesFlag('eighty-two'), /not an issue reference/)
  assert.throws(() => parseClosesFlag('82,oops'), /not an issue reference/)
})

// --- withClosingTrailers ---------------------------------------------------

test('lifts a PR-body keyword into the commit message', () => {
  const { message, added } = withClosingTrailers({
    message: 'feat(tracks): move track-authoring geometry into @sektorapp/tracks',
    prBody: 'Stacked on #400.\n\nCloses #82.\n\nTrack-authoring geometry lived in one place.',
  })
  assert.deepEqual(added, ['#82'])
  assert.equal(
    message,
    'feat(tracks): move track-authoring geometry into @sektorapp/tracks\n\nCloses #82.',
  )
})

test('the headline is untouched, so git log --oneline stays readable', () => {
  const { message } = withClosingTrailers({ message: 'fix: a thing', prBody: 'Closes #1.' })
  assert.equal(message.split('\n')[0], 'fix: a thing')
})

test('a ref already in the commit message is not repeated', () => {
  const { message, added } = withClosingTrailers({
    message: 'feat: session client metadata\n\nCloses #344.',
    prBody: 'Closes #344.',
  })
  assert.deepEqual(added, [])
  assert.equal(message, 'feat: session client metadata\n\nCloses #344.')
})

test('--closes and the PR body combine without duplicating', () => {
  const { message, added } = withClosingTrailers({
    message: 'fix: two at once',
    prBody: 'Closes #350.',
    closes: '350,351',
  })
  assert.deepEqual(added, ['#350', '#351'])
  assert.equal(message, 'fix: two at once\n\nCloses #350.\nCloses #351.')
})

test('--closes works with no PR body at all (commit-only publish)', () => {
  const { message, added } = withClosingTrailers({ message: 'chore: tidy', closes: '#7' })
  assert.deepEqual(added, ['#7'])
  assert.equal(message, 'chore: tidy\n\nCloses #7.')
})

test('nothing to lift leaves the message byte-identical', () => {
  const original = 'docs: explain the thing\n\nSome body text.'
  const { message, added } = withClosingTrailers({ message: original, prBody: 'See #5.' })
  assert.deepEqual(added, [])
  assert.equal(message, original)
})

test('trailing whitespace in the message does not produce a ragged gap', () => {
  const { message } = withClosingTrailers({ message: 'fix: a thing\n\n', prBody: 'Closes #1.' })
  assert.equal(message, 'fix: a thing\n\nCloses #1.')
})

test('a cross-repo ref survives the round trip into the trailer', () => {
  const { message, added } = withClosingTrailers({
    message: 'chore: cross-repo',
    prBody: 'Closes sektorapp/wiki#48.',
  })
  assert.deepEqual(added, ['sektorapp/wiki#48'])
  assert.equal(message, 'chore: cross-repo\n\nCloses sektorapp/wiki#48.')
})

test('the real PR #403 body lifts exactly the issue it claims', () => {
  // Verbatim shape from the open PR, including the "Note #383" mention that
  // must NOT be lifted and the #401/#334/#362 references that are context.
  const prBody = [
    '> **Stacked on #401** (`agent/mobile-recording-track-picker`) — same app, and the',
    '> required check is strict. GitHub retargets this to `develop` when #401 merges.',
    '> Note #383: a stacked PR gets no CI run until its base lands.',
    '',
    'Closes #196.',
    '',
    'Mobile had **no `PATCH` against tracks anywhere**. See #334 and #362 for context.',
  ].join('\n')
  const { added } = withClosingTrailers({
    message: 'feat(mobile): edit metadata on tracks you own',
    prBody,
  })
  assert.deepEqual(added, ['#196'])
})

// --- partitionBodyRefs: quotation is not intent -----------------------------
//
// #1097. A PR body that DISCUSSES another ticket must not close it. The three
// shapes below are the ones a reader understands as quoting rather than doing.

test('a keyword inside a code span is quoted, not intent', () => {
  const { lift, quoted } = partitionBodyRefs(
    'The previous commit said `Closes #1045`, which was the half.',
  )
  assert.deepEqual(lift, [])
  assert.deepEqual(quoted, ['#1045'])
})

test('a multi-backtick code span hides a keyword just as well', () => {
  // The spelling you need when the span itself contains a backtick.
  const { lift, quoted } = partitionBodyRefs('It wrote ``Closes #1045`` verbatim.')
  assert.deepEqual(lift, [])
  assert.deepEqual(quoted, ['#1045'])
})

test('a keyword inside a fenced block is quoted, not intent', () => {
  const body = [
    'Here is what the commit carried:',
    '',
    '```',
    'Closes #1090.',
    'Closes #1045.',
    '```',
    '',
    'That is the bug.',
  ].join('\n')
  const { lift, quoted } = partitionBodyRefs(body)
  assert.deepEqual(lift, [])
  assert.deepEqual(quoted, ['#1090', '#1045'])
})

test('tilde fences and indented fences count too', () => {
  const tilde = ['~~~', 'Fixes #7', '~~~'].join('\n')
  assert.deepEqual(partitionBodyRefs(tilde).lift, [])
  const indented = ['   ```text', '   Resolves #8', '   ```'].join('\n')
  assert.deepEqual(partitionBodyRefs(indented).lift, [])
})

test('an unterminated fence masks the rest of the body', () => {
  // CommonMark: an unclosed fence runs to the end of the document. Erring
  // toward masking is the safe direction — a missed lift is now printed.
  const body = ['```', 'Closes #9', '', 'Closes #10'].join('\n')
  assert.deepEqual(partitionBodyRefs(body).lift, [])
  assert.deepEqual(partitionBodyRefs(body).quoted, ['#9', '#10'])
})

test('a keyword inside a blockquote is quoted, not intent', () => {
  const body = [
    '> The commit message read:',
    '> Closes #1045.',
    '',
    'Which is what this PR is about.',
  ].join('\n')
  const { lift, quoted } = partitionBodyRefs(body)
  assert.deepEqual(lift, [])
  assert.deepEqual(quoted, ['#1045'])
})

test('a keyword in plain prose is still lifted', () => {
  const { lift, quoted } = partitionBodyRefs('Closes #82.')
  assert.deepEqual(lift, ['#82'])
  assert.deepEqual(quoted, [])
})

test('prose around a quoted keyword still lifts its own', () => {
  const body =
    'Closes #1090.\n\nThe earlier commit already said `Closes #1045`, so this is the remainder.'
  const { lift, quoted } = partitionBodyRefs(body)
  assert.deepEqual(lift, ['#1090'])
  assert.deepEqual(quoted, ['#1045'])
})

test('a code span does not swallow the prose that follows it', () => {
  const { lift } = partitionBodyRefs('Run `pnpm run ci` first. Closes #82.')
  assert.deepEqual(lift, ['#82'])
})

test('an unpaired backtick is not a code span', () => {
  // A lone backtick opens nothing in CommonMark, so the keyword is real prose.
  assert.deepEqual(partitionBodyRefs('A stray ` and then Closes #82.').lift, ['#82'])
})

test('a stray backtick does not pair with a code span in a later paragraph', () => {
  // A code span may not contain a blank line, so the ` in the first paragraph
  // has no partner and the keyword between them is prose. Without the
  // paragraph rule the whole middle is masked and #82 is silently dropped.
  const body = 'A stray ` here.\n\nCloses #82.\n\nAnd `code` after.'
  assert.deepEqual(partitionBodyRefs(body).lift, ['#82'])
})

// --- masking must never MANUFACTURE a reference -----------------------------
//
// The mask blanks text the closing regex would otherwise read. If it blanks
// with whitespace, the regex's `\s+` reads straight through it and binds a
// dangling keyword to the next `#N` in the document — a ref that appears
// nowhere in the source, landing in `lift` and therefore never printed. That
// is strictly worse than #1097 itself.

test('a keyword before a fence does not bind to a number after it', () => {
  const body = [
    'What this fixes:',
    '',
    '```',
    'a stack trace',
    '```',
    '',
    '#82 is the tracking issue.',
  ].join('\n')
  assert.deepEqual(parseClosingRefs(body), [])
  assert.deepEqual(partitionBodyRefs(body), { lift: [], quoted: [] })
})

test('a keyword before a blockquote does not bind to a number after it', () => {
  const body =
    'Here is what the commit said it closes:\n\n> Closes #1045.\n\n#900 is the real target.'
  assert.deepEqual(partitionBodyRefs(body).lift, [])
  assert.deepEqual(partitionBodyRefs(body).quoted, ['#1045'])
})

test('a keyword before a code span does not bind past it', () => {
  const body = 'This fixes `the parser` #82 in passing.'
  assert.deepEqual(parseClosingRefs(body), [])
  assert.deepEqual(partitionBodyRefs(body).lift, [])
})

test('nothing is ever lifted that the raw body did not say', () => {
  // The invariant behind all three cases above, asserted over every fixture in
  // this file so a future masking change cannot quietly break it.
  const bodies = [
    'Closes #82.',
    'Quoted: `Closes #1045`.\n\n#900 next.',
    ['Fixes:', '', '~~~', 'x', '~~~', '', '#7 is tracked.'].join('\n'),
    '> Closes #5.\n\n#6 is separate.',
    'Resolves\n\n> quoted\n\n#9.',
  ]
  for (const body of bodies) {
    const raw = new Set(parseClosingRefs(body).map((r) => r.toLowerCase()))
    for (const ref of partitionBodyRefs(body).lift) {
      assert.ok(
        raw.has(ref.toLowerCase()),
        `lifted ${ref} which the raw body never said (${JSON.stringify(body)})`,
      )
    }
  }
})

// --- offsets are UTF-16, and PR bodies here carry emoji by convention -------

test('an astral character before a code span does not shift the mask', () => {
  // Every agent PR body ends with a mandated 🤖 footer, so this is the common
  // case, not an exotic one. A code-point-array mask drifts one position per
  // astral char — in one direction it lifts a quoted keyword, in the other it
  // drops a real one.
  const quoted = `${'🤖'.repeat(14)} The commit said \`Closes #1045\`, which was the half.`
  assert.deepEqual(partitionBodyRefs(quoted), { lift: [], quoted: ['#1045'] })

  const real = '🚀🚀🚀🚀 Run `pnpm run ci` first. Closes #82.'
  assert.deepEqual(partitionBodyRefs(real), { lift: ['#82'], quoted: [] })
})

test('the mandated agent footer does not disturb a body it follows', () => {
  const body = [
    'Closes #82.',
    '',
    'The earlier commit already said `Closes #1045`.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n')
  assert.deepEqual(partitionBodyRefs(body), { lift: ['#82'], quoted: ['#1045'] })
})

test('a ref that appears both quoted and in prose is lifted, not skipped', () => {
  // The partition is disjoint: `quoted` is what was found ONLY in a quoting
  // context, so a ref the author also asserted in prose is not reported lost.
  const body = 'The old commit said `Closes #82`. This one really does: Closes #82.'
  const { lift, quoted } = partitionBodyRefs(body)
  assert.deepEqual(lift, ['#82'])
  assert.deepEqual(quoted, [])
})

test('empty and missing bodies partition into nothing', () => {
  assert.deepEqual(partitionBodyRefs(undefined), { lift: [], quoted: [] })
  assert.deepEqual(partitionBodyRefs(''), { lift: [], quoted: [] })
})

// --- withClosingTrailers: skipped is reported, --closes always wins ---------

test('a backticked keyword is not lifted, and is reported as skipped', () => {
  const { message, added, skipped } = withClosingTrailers({
    message: 'fix(tooling): the lifter',
    prBody: 'The commit said `Closes #1045`.',
  })
  assert.deepEqual(added, [])
  assert.deepEqual(skipped, ['#1045'])
  assert.equal(message, 'fix(tooling): the lifter')
})

test('--closes wins even when the body only quotes a different keyword', () => {
  const { message, added, skipped } = withClosingTrailers({
    message: 'fix(tooling): the lifter',
    prBody: 'The commit said `Closes #1045`.',
    closes: '1097',
  })
  assert.deepEqual(added, ['#1097'])
  assert.deepEqual(skipped, ['#1045'])
  assert.equal(message, 'fix(tooling): the lifter\n\nCloses #1097.')
})

test('--closes wins over a body that quotes the same ref, and nothing is skipped', () => {
  const { added, skipped } = withClosingTrailers({
    message: 'fix: a thing',
    prBody: 'Earlier: `Closes #82`.',
    closes: '82',
  })
  assert.deepEqual(added, ['#82'])
  assert.deepEqual(skipped, [])
})

test('a quoted ref already in the commit message is not reported as skipped', () => {
  const { added, skipped } = withClosingTrailers({
    message: 'fix: a thing\n\nCloses #82.',
    prBody: 'Earlier: `Closes #82`.',
  })
  assert.deepEqual(added, [])
  assert.deepEqual(skipped, [])
})

test('skipped is empty when there is nothing quoted', () => {
  const { added, skipped } = withClosingTrailers({ message: 'fix: a thing', prBody: 'Closes #1.' })
  assert.deepEqual(added, ['#1'])
  assert.deepEqual(skipped, [])
})

test('the PR #1096 body no longer closes #1045', () => {
  // The observed defect, verbatim in shape: #1045 was quoted as a report of
  // what an earlier commit carried, and the lifter closed it anyway.
  const prBody = [
    'Closes #1090.',
    '',
    '#1045 half-landed: its commit carried `Closes #1045` while only part of the',
    'scope shipped. This PR is the remainder.',
  ].join('\n')
  const { added, skipped } = withClosingTrailers({
    message: 'feat(admin): the remainder of #1045',
    prBody,
  })
  assert.deepEqual(added, ['#1090'])
  assert.deepEqual(skipped, ['#1045'])
})
