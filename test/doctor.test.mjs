// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  codeownersFindings,
  nodeFinding,
  permissionFindings,
  processFindings,
  render,
  rulesFindings,
} from '../src/setup/doctor.mjs'
import {
  githubChecklist,
  lineDiff,
  missingCodeownersLines,
  newCodeowners,
} from '../src/setup/project.mjs'

const levels = (fs) => fs.map((f) => f.level)

test('nodeFinding: 22 passes, 20 fails', () => {
  assert.equal(nodeFinding('22.1.0').level, 'ok')
  assert.equal(nodeFinding('20.9.0').level, 'fail')
})

test('permissionFindings: write path required; withheld permissions warned', () => {
  assert.deepEqual(levels(permissionFindings({ contents: 'write', pull_requests: 'write' })), ['ok', 'ok', 'ok'])
  const bad = permissionFindings({ contents: 'read', pull_requests: 'write', workflows: 'write', administration: 'read' })
  assert.deepEqual(levels(bad), ['fail', 'ok', 'warn', 'warn'])
  assert.match(render(bad), /✗ App permission contents: read/)
})

test('rulesFindings: code owner review, signatures, force pushes, status checks', () => {
  const none = rulesFindings([], 'main')
  assert.deepEqual(levels(none), ['warn', 'warn', 'warn', 'warn'])
  assert.match(render(none), /Run: agit setup project/)
  const good = [
    { type: 'pull_request', parameters: { require_code_owner_review: true } },
    { type: 'required_signatures' },
    { type: 'non_fast_forward' },
    { type: 'required_status_checks', parameters: {} },
  ]
  assert.deepEqual(levels(rulesFindings(good, 'main')), ['ok', 'ok', 'ok', 'ok'])
  const noOwners = rulesFindings([{ type: 'pull_request', parameters: { require_code_owner_review: false } }], 'main')
  assert.match(noOwners[0].label, /code owner review not required/)
})

test('codeownersFindings: missing file fails; unowned self-protected paths warn', () => {
  assert.equal(codeownersFindings({ path: null, text: '' })[0].level, 'fail')
  const partial = codeownersFindings({ path: '.github/CODEOWNERS', text: '/.github/CODEOWNERS @me\n' })
  assert.deepEqual(
    partial.filter((f) => f.level === 'warn').map((f) => f.label),
    ['CODEOWNERS does not own .agit.json', 'CODEOWNERS does not own .claude/settings.json'],
  )
  const full = codeownersFindings({
    path: 'CODEOWNERS',
    text: '/CODEOWNERS @me\n/.agit.json @me\n/.claude/ @me\n',
  })
  assert.deepEqual(levels(full), ['ok'])
})

test('processFindings: in a Claude Code session, the session verdict; in a human shell, one ok line', () => {
  const ssh = { url: 'git@github.com:o/r.git', helpers: [], processEnv: {}, settingsEnv: null }
  const inSession = processFindings({ ...ssh, claude: true })
  assert.deepEqual(levels(inSession), ['fail'])
  assert.match(inSession[0].label, /^this session: raw `git fetch` goes over SSH/)
  const human = processFindings({ ...ssh, claude: false })
  assert.deepEqual(levels(human), ['ok'])
  assert.match(human[0].label, /not a Claude Code session/)
  assert.match(human[0].label, /SSH/)
})

test('missingCodeownersLines: only what is not already owned, hooks dir included', () => {
  const lines = missingCodeownersLines({
    text: '/.agit.json @me\n',
    codeownersPath: '.github/CODEOWNERS',
    hooksDir: '.githooks',
    owner: '@me',
  })
  assert.deepEqual(lines, ['/.github/CODEOWNERS  @me', '/.claude/settings.json  @me', '/.githooks/  @me'])
  // A later un-owning line means the path is NOT owned: last match wins.
  const unowned = missingCodeownersLines({
    text: '* @me\n/.agit.json\n',
    codeownersPath: 'CODEOWNERS',
    hooksDir: null,
    owner: '@me',
  })
  assert.deepEqual(unowned, ['/.agit.json  @me'])
  assert.match(newCodeowners(lines), /^# Paths a human must approve/)
})

test('lineDiff and the checklist', () => {
  assert.deepEqual(lineDiff('a\nb\n', 'a\nc\n'), ['- b', '+ c'])
  assert.deepEqual(lineDiff(null, 'x\n'), ['+ x'])
  const c = githubChecklist({ owner: 'o', repo: 'r', requiredCheck: 'ci', slug: 's' })
  assert.match(c, /https:\/\/github.com\/o\/r\/settings\/rules/)
  assert.doesNotMatch(c, /Require review from Code Owners/, 'setup applies the base ruleset; the checklist is only what is optional')
  assert.doesNotMatch(c, /--required-check/)
  assert.match(c, /apps\/s\/installations\/new/)
  assert.match(githubChecklist({ owner: 'o', repo: 'r', requiredCheck: null, slug: null }), /--required-check <job>/)
})
