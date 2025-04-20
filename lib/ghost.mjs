/**
 * Shared Ghost Admin API utilities.
 *
 * Used by both scripts/publish.mjs and test/e2e.mjs to avoid duplicating
 * JWT creation, mobiledoc encoding, and markdown parsing logic.
 */

import jwt from "jsonwebtoken";
import { marked } from "marked";

// ---------------------------------------------------------------------------
// Ghost Admin JWT
// ---------------------------------------------------------------------------

/**
 * Create a short-lived HS256 JWT for the Ghost Admin API.
 *
 * @param {string} adminApiKey - Format: "<key_id>:<hex_secret>"
 * @returns {string} Signed JWT
 */
export function createGhostToken(adminApiKey) {
  const [id, secret] = adminApiKey.split(":");
  if (!id || !secret) {
    throw new Error(
      "GHOST_ADMIN_API_KEY must be in the format <key_id>:<secret>"
    );
  }

  const iat = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat, exp: iat + 5 * 60, aud: "/admin/" },
    Buffer.from(secret, "hex"),
    { header: { alg: "HS256", typ: "JWT", kid: id } }
  );
}

// ---------------------------------------------------------------------------
// Mobiledoc
// ---------------------------------------------------------------------------

/**
 * Wrap an HTML string in a Ghost mobiledoc "html" card.
 *
 * This is the simplest mobiledoc structure: a single HTML card containing
 * the full post body. Ghost renders it verbatim.
 *
 * @param {string} html - Rendered HTML content
 * @returns {string} JSON-serialized mobiledoc
 */
export function htmlToMobiledoc(html) {
  return JSON.stringify({
    version: "0.3.1",
    markups: [],
    atoms: [],
    cards: [["html", { html }]],
    sections: [[10, 0]],
  });
}

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

/**
 * Parse a markdown document. Extracts the first H1 as the title and
 * converts the remaining body to HTML via `marked`.
 *
 * @param {string} raw - Raw markdown string
 * @returns {{ title: string, html: string, slug: string }}
 */
export function parseMarkdown(raw) {
  const lines = raw.split("\n");
  let title = "Untitled";
  let contentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^#\s+(.+)/);
    if (match) {
      title = match[1].trim();
      contentStart = i + 1;
      break;
    }
  }

  const markdownBody = lines.slice(contentStart).join("\n").trim();
  // Extract optional tags from <!-- tags: foo, bar --> comment
  const tagMatch = raw.match(/<!--\s*tags:\s*(.+?)\s*-->/i);
  const tags = tagMatch
    ? tagMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  // Extract optional date from <!-- date: YYYY-MM-DD --> comment
  const dateMatch = raw.match(/<!--\s*date:\s*(\d{4}-\d{2}-\d{2})\s*-->/i);
  const publishedAt = dateMatch ? dateMatch[1] : null;

  const html = marked.parse(markdownBody);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  return { title, html, slug, tags, publishedAt };
}
