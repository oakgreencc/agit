// @ts-check
/**
 * The verbs `agit` runs, and the actions each noun-grouped verb takes. Its own
 * module because the bin executes on import; the verb-drift test reads it too.
 */

/** verb → module exporting `run(argv)`. Imported lazily: the credential helper must start fast. */
export const VERBS = {
  publish: () => import('./publish.mjs').then((m) => m.runPublish),
  merge: () => import('./publish.mjs').then((m) => m.runMerge),
  advance: () => import('./publish.mjs').then((m) => m.runAdvance),
  api: () => import('./api.mjs').then((m) => m.runApi),
  graphql: () => import('./api.mjs').then((m) => m.runGraphql),
  jobs: () => import('./api.mjs').then((m) => m.runJobs),
  status: () => import('./status.mjs').then((m) => m.run),
  credential: () => import('./credential.mjs').then((m) => m.run),
  validate: () => import('./validate.mjs').then((m) => m.run),
  protected: () => import('./protected.mjs').then((m) => m.run),
  maintainer: () => import('./maintainer.mjs').then((m) => m.run),
  pr: () => import('./pr.mjs').then((m) => m.run),
  issue: () => import('./issue.mjs').then((m) => m.run),
  ci: () => import('./ci.mjs').then((m) => m.run),
  hook: () => import('../hooks/index.mjs').then((m) => m.run),
  setup: () => import('../setup/index.mjs').then((m) => m.run),
  doctor: () => import('../setup/doctor.mjs').then((m) => m.run),
}

/**
 * noun → the actions it takes. `hook` is absent on purpose: its names are
 * `HOOKS` in src/hooks/index.mjs, which the drift test reads directly.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SUBVERBS = Object.freeze({
  pr: ['merge', 'update'],
  issue: ['read', 'create', 'comment', 'close', 'edit', 'assign', 'label'],
  ci: ['wait'],
  maintainer: ['status', 'grant', 'on', 'revoke', 'off'],
  setup: ['app', 'project'],
  credential: ['get'],
})
