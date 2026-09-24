// @ts-check
/**
 * The GitHub App agit creates for a human, as a manifest — pure.
 *
 * GitHub's App Manifest flow takes this JSON in a form POST, shows the human a
 * pre-filled "Create GitHub App" page, and hands back a one-time code that
 * converts into the App's id and private key. The human clicks once; nobody
 * copies a PEM around by hand.
 *
 * ---------------------------------------------------------------------------
 * THE PERMISSIONS ARE THE HARD FLOOR.
 *
 * Everything agit enforces locally — hooks, gates, maintainer mode — is a
 * tripwire an agent with a shell could step over. What it cannot step over is
 * a permission the App does not hold. So the manifest grants exactly what the
 * write path needs and deliberately withholds three:
 *
 *   workflows        a push touching `.github/workflows/**` is refused by
 *                    GitHub (422). CI is what judges the agent's work; an
 *                    agent that could edit CI could make itself green.
 *   administration   rulesets, branch protection, CODEOWNERS enforcement and
 *                    the required checks live behind it. The App must not be
 *                    able to loosen the rules it is held to.
 *   secrets          nothing an agent does needs to read or write them.
 *
 * `agit doctor` warns if an installed App holds any of these anyway.
 */

/** The permissions an agit App holds. Nothing else. */
export const APP_PERMISSIONS = Object.freeze({
  contents: 'write', // Git Database API: blobs, trees, commits, refs
  pull_requests: 'write', // open, update, merge
  issues: 'write', // comments, closing refs, labels
  metadata: 'read', // mandatory; also branch rules (`/rules/branches/<b>`)
  actions: 'read', // `agit jobs`: run and job logs
  checks: 'read', // stop-the-line: the required check on a PR head
  statuses: 'read', // commit statuses, for the same question
})

/** Permissions an agit App must never hold. See the header. */
export const WITHHELD_PERMISSIONS = Object.freeze(['workflows', 'administration', 'secrets'])

/**
 * @param {{ name: string, owner: string, ownerType?: 'user' | 'org', redirectUrl: string, projects?: boolean }} input
 */
export function appManifest({ name, owner, ownerType = 'user', redirectUrl, projects = false }) {
  if (!name) throw new Error('an App needs a name (GitHub requires it to be globally unique)')
  if (!owner) throw new Error('an App needs an owner')
  /** @type {Record<string, string>} */
  const default_permissions = { ...APP_PERMISSIONS }
  // Projects v2 has no REST surface; org Projects are GraphQL-only and need
  // this. A user account has no organization projects to grant.
  if (ownerType === 'org' && projects) default_permissions.organization_projects = 'write'
  return {
    name,
    url: `https://github.com/${owner}`,
    // agit needs no webhooks. GitHub requires the block to exist; inactive
    // means it never delivers.
    hook_attributes: { url: 'https://example.invalid/agit-no-webhooks', active: false },
    redirect_url: redirectUrl,
    public: false,
    default_permissions,
    default_events: [],
  }
}

/**
 * Where the manifest form is POSTed.
 *
 * @param {{ owner: string, ownerType?: 'user' | 'org', state: string }} input
 */
export function newAppUrl({ owner, ownerType = 'user', state }) {
  const base =
    ownerType === 'org'
      ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
      : 'https://github.com/settings/apps/new'
  return `${base}?state=${encodeURIComponent(state)}`
}

/** Where the human installs an App on their repositories. */
export const installUrl = (slug) => `https://github.com/apps/${slug}/installations/new`
