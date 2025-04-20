#!/usr/bin/env node

/**
 * Generate Ghost site settings JSON for the eng.todie.io static mirror.
 *
 * Modes:
 *   --emit-settings   Print settings JSON to stdout (for CI curl-based apply)
 *   (default)         Apply settings directly via Ghost Admin API session auth
 *
 * Usage:
 *   node scripts/configure-ghost.mjs --emit-settings > /tmp/settings.json
 *   node scripts/configure-ghost.mjs                # local dev, needs Ghost running
 *
 * Env vars: GHOST_API_URL, GHOST_ADMIN_API_KEY, GHOST_ADMIN_EMAIL, GHOST_ADMIN_PASSWORD
 */

// ---------------------------------------------------------------------------
// Settings payload
// ---------------------------------------------------------------------------

const SETTINGS_PAYLOAD = {
  settings: [
    { key: "title", value: "todie.io/eng" },
    {
      key: "description",
      value:
        "Security research, systems engineering, and things that shouldn't work but do.",
    },
    { key: "accent_color", value: "#00ff88" },
    { key: "codeinjection_head", value: CUSTOM_HEAD_CSS() },
    { key: "codeinjection_foot", value: CUSTOM_FOOT_JS() },
  ],
};

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

if (process.argv.includes("--emit-settings")) {
  // Just dump the JSON — CI workflow will curl it into Ghost
  process.stdout.write(JSON.stringify(SETTINGS_PAYLOAD));
  process.exit(0);
}

