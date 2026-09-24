// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decidingRule, findCodeowners, ownersOf, parseCodeowners, patternToRegExp } from '../src/codeowners.mjs'
import { createPolicy, normalise } from '../src/protected.mjs'

const owners = (text, path, only) => ownersOf(parseCodeowners(text), path, only)

test('patterns follow GitHub: anchoring, depth, directories', () => {
  /** @type {[string, string, boolean][]} */
  const cases = [
    ['*.js', 'a.js', true],
    ['*.js', 'deep/in/tree/a.js', true],
    ['*.js', 'a.ts', false],
    ['/build/logs/', 'build/logs/x.txt', true],
    ['/build/logs/', 'build/logs', false], // a directory pattern never matches a file
    ['/build/logs/', 'src/build/logs/x.txt', false],
    ['apps/', 'apps/x.ts', true],
    ['apps/', 'deep/apps/x.ts', true], // trailing-slash-only: any depth
    ['/docs/', 'docs/a/b.md', true],
    ['/docs/', 'x/docs/a.md', false],
    ['docs/*', 'docs/a.md', true],
    ['docs/*', 'docs/sub/b.md', false], // a trailing `*` is not recursive
    ['docs/*', 'x/docs/a.md', false], // an inner slash anchors
    ['**/logs', 'a/b/logs/x', true],
    ['**/logs', 'logs/x', true],
    ['/scripts/**', 'scripts/a/b.sh', true],
    ['README.md', 'README.md', true],
    ['README.md', 'pkg/README.md', true],
    ['/README.md', 'pkg/README.md', false],
    ['src/a?.js', 'src/ab.js', true],
    ['src/a?.js', 'src/a/b.js', false],
    ['foo', 'foo/bar.txt', true], // a name that is a directory owns its contents
    ['*', 'anything/at/all', true],
  ]
  for (const [pattern, path, want] of cases) {
    assert.equal(patternToRegExp(pattern)?.test(path), want, `${pattern} vs ${path}`)
  }
})

test('unsupported syntax matches nothing and is reported', () => {
  assert.equal(patternToRegExp('!keep.js'), null)
  assert.equal(patternToRegExp('src/[ab].js'), null)
  const rules = parseCodeowners('!x @a\n/ok @b\n')
  assert.equal(rules[0].unsupported?.includes('line 1'), true)
  assert.equal(rules[1].unsupported, undefined)
})

test('the LAST matching line wins, and a line with no owners un-owns', () => {
  const text = '*       @everyone\n/docs/ @docs-team\n/docs/public/\n'
  assert.deepEqual(owners(text, 'src/a.ts'), ['@everyone'])
  assert.deepEqual(owners(text, 'docs/guide.md'), ['@docs-team'])
  assert.deepEqual(owners(text, 'docs/public/index.md'), [])
  assert.equal(decidingRule(parseCodeowners(text), 'docs/public/x')?.line, 3)
})

test('comments, blank lines, trailing comments, escaped #, emails', () => {
  const text = '# header\n\n/a/ @x # trailing\n\\#weird @y\n/b/ dev@example.com\n'
  assert.deepEqual(owners(text, 'a/f'), ['@x'])
  assert.deepEqual(owners(text, '#weird'), ['@y'])
  assert.deepEqual(owners(text, 'b/f'), ['dev@example.com'])
})

test('the owners filter narrows which lines count', () => {
  const text = '/ci/ @alice @bots\n/docs/ @bots\n'
  assert.deepEqual(owners(text, 'ci/x', ['@Alice']), ['@alice'])
  assert.deepEqual(owners(text, 'docs/x', ['@alice']), [])
})

test('findCodeowners takes GitHub’s first location that exists', () => {
  const files = { 'CODEOWNERS': 'root', 'docs/CODEOWNERS': 'docs' }
  assert.deepEqual(findCodeowners((p) => files[p] ?? null), { path: 'CODEOWNERS', text: 'root' })
  assert.deepEqual(findCodeowners(() => { throw new Error('absent') }), { path: null, text: '' })
})

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

const CO = { path: '.github/CODEOWNERS', text: '/ci/ @alice\n/ci/scratch/\n' }

test('policy tiers: impossible beats owned; owned; extra; self-protected; ordinary', () => {
  const config = /** @type {any} */ ({
    protected: { codeowners: true, owners: [], extra: ['/legal/**'], impossible: ['.github/workflows/**'] },
  })
  const p = createPolicy({ config, codeowners: CO })
  assert.equal(p.check('.github/workflows/ci.yml')?.tier, 'impossible')
  assert.equal(p.check('ci/run.mjs')?.tier, 'protected')
  assert.match(p.check('ci/run.mjs')?.why ?? '', /owned by @alice in \.github\/CODEOWNERS/)
  assert.equal(p.check('ci/scratch/tmp.txt'), null) // un-owned by a later line
  assert.match(p.check('legal/privacy.md')?.why ?? '', /protected\.extra/)
  for (const self of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.agit.json', '.claude/settings.json'])
    assert.equal(p.check(self)?.tier, 'protected', self)
  assert.equal(p.check('src/app.ts'), null)
  assert.equal(p.check('pkg/.agit.json'), null) // self-protection is root-anchored
})

test('codeowners: false ignores CODEOWNERS but keeps extra and self-protection', () => {
  const config = /** @type {any} */ ({ protected: { codeowners: false, owners: [], extra: [], impossible: [] } })
  const p = createPolicy({ config, codeowners: CO })
  assert.equal(p.check('ci/run.mjs'), null)
  assert.equal(p.check('.agit.json')?.tier, 'protected')
})

test('checkAll dedupes after normalising, and keeps order', () => {
  const p = createPolicy({ codeowners: CO })
  const hits = p.checkAll(['src/a', 'ci/b', './ci/b', 'docs/../ci/c', '.agit.json'])
  assert.deepEqual(hits.map((h) => h.path), ['ci/b', 'ci/c', '.agit.json'])
})

test('normalise: dots collapse, a path climbing out is empty', () => {
  assert.equal(normalise('./a//b/../c'), 'a/c')
  assert.equal(normalise('a\\b'), 'a/b')
  assert.equal(normalise('../outside'), '')
  assert.equal(normalise('a/../../x'), '')
  assert.equal(createPolicy({ codeowners: CO }).check('../ci/x'), null)
})
