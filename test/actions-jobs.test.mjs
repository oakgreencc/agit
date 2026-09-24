// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failedSteps, jobLines, runIdFrom, runLine } from '../src/actions-jobs.mjs'

test('runIdFrom: a bare id, a run URL, a job URL under the run — anything else is null', () => {
  assert.equal(runIdFrom('35161982423'), '35161982423')
  assert.equal(
    runIdFrom('https://github.com/sektorapp/monorepo/actions/runs/35161982423'),
    '35161982423',
  )
  assert.equal(
    runIdFrom('https://github.com/sektorapp/monorepo/actions/runs/35161982423/job/105014586295'),
    '35161982423',
  )
  assert.equal(runIdFrom('https://github.com/sektorapp/monorepo/pull/1535'), null)
  assert.equal(runIdFrom('abc'), null)
})

const failed = {
  id: 105014586295,
  name: 'Native build',
  status: 'completed',
  conclusion: 'failure',
  steps: [
    { name: 'Set up job', conclusion: 'success' },
    { name: 'Build (and distribute) via Nx', conclusion: 'failure' },
    { name: 'Upload artifacts', conclusion: 'skipped' },
  ],
}
const passed = { id: 1, name: 'lint', status: 'completed', conclusion: 'success', steps: [] }
const running = { id: 2, name: 'test', status: 'in_progress', conclusion: null }

test('failedSteps: only the failed ones, in order; a job that died outside its steps has none', () => {
  assert.deepEqual(failedSteps(failed), ['Build (and distribute) via Nx'])
  assert.deepEqual(failedSteps({ ...failed, steps: undefined }), [])
})

test('jobLines: failed jobs first, steps beneath them, log path when one was written', () => {
  assert.deepEqual(
    jobLines([passed, running, failed], { 105014586295: '/tmp/x/105014586295.log' }),
    [
      'FAIL\t105014586295\tNative build',
      '\tstep: Build (and distribute) via Nx',
      '\tlog: /tmp/x/105014586295.log',
      'pass\t1\tlint',
      'in_progress\t2\ttest',
    ],
  )
})

test('runLine names the run, its outcome, where it ran and the page to open', () => {
  assert.equal(
    runLine({
      id: 35161982423,
      name: 'Native build',
      status: 'completed',
      conclusion: 'failure',
      head_branch: 'main',
      event: 'workflow_dispatch',
      html_url: 'https://github.com/sektorapp/monorepo/actions/runs/35161982423',
    }),
    'run 35161982423: Native build — completed/failure — main (workflow_dispatch) — https://github.com/sektorapp/monorepo/actions/runs/35161982423',
  )
})
