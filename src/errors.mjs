// @ts-check
/**
 * The one error class every layer shares. Its own module so that raising a
 * refusal never means importing the publish primitive — `bin/agit.mjs` loads
 * verbs lazily so the credential helper starts fast, and a top-level import of
 * the publish path for one class undid that.
 */

/** A refusal the CLI prints as-is, distinct from a crash. */
export class PublishError extends Error {}
