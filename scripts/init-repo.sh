#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Initialize the GitHub repo under the todie org.
# Run this ONCE from the ghost-blog directory on your local machine.
#
# Usage:
#   cd ghost-blog
#   bash scripts/init-repo.sh
# ============================================================================

REPO_NAME="ghost-blog"
ORG="todie"

echo "Initializing git repo..."
git init
git branch -m main

echo "Adding all files..."
git add -A
git commit -m "Initial commit: Ghost blog with Admin API publish pipeline, e2e tests, and first article

- Ghost 5 + MySQL 8 docker-compose
- Admin API publish script (markdown -> mobiledoc -> Ghost)
- E2E test: publish + verify render (11 content assertions)
- First article: Invisible Ink (Unicode exploits in AI resume screening)
- Setup script: bootstraps Ghost, creates admin, extracts API keys, ngrok tunnel
- CLAUDE.md for Claude Code sessions
- ROADMAP.md with 5-phase plan

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

echo "Creating GitHub repo: ${ORG}/${REPO_NAME}..."
gh repo create "${ORG}/${REPO_NAME}" \
  --private \
  --description "Self-hosted Ghost engineering blog with Admin API publishing pipeline" \
  --source . \
  --push

echo ""
echo "Done! https://github.com/${ORG}/${REPO_NAME}"