// Default mode: apply settings + delete default content
// Dynamic imports so --emit-settings works without node_modules
const { createGhostToken } = await import("../lib/ghost.mjs");
const { execSync } = await import("node:child_process");
const { writeFileSync, unlinkSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const GHOST_API_URL = process.env.GHOST_API_URL || "http://localhost:2368";
const GHOST_ADMIN_API_KEY = process.env.GHOST_ADMIN_API_KEY;
const GHOST_ADMIN_EMAIL =
  process.env.GHOST_ADMIN_EMAIL || "admin@ghost.local";
const GHOST_ADMIN_PASSWORD =
  process.env.GHOST_ADMIN_PASSWORD || "Str0ngP@ssword123!";

if (!GHOST_ADMIN_API_KEY) {
  console.error("GHOST_ADMIN_API_KEY not set.");
  process.exit(1);
}

const token = createGhostToken(GHOST_ADMIN_API_KEY);
const jwtHeaders = {
  "Content-Type": "application/json",
  Authorization: `Ghost ${token}`,
};

// ---------------------------------------------------------------------------
// Delete default "Coming Soon" post
// ---------------------------------------------------------------------------

async function deleteDefaultContent() {
  const res = await fetch(
    `${GHOST_API_URL}/ghost/api/admin/posts/?limit=all`,
    { headers: jwtHeaders }
  );
  if (!res.ok) return;

  const data = await res.json();
  for (const post of data.posts) {
    if (post.slug === "coming-soon" || post.title === "Coming Soon") {
      const delRes = await fetch(
        `${GHOST_API_URL}/ghost/api/admin/posts/${post.id}/`,
        { method: "DELETE", headers: jwtHeaders }
      );
      if (delRes.ok) console.log(`Deleted default post: "${post.title}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Apply settings via session cookie + curl (local dev mode)
// ---------------------------------------------------------------------------

function applySettings() {
  // Get session cookie
  const credsTmp = join(tmpdir(), `ghost-creds-${Date.now()}.json`);
  writeFileSync(
    credsTmp,
    JSON.stringify({
      username: GHOST_ADMIN_EMAIL,
      password: GHOST_ADMIN_PASSWORD,
    })
  );

  let cookie;
  try {
    const raw = execSync(
      `curl -D - -o /dev/null -X POST ` +
        `"${GHOST_API_URL}/ghost/api/admin/session/" ` +
        `-H "Content-Type: application/json" ` +
        `-H "Origin: ${GHOST_API_URL}" ` +
        `-d @${credsTmp} 2>/dev/null`,
      { encoding: "utf-8" }
    );
    const m = raw.match(/ghost-admin-api-session=([^;\s]+)/);
    if (!m) throw new Error(`No session cookie in response:\n${raw}`);
    cookie = `ghost-admin-api-session=${m[1]}`;
    console.log("Session cookie obtained.");
  } finally {
    try {
      unlinkSync(credsTmp);
    } catch {
      /* ignore */
    }
  }

  // PUT settings
  const settingsTmp = join(tmpdir(), `ghost-settings-${Date.now()}.json`);
  writeFileSync(settingsTmp, JSON.stringify(SETTINGS_PAYLOAD));
  try {
    const result = execSync(
      `curl -s -w "\\n%{http_code}" -X PUT ` +
        `"${GHOST_API_URL}/ghost/api/admin/settings/" ` +
        `-H "Content-Type: application/json" ` +
        `-H "Cookie: ${cookie}" ` +
        `-H "Origin: ${GHOST_API_URL}" ` +
        `-d @${settingsTmp}`,
      { encoding: "utf-8" }
    );
    const lines = result.trimEnd().split("\n");
    const code = parseInt(lines.pop(), 10);
    if (code >= 400) {
      throw new Error(
        `Settings PUT ${code}: ${lines.join("\n").slice(0, 500)}`
      );
    }
    console.log("Site settings updated.");
  } finally {
    try {
      unlinkSync(settingsTmp);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    await deleteDefaultContent();
    applySettings();
    console.log("Ghost configuration complete.");
  } catch (err) {
    console.error("Configuration failed:", err.message);
    process.exit(1);
  }
}

main();

// ---------------------------------------------------------------------------
// Custom CSS — dark terminal aesthetic
// ---------------------------------------------------------------------------

function CUSTOM_HEAD_CSS() {
  return `
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap">
<style>
  /* ===== DARK THEME — eng.todie.io ===== */

  :root {
    --bg-primary: #0a0a0f;
    --bg-secondary: #12121a;
    --bg-tertiary: #1a1a2e;
    --text-primary: #e0e0e8;
    --text-secondary: #9090a0;
    --text-muted: #606070;
    --accent: #00ff88;
    --accent-dim: #00cc6a;
    --accent-glow: rgba(0, 255, 136, 0.15);
    --border: #2a2a3e;
    --code-bg: #0d0d14;
    --link: #00ff88;
    --link-hover: #33ffaa;
    --font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', monospace;
    --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  }

  /* Override Casper's default background */
  :root {
    --background-color: #0a0a0f !important;
    --ghost-accent-color: #00ff88 !important;
  }

  /* Kill Ghost's subscribe/sign-in/portal (dead on static) */
  .gh-head-actions,
  .gh-portal-triggerbtn-container,
  .pswp,
  [data-portal],
  .gh-subscribe-form,
  .footer-cta,
  .gh-navigation-actions,
  #ghost-portal-root,
  .gh-head-actions a[href="#/portal/signin"],
  .gh-head-actions a[href="#/portal/signup"],
  .gh-head-btn,
  iframe[title="portal-trigger"],
  .gh-signup,
  .gh-signup-cta,
  .gh-post-upgrade-cta {
    display: none !important;
  }

  /* === Base === */
  body {
    background: var(--bg-primary) !important;
    color: var(--text-primary) !important;
    font-family: var(--font-sans) !important;
    -webkit-font-smoothing: antialiased;
  }

  /* === Header === */
  .gh-head {
    background: var(--bg-primary) !important;
    border-bottom: 1px solid var(--border) !important;
  }
  .gh-head-logo,
  .gh-head-logo a {
    font-family: var(--font-mono) !important;
    color: var(--accent) !important;
    font-weight: 700 !important;
    font-size: 1.1rem !important;
    letter-spacing: -0.02em !important;
  }
  .gh-head-menu a {
    color: var(--text-secondary) !important;
    font-family: var(--font-mono) !important;
    font-size: 0.85rem !important;
    text-transform: lowercase !important;
    letter-spacing: 0.05em !important;
  }
  .gh-head-menu a:hover {
    color: var(--accent) !important;
  }

  /* === Hero / Cover === */
  .gh-canvas > .post-feed > .post-card:first-of-type,
  .gh-cover,
  .gh-header,
  section.outer > .inner {
    background: var(--bg-primary) !important;
  }
  .gh-header-inner {
    background: var(--bg-secondary) !important;
    border: 1px solid var(--border) !important;
    border-radius: 12px !important;
    padding: 3rem 2rem !important;
    margin: 2rem auto !important;
    max-width: 720px !important;
    text-align: left !important;
  }
  .gh-header-title,
  .gh-header-title.is-title,
  .site-header-content h1 {
    color: var(--accent) !important;
    font-family: var(--font-mono) !important;
    font-size: 1.6rem !important;
    font-weight: 700 !important;
  }
  .gh-header-description,
  .site-header-content p {
    color: var(--text-secondary) !important;
    font-family: var(--font-sans) !important;
    font-size: 1rem !important;
    max-width: 540px !important;
  }
  /* Override Casper light-text header on has-image sections */
  .gh-header.has-image .gh-header-title {
    color: var(--accent) !important;
    font-family: var(--font-mono) !important;
    font-size: 1.6rem !important;
    font-weight: 700 !important;
  }
  .gh-header {
    background: var(--bg-primary) !important;
    border-bottom: 1px solid var(--border) !important;
  }

  /* Kill the gradient cover / hero image */
  .site-header-cover,
  .outer.site-header-background,
  .gh-header.has-image {
    background: var(--bg-primary) !important;
    background-image: none !important;
  }
  .gh-header-image,
  .site-header-background::before {
    display: none !important;
  }
  .gh-header.has-image::before,
  .gh-header.has-image::after {
    display: none !important;
  }

  /* === Post cards === */
  .post-card {
    background: var(--bg-secondary) !important;
    border: 1px solid var(--border) !important;
    border-radius: 8px !important;
    padding: 1.5rem !important;
    margin-bottom: 1rem !important;
    transition: border-color 0.2s ease, box-shadow 0.2s ease !important;
  }
  .post-card:hover {
    border-color: var(--accent-dim) !important;
    box-shadow: 0 0 20px var(--accent-glow) !important;
  }
  .post-card-title {
    color: var(--text-primary) !important;
    font-family: var(--font-sans) !important;
    font-weight: 600 !important;
  }
  .post-card-excerpt {
    color: var(--text-secondary) !important;
  }
  .post-card-tags,
  .post-card-meta {
    color: var(--text-muted) !important;
    font-family: var(--font-mono) !important;
    font-size: 0.8rem !important;
  }
  .post-card-primary-tag {
    color: var(--accent) !important;
  }

  /* === Article === */
  .gh-content,
  .post-full-content,
  article {
    color: var(--text-primary) !important;
    font-family: var(--font-sans) !important;
  }
  .post-full-title,
  .article-title,
  .gh-article-title {
    color: var(--text-primary) !important;
    font-family: var(--font-sans) !important;
    font-weight: 700 !important;
  }

  /* Links */
  .gh-content a,
  .post-full-content a {
    color: var(--link) !important;
    text-decoration: underline !important;
    text-decoration-color: rgba(0, 255, 136, 0.3) !important;
    text-underline-offset: 3px !important;
    transition: text-decoration-color 0.2s ease !important;
  }
  .gh-content a:hover,
  .post-full-content a:hover {
    text-decoration-color: var(--link-hover) !important;
  }

  /* === Code blocks === */
  pre, code {
    font-family: var(--font-mono) !important;
  }
  code {
    background: var(--code-bg) !important;
    color: var(--accent) !important;
    padding: 0.15em 0.4em !important;
    border-radius: 4px !important;
    font-size: 0.9em !important;
  }
  pre {
    background: var(--code-bg) !important;
    border: 1px solid var(--border) !important;
    border-radius: 8px !important;
    padding: 1.2rem !important;
    overflow-x: auto !important;
    position: relative !important;
  }
  pre code {
    background: transparent !important;
    color: var(--text-primary) !important;
    padding: 0 !important;
    font-size: 0.85rem !important;
    line-height: 1.6 !important;
  }

  /* === Blockquotes === */
  blockquote {
    border-left: 3px solid var(--accent) !important;
    background: var(--bg-secondary) !important;
    padding: 1rem 1.5rem !important;
    border-radius: 0 8px 8px 0 !important;
    color: var(--text-secondary) !important;
    font-style: italic !important;
  }

  /* === Tables === */
  table {
    border-collapse: collapse !important;
    width: 100% !important;
  }
  th, td {
    border: 1px solid var(--border) !important;
    padding: 0.6rem 1rem !important;
    text-align: left !important;
  }
  th {
    background: var(--bg-tertiary) !important;
    color: var(--accent) !important;
    font-family: var(--font-mono) !important;
    font-size: 0.85rem !important;
    font-weight: 500 !important;
    text-transform: uppercase !important;
    letter-spacing: 0.05em !important;
  }
  td {
    background: var(--bg-secondary) !important;
    color: var(--text-primary) !important;
  }
  tr:hover td {
    background: var(--bg-tertiary) !important;
  }

  /* === Horizontal rules === */
  hr {
    border: none !important;
    border-top: 1px solid var(--border) !important;
    margin: 2rem 0 !important;
  }

  /* === Footer === */
  .site-footer,
  .gh-foot {
    background: var(--bg-primary) !important;
    border-top: 1px solid var(--border) !important;
    color: var(--text-muted) !important;
  }
  .site-footer a,
  .gh-foot a {
    color: var(--text-secondary) !important;
  }
  .site-footer a:hover,
  .gh-foot a:hover {
    color: var(--accent) !important;
  }

  /* === Labels / Tags === */
  .post-tag,
  .tag-label {
    background: var(--bg-tertiary) !important;
    color: var(--accent) !important;
    border: 1px solid var(--border) !important;
    border-radius: 4px !important;
    padding: 0.2em 0.6em !important;
    font-family: var(--font-mono) !important;
    font-size: 0.75rem !important;
  }

  /* === LATEST section header === */
  .post-feed-title {
    color: var(--text-muted) !important;
    font-family: var(--font-mono) !important;
    font-size: 0.8rem !important;
    text-transform: uppercase !important;
    letter-spacing: 0.15em !important;
  }

  /* === Scrollbar === */
  ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  ::-webkit-scrollbar-track {
    background: var(--bg-primary);
  }
  ::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 4px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: var(--text-muted);
  }

  /* === Selection === */
  ::selection {
    background: rgba(0, 255, 136, 0.25);
    color: #fff;
  }

  /* === Images === */
  .kg-image-card img,
  .gh-content img {
    border-radius: 8px !important;
    border: 1px solid var(--border) !important;
  }

  /* === Misc backgrounds that Casper leaves white === */
  .inner,
  .outer,
  main,
  .site-main,
  .post-template .post-full-content,
  .page-template .post-full-content,
  .tag-template .post-feed,
  .home-template .post-feed,
  .site-content {
    background: var(--bg-primary) !important;
  }

  /* === Headings inside content === */
  .gh-content h2, .gh-content h3, .gh-content h4,
  .post-full-content h2, .post-full-content h3, .post-full-content h4 {
    color: var(--text-primary) !important;
    font-weight: 600 !important;
  }
  .gh-content h2::before, .post-full-content h2::before {
    content: "## " !important;
    color: var(--accent-dim) !important;
    font-family: var(--font-mono) !important;
    font-weight: 400 !important;
  }
  .gh-content h3::before, .post-full-content h3::before {
    content: "### " !important;
    color: var(--accent-dim) !important;
    font-family: var(--font-mono) !important;
    font-weight: 400 !important;
  }

  /* No overlay — keep it clean */
</style>
`;
}

// ---------------------------------------------------------------------------
// Custom footer JS — cleanup for static site
// ---------------------------------------------------------------------------

function CUSTOM_FOOT_JS() {
  return `
<script>
  // Strip broken Ghost interactive elements from the static mirror
  document.addEventListener('DOMContentLoaded', function() {
    // Remove portal triggers
    document.querySelectorAll('[data-portal]').forEach(el => el.remove());
    // Remove search
    document.querySelectorAll('[data-ghost-search]').forEach(el => el.remove());
    // Remove any subscribe forms
    document.querySelectorAll('form[data-members-form]').forEach(el => el.remove());
    // Remove sign-in links
    document.querySelectorAll('a[href="#/portal/signin"], a[href="#/portal/signup"]').forEach(el => {
      el.closest('li')?.remove() || el.remove();
    });
  });
</script>
`;
}
