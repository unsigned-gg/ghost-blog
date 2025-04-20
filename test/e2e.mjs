#!/usr/bin/env node

/**
 * E2E test: publish the article to Ghost and verify it renders correctly.
 *
 * Sequence:
 *   1. Wait for Ghost to be healthy
 *   2. Publish the markdown article via Admin API
 *   3. Fetch the published page via Content API
 *   4. Assert: title present, key sections present, code blocks survived
 *   5. Fetch via public URL and check HTML rendering
 *
 * Usage:
 *   node test/e2e.mjs
 *
 * Env:
 *   GHOST_API_URL          (default: http://localhost:2368)
 *   GHOST_ADMIN_API_KEY    (required, format: <id>:<secret>)
 *   GHOST_CONTENT_API_KEY  (required)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGhostToken, htmlToMobiledoc, parseMarkdown } from "../lib/ghost.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GHOST_API_URL = process.env.GHOST_API_URL || "http://localhost:2368";
const GHOST_ADMIN_API_KEY = process.env.GHOST_ADMIN_API_KEY;
const GHOST_CONTENT_API_KEY = process.env.GHOST_CONTENT_API_KEY;
const ARTICLE_PATH = path.join(
  PROJECT_ROOT,
  "content",
  "invisible-text-resume-exploit.md"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test phases
// ---------------------------------------------------------------------------

async function waitForGhost(maxRetries = 30) {
  console.log("\n[1/5] Waiting for Ghost to be healthy...");
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${GHOST_API_URL}/ghost/api/admin/site/`, {
        headers: { Authorization: `Ghost ${createGhostToken(GHOST_ADMIN_API_KEY)}` },
      });
      if (res.ok) {
        const data = await res.json();
        assert(true, `Ghost is up (v${data.site?.version || "unknown"})`);
        return;
      }
    } catch {
      // not ready yet
    }
    await sleep(2000);
  }
  assert(false, "Ghost did not become healthy in time");
  process.exit(1);
}

async function publishArticle() {
  console.log("\n[2/5] Publishing article via Admin API...");

  const raw = fs.readFileSync(ARTICLE_PATH, "utf-8");
  const { title, html } = parseMarkdown(raw);
  const slug = "invisible-ink-unicode-exploits-resume-screening";

  const token = createGhostToken(GHOST_ADMIN_API_KEY);

  // Delete existing post with same slug if present (idempotent reruns)
  try {
    const existing = await fetch(
      `${GHOST_API_URL}/ghost/api/admin/posts/slug/${slug}/`,
      { headers: { Authorization: `Ghost ${token}` } }
    );
    if (existing.ok) {
      const data = await existing.json();
      const id = data.posts[0].id;
      await fetch(`${GHOST_API_URL}/ghost/api/admin/posts/${id}/`, {
        method: "DELETE",
        headers: { Authorization: `Ghost ${createGhostToken(GHOST_ADMIN_API_KEY)}` },
      });
      console.log("  (deleted existing post for idempotent rerun)");
    }
  } catch {
    // no existing post, fine
  }

  const body = {
    posts: [
      {
        title,
        slug,
        mobiledoc: htmlToMobiledoc(html),
        status: "published",
        tags: [
          { name: "security-research" },
          { name: "ai" },
          { name: "hiring" },
        ],
      },
    ],
  };

  const res = await fetch(`${GHOST_API_URL}/ghost/api/admin/posts/?source=html`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Ghost ${createGhostToken(GHOST_ADMIN_API_KEY)}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    assert(false, `Admin API returned ${res.status}: ${errText}`);
    process.exit(1);
  }
  const data = await res.json();
  const post = data.posts[0];

  assert(post.title.includes("Invisible Ink"), `Title correct: "${post.title}"`);
  assert(post.slug === slug, `Slug correct: ${post.slug}`);
  assert(post.status === "published", `Status is published`);

  return post;
}

async function fetchViaContentAPI(slug) {
  console.log("\n[3/5] Fetching via Content API...");

  if (!GHOST_CONTENT_API_KEY) {
    assert(false, "GHOST_CONTENT_API_KEY not set, skipping Content API tests");
    return null;
  }

  const url = `${GHOST_API_URL}/ghost/api/content/posts/slug/${slug}/?key=${GHOST_CONTENT_API_KEY}&include=tags`;
  const res = await fetch(url);

  assert(res.ok, `Content API returned ${res.status}`);
  const data = await res.json();
  const post = data.posts[0];

  assert(post.tags.length > 0, `Tags present (${post.tags.map((t) => t.name).join(", ")})`);
  assert(
    post.tags.some((t) => t.name === "security-research"),
    `Has security-research tag`
  );

  return post;
}

async function verifyHTMLContent(post) {
  console.log("\n[4/5] Verifying HTML content...");

  const html = post.html || "";

  // Key sections that must survive the markdown → Ghost pipeline
  const requiredFragments = [
    ["thesis section", "AI resume screening is not a filter"],
    ["white-on-white technique", "White-on-White Text Injection"],
    ["zero-width section", "Zero-Width Unicode Characters"],
    ["Python encode function", "def encode_invisible"],
    ["Python decode function", "def decode_invisible"],
    ["prompt injection section", "Prompt Injection"],
    ["41% stat", "41%"],
    ["OWASP reference", "OWASP"],
    ["localization trap argument", "localization trap"],
    ["code block: U+200B", "U+200B"],
    ["conclusion", "coin flip with extra steps"],
  ];

  for (const [label, fragment] of requiredFragments) {
    assert(html.includes(fragment), `Contains ${label}: "${fragment}"`);
  }
}

async function fetchPublicPage(postUrl) {
  console.log("\n[5/5] Fetching public page and checking render...");

  // Ghost may return a relative or full URL
  const url = postUrl.startsWith("http")
    ? postUrl
    : `${GHOST_API_URL}${postUrl}`;

  const res = await fetch(url);
  assert(res.ok, `Public page returned ${res.status}`);

  const html = await res.text();
  assert(html.includes("<html"), "Response is HTML document");
  assert(
    html.includes("Invisible Ink") || html.includes("invisible-ink"),
    "Page title/slug present in HTML"
  );
  assert(html.includes("encode_invisible"), "Code block rendered on public page");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Ghost Blog E2E Test: Invisible Unicode Article ║");
  console.log("╚══════════════════════════════════════════════════╝");

  if (!GHOST_ADMIN_API_KEY) {
    console.error("\nGHOST_ADMIN_API_KEY is required. Run `source scripts/setup.sh` first.");
    process.exit(1);
  }

  await waitForGhost();
  const post = await publishArticle();

  const contentPost = await fetchViaContentAPI(post.slug);
  await verifyHTMLContent(contentPost || post);
  await fetchPublicPage(post.url);

  console.log("\n══════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
