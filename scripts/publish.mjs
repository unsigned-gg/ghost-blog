#!/usr/bin/env node

/**
 * Publish a markdown file to Ghost via the Admin API.
 *
 * Usage:
 *   node scripts/publish.mjs <path-to-markdown-file>
 *   node scripts/publish.mjs content/invisible-text-resume-exploit.md
 *
 * Requires GHOST_ADMIN_API_KEY and GHOST_API_URL env vars.
 * Run `source scripts/setup.sh` first to configure these.
 */

import fs from "node:fs";
import path from "node:path";
import { createGhostToken, htmlToMobiledoc, parseMarkdown } from "../lib/ghost.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GHOST_API_URL = process.env.GHOST_API_URL || "http://localhost:2368";
const GHOST_ADMIN_API_KEY = process.env.GHOST_ADMIN_API_KEY;

if (!GHOST_ADMIN_API_KEY) {
  console.error(
    "GHOST_ADMIN_API_KEY not set. Run `source scripts/setup.sh` or export it manually.\n" +
      "Format: <key_id>:<secret>"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Ghost Admin API client
// ---------------------------------------------------------------------------

/** @param {{ title: string, html: string, slug: string, status?: string, tags?: string[], published_at?: string }} opts */
async function publishPost({ title, html, slug, status = "published", tags = [], published_at }) {
  const token = createGhostToken(GHOST_ADMIN_API_KEY);
  const mobiledoc = htmlToMobiledoc(html);

  const url = new URL("/ghost/api/admin/posts/", GHOST_API_URL);
  url.searchParams.set("source", "html");

  const body = {
    posts: [
      {
        title,
        slug,
        mobiledoc,
        status,
        tags: tags.length > 0
          ? tags.map((t) => ({ name: t }))
          : [{ name: "security-research" }],
        ...(published_at ? { published_at: new Date(published_at + "T12:00:00.000Z").toISOString() } : {}),
      },
    ],
  };

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Ghost ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ghost API ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.posts[0];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/publish.mjs <markdown-file>");
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  const { title, html, tags: parsedTags, publishedAt } = parseMarkdown(raw);

  // Derive slug from filename (short, predictable) — not the full title
  const slug = path.basename(resolved, ".md");

  console.log(`Publishing: "${title}"`);
  console.log(`Slug:       ${slug}`);
  console.log(`Date:       ${publishedAt || "(now)"}`);
  console.log(`API URL:    ${GHOST_API_URL}`);

  const post = await publishPost({ title, html, slug, tags: parsedTags, published_at: publishedAt });

  console.log(`\nPublished!`);
  console.log(`  ID:   ${post.id}`);
  console.log(`  URL:  ${post.url}`);
  console.log(`  Slug: ${post.slug}`);

  // Write post metadata for e2e test consumption
  const meta = {
    id: post.id,
    url: post.url,
    slug: post.slug,
    title: post.title,
    published_at: post.published_at,
  };
  const metaPath = path.resolve("content/.last-published.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`  Meta: ${metaPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
