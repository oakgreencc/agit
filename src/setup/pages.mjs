// @ts-check
/**
 * The few HTML pages `agit setup app` serves on 127.0.0.1 — pure.
 *
 * A local page that POSTs to GitHub is exactly what a phishing page looks
 * like, so each one says who is serving it, what is about to happen, and what
 * the App will and will not be able to do. Everything is inline: the server
 * lives for one setup, offline, and fetches nothing.
 */

import { APP_PERMISSIONS, WITHHELD_PERMISSIONS } from './manifest.mjs'

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** What each permission lets the App do, in the human's words. */
const PERMISSION_LABELS = {
  contents: 'Create commits and branches',
  pull_requests: 'Open, update and merge pull requests',
  issues: 'Comment on, label and close issues',
  metadata: 'See repository metadata and branch rules',
  actions: 'Read workflow run and job logs',
  checks: 'Read check results',
  statuses: 'Read commit statuses',
  organization_projects: 'Update organization projects',
}

/** Why each withheld permission stays withheld. Mirrors manifest.mjs. */
const WITHHELD_REASONS = {
  workflows: 'Change CI, so an agent can never make its own work pass',
  administration: 'Loosen branch rules, rulesets or CODEOWNERS enforcement',
  secrets: 'Read or write secrets',
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: oklch(98.4% 0.004 165);
  --surface: oklch(100% 0 0);
  --ink: oklch(22% 0.015 200);
  --muted: oklch(45% 0.015 200);
  --rule: oklch(90% 0.008 200);
  --accent: oklch(47% 0.1 165);
  --accent-ink: oklch(99% 0.01 165);
  --accent-soft: oklch(94% 0.035 165);
  --warn: oklch(48% 0.13 35);
  --warn-soft: oklch(95% 0.03 35);
  --focus: oklch(55% 0.14 240);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(17% 0.01 200);
    --surface: oklch(20.5% 0.012 200);
    --ink: oklch(94% 0.006 200);
    --muted: oklch(73% 0.012 200);
    --rule: oklch(30% 0.012 200);
    --accent: oklch(76% 0.12 165);
    --accent-ink: oklch(18% 0.03 165);
    --accent-soft: oklch(30% 0.05 165);
    --warn: oklch(78% 0.11 40);
    --warn-soft: oklch(30% 0.05 35);
    --focus: oklch(75% 0.12 240);
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 400 1rem/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  accent-color: var(--accent);
}
::selection { background: var(--accent-soft); color: var(--ink); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; border-radius: 4px; }
main {
  max-width: 36rem;
  margin: 0 auto;
  padding: clamp(2rem, 8vh, 5rem) 1rem 3rem;
}
.mast {
  display: flex; align-items: center; gap: .5rem;
  margin: 0 0 2.5rem;
  font: 500 .875rem/1 var(--mono);
  color: var(--muted);
}
.mast b { color: var(--ink); font-weight: 650; }
.mast svg { flex: none; }
h1 {
  margin: 0 0 .75rem;
  font-size: clamp(1.5rem, 1.2rem + 1.2vw, 1.875rem);
  line-height: 1.2;
  font-weight: 650;
  letter-spacing: -0.015em;
  text-wrap: balance;
}
h2 {
  margin: 2.25rem 0 .75rem;
  font-size: .9375rem;
  font-weight: 650;
}
p { margin: 0 0 1rem; max-width: 65ch; }
.lead { font-size: 1.0625rem; }
.lead b { font-weight: 600; }
.lead ~ p:not(.lead) { color: var(--muted); }
code, kbd {
  font-family: var(--mono);
  font-size: .875em;
  padding: .1em .35em;
  border-radius: 4px;
  background: color-mix(in oklch, var(--rule) 55%, transparent);
  overflow-wrap: anywhere;
}
h1 code { padding: 0; background: none; font-size: .9em; letter-spacing: -0.02em; }
a { color: var(--accent); text-underline-offset: .2em; }
.perms {
  list-style: none; margin: 0; padding: 0;
  border: 1px solid var(--rule);
  border-radius: 10px;
  background: var(--surface);
}
.perms li {
  display: flex; align-items: baseline; justify-content: space-between; gap: 1rem;
  padding: .7rem 1rem;
}
.perms li + li { border-top: 1px solid var(--rule); }
.tag {
  flex: none;
  font: 600 .75rem/1 var(--mono);
  padding: .3rem .45rem;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--ink);
}
.tag.read { background: transparent; box-shadow: inset 0 0 0 1px var(--rule); color: var(--muted); }
.tag.never { background: var(--warn-soft); color: var(--warn); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; margin: 2.25rem 0 0; }
button {
  font: 600 1rem/1 system-ui, sans-serif;
  min-height: 44px;
  padding: .8rem 1.25rem;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-ink);
  cursor: pointer;
  box-shadow: 0 1px 2px oklch(0% 0 0 / .12);
  transition: filter .15s ease-out;
}
button:hover { filter: brightness(1.08); }
button:active { filter: brightness(.95); }
.status { display: none; color: var(--muted); font-size: .9375rem; }
.sending .status { display: inline; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
.mark { display: block; margin: 0 0 1.25rem; color: var(--accent); }
.mark.warn { color: var(--warn); }
footer {
  margin-top: 3rem; padding-top: 1rem;
  border-top: 1px solid var(--rule);
  color: var(--muted);
  font-size: .8125rem;
}
`

const LOGO = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="5" cy="4" r="2"/><circle cx="5" cy="14" r="2"/><circle cx="13" cy="9" r="2"/><path d="M5 6v6M5 9c0-2 2-2.5 4-1.5"/></svg>`

const CHECK = `<svg class="mark" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="20" cy="20" r="18"/><path d="m12.5 20.5 5 5 10-11"/></svg>`

const ALERT = `<svg class="mark warn" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><circle cx="20" cy="20" r="18"/><path d="M20 11.5v11"/><circle cx="20" cy="28" r=".6" fill="currentColor"/></svg>`

/**
 * The frame every page shares.
 *
 * @param {{ title: string, body: string, footer?: string }} input
 */
export function page({ title, body, footer = 'Served by <code>agit setup app</code> on 127.0.0.1, for this setup only.' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · agit</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header class="mast">${LOGO}<span><b>agit</b> setup app</span></header>
${body}
<footer>${footer}</footer>
</main>
</body>
</html>
`
}

const permissionRow = (label, access) =>
  `<li><span>${escapeHtml(label)}</span><span class="tag ${access}">${access}</span></li>`

/**
 * The page that carries the manifest to GitHub. It submits itself once per
 * tab; coming Back from GitHub shows it with the button instead of bouncing
 * straight forward again.
 *
 * @param {{ action: string, manifest: { name?: string, default_permissions?: Record<string, string> }, owner?: string, ownerType?: 'user' | 'org', minutes?: number }} input
 */
export function manifestPage({ action, manifest, owner, ownerType, minutes }) {
  const name = manifest.name ?? 'your App'
  const perms = Object.entries(manifest.default_permissions ?? APP_PERMISSIONS)
  const sorted = [...perms.filter(([, a]) => a === 'write'), ...perms.filter(([, a]) => a !== 'write')]
  const who = owner
    ? ` for ${ownerType === 'org' ? 'the organization' : 'the account'} <b>${escapeHtml(owner)}</b>`
    : ''
  const body = `
<h1>Create <code>${escapeHtml(name)}</code> on GitHub</h1>
<p class="lead">GitHub will open a prefilled form for a new App${who}. Review it there, then click <b>Create GitHub App</b>. Nothing exists until you do.</p>

<h2>On the repositories you install it on, it can</h2>
<ul class="perms">${sorted.map(([p, a]) => permissionRow(PERMISSION_LABELS[p] ?? p.replaceAll('_', ' '), a)).join('')}</ul>

<h2>It can never</h2>
<ul class="perms">${WITHHELD_PERMISSIONS.map((p) => permissionRow(WITHHELD_REASONS[p] ?? p, 'never')).join('')}</ul>

<form id="f" class="actions" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
<span class="status" role="status">Opening GitHub…</span>
</form>
<script>
(function () {
  var f = document.getElementById('f'), key = 'agit-sent:' + f.action
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1') } catch (e) {}
  f.classList.add('sending')
  f.submit()
})()
</script>`
  const footer = `Served by <code>agit setup app</code> on 127.0.0.1, for this setup only${
    minutes ? `. It stops after ${minutes} minutes` : ''
  }. The App's key comes back to your terminal, never to this page.`
  return page({ title: `Create ${name}`, body, footer })
}

/**
 * Where GitHub lands after the App exists. The terminal still has the key to
 * fetch and the install to walk through.
 *
 * @param {{ name?: string }} [input]
 */
export function createdPage({ name } = {}) {
  const body = `
${CHECK}
<h1>GitHub created ${name ? `<code>${escapeHtml(name)}</code>` : 'the App'}</h1>
<p class="lead">Back in your terminal, agit saves the App's key and walks you through installing it on the repositories agents may work in. Only those.</p>
<p>You can close this tab. This page stops answering once setup moves on, so reloading it won't work.</p>`
  return page({ title: 'App created', body })
}

/** A callback that is not this run's: a stale tab, a reused link, or not GitHub at all. */
export function foreignCallbackPage() {
  const body = `
${ALERT}
<h1>This link belongs to a different setup</h1>
<p class="lead">It doesn't match the <code>agit setup app</code> running now. It may be from an older tab or a link that was already used.</p>
<p>Nothing was created or saved from it. To set up the App, run <code>agit setup app</code> again in your terminal and open the link it prints.</p>`
  return page({ title: 'Setup link not recognized', body })
}

/** Anything else on the port. */
export function notFoundPage() {
  const body = `
<h1>Nothing here</h1>
<p class="lead">This server only exists to hand an App manifest to GitHub during <code>agit setup app</code>. Use the link your terminal printed.</p>`
  return page({ title: 'Not found', body })
}
