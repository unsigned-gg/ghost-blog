#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Ghost Blog Setup Script
#
# Boots Ghost in Docker, waits for it, creates an admin user, extracts API
# keys, starts ngrok tunnel, and persists credentials to ~/.bashrc.
#
# Usage:
#   source scripts/setup.sh          # first run — full setup
#   source scripts/setup.sh --skip-docker  # reattach to existing Ghost
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

GHOST_PORT=2368
GHOST_LOCAL_URL="http://localhost:${GHOST_PORT}"
SKIP_DOCKER="${1:-}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
err()  { echo -e "${RED}[setup]${NC} $*" >&2; }

# --------------------------------------------------------------------------
# 1. Docker
# --------------------------------------------------------------------------

if [[ "$SKIP_DOCKER" != "--skip-docker" ]]; then
  log "Starting Ghost + MySQL via docker compose..."
  docker compose up -d

  log "Waiting for Ghost to be healthy..."
  for i in $(seq 1 60); do
    if curl -sf "${GHOST_LOCAL_URL}/ghost/api/admin/site/" > /dev/null 2>&1; then
      log "Ghost is up!"
      break
    fi
    if [[ $i -eq 60 ]]; then
      err "Ghost did not start within 120s. Check: docker compose logs ghost"
      return 1 2>/dev/null || exit 1
    fi
    sleep 2
  done
fi

# --------------------------------------------------------------------------
# 2. Create admin user via Ghost setup endpoint
# --------------------------------------------------------------------------

GHOST_ADMIN_EMAIL="${GHOST_ADMIN_EMAIL:-admin@ghost.local}"
GHOST_ADMIN_PASSWORD="${GHOST_ADMIN_PASSWORD:-Str0ngP@ssword123!}"
GHOST_BLOG_TITLE="${GHOST_BLOG_TITLE:-Engineering Blog}"

# Check if setup is already done
SETUP_STATUS=$(curl -sf "${GHOST_LOCAL_URL}/ghost/api/admin/authentication/setup/" 2>/dev/null || echo '{"setup":[{"status":true}]}')

if echo "$SETUP_STATUS" | grep -q '"status":false'; then
  log "Running Ghost first-time setup..."
  SETUP_RESULT=$(curl -sf -X POST "${GHOST_LOCAL_URL}/ghost/api/admin/authentication/setup/" \
    -H "Content-Type: application/json" \
    -d "{
      \"setup\": [{
        \"name\": \"Admin\",
        \"email\": \"${GHOST_ADMIN_EMAIL}\",
        \"password\": \"${GHOST_ADMIN_PASSWORD}\",
        \"blogTitle\": \"${GHOST_BLOG_TITLE}\"
      }]
    }" 2>&1)

  if echo "$SETUP_RESULT" | grep -q '"users"'; then
    log "Admin user created: ${GHOST_ADMIN_EMAIL}"
  else
    err "Setup failed: $SETUP_RESULT"
    return 1 2>/dev/null || exit 1
  fi
else
  log "Ghost already set up, skipping admin creation."
fi

# --------------------------------------------------------------------------
# 3. Get session cookie for admin operations
# --------------------------------------------------------------------------

log "Authenticating to get session..."
SESSION_COOKIE=$(curl -sf -D - -o /dev/null -X POST \
  "${GHOST_LOCAL_URL}/ghost/api/admin/session/" \
  -H "Content-Type: application/json" \
  -H "Origin: ${GHOST_LOCAL_URL}" \
  -d "{\"username\":\"${GHOST_ADMIN_EMAIL}\",\"password\":\"${GHOST_ADMIN_PASSWORD}\"}" \
  2>/dev/null | grep -i 'set-cookie' | head -1 | sed 's/.*ghost-admin-api-session=\([^;]*\).*/ghost-admin-api-session=\1/')

if [[ -z "$SESSION_COOKIE" ]]; then
  err "Failed to get admin session cookie"
  return 1 2>/dev/null || exit 1
fi

# --------------------------------------------------------------------------
# 4. Create or retrieve Admin API key
# --------------------------------------------------------------------------

log "Fetching API integrations..."
INTEGRATIONS=$(curl -sf "${GHOST_LOCAL_URL}/ghost/api/admin/integrations/?include=api_keys" \
  -H "Cookie: ${SESSION_COOKIE}" \
  -H "Origin: ${GHOST_LOCAL_URL}" 2>/dev/null)

# Check if our integration already exists
EXISTING_ADMIN_KEY=$(echo "$INTEGRATIONS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for i in data.get('integrations', []):
        if i.get('name') == 'E2E Publisher':
            for k in i.get('api_keys', []):
                if k.get('type') == 'admin':
                    print(k['secret'] if ':' in k['secret'] else k['id'] + ':' + k['secret'])
                    break
            break
except: pass
" 2>/dev/null || echo "")

if [[ -n "$EXISTING_ADMIN_KEY" ]]; then
  GHOST_ADMIN_API_KEY="$EXISTING_ADMIN_KEY"
  log "Found existing Admin API key."
else
  log "Creating 'E2E Publisher' integration..."
  INTEGRATION_RESULT=$(curl -sf -X POST "${GHOST_LOCAL_URL}/ghost/api/admin/integrations/" \
    -H "Content-Type: application/json" \
    -H "Cookie: ${SESSION_COOKIE}" \
    -H "Origin: ${GHOST_LOCAL_URL}" \
    -d '{"integrations":[{"name":"E2E Publisher"}]}' 2>/dev/null)

  GHOST_ADMIN_API_KEY=$(echo "$INTEGRATION_RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
keys = data['integrations'][0]['api_keys']
for k in keys:
    if k['type'] == 'admin':
        print(k['secret'] if ':' in k['secret'] else k['id'] + ':' + k['secret'])
        break
" 2>/dev/null)

  if [[ -z "$GHOST_ADMIN_API_KEY" ]]; then
    err "Failed to create integration. Response: $INTEGRATION_RESULT"
    return 1 2>/dev/null || exit 1
  fi
  log "Admin API key created."
fi

# Get Content API key too
GHOST_CONTENT_API_KEY=$(echo "$INTEGRATIONS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for i in data.get('integrations', []):
        if i.get('name') == 'E2E Publisher':
            for k in i.get('api_keys', []):
                if k.get('type') == 'content':
                    print(k['secret'])
                    break
            break
except: pass
" 2>/dev/null || echo "")

# If we just created the integration, re-fetch to get content key
if [[ -z "$GHOST_CONTENT_API_KEY" ]]; then
  INTEGRATIONS=$(curl -sf "${GHOST_LOCAL_URL}/ghost/api/admin/integrations/?include=api_keys" \
    -H "Cookie: ${SESSION_COOKIE}" \
    -H "Origin: ${GHOST_LOCAL_URL}" 2>/dev/null)

  GHOST_CONTENT_API_KEY=$(echo "$INTEGRATIONS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for i in data.get('integrations', []):
    if i.get('name') == 'E2E Publisher':
        for k in i.get('api_keys', []):
            if k.get('type') == 'content':
                print(k['secret'])
                break
        break
" 2>/dev/null || echo "")
fi

export GHOST_ADMIN_API_KEY
export GHOST_CONTENT_API_KEY
export GHOST_API_URL="$GHOST_LOCAL_URL"

log "Admin API Key:   ${GHOST_ADMIN_API_KEY:0:12}..."
log "Content API Key: ${GHOST_CONTENT_API_KEY:0:12}..."

# --------------------------------------------------------------------------
# 5. ngrok tunnel
# --------------------------------------------------------------------------

if command -v ngrok &> /dev/null; then
  log "Starting ngrok tunnel on port ${GHOST_PORT}..."
  ngrok http "$GHOST_PORT" --log=stdout > /tmp/ngrok.log 2>&1 &
  NGROK_PID=$!
  sleep 3

  NGROK_URL=$(curl -sf http://localhost:4040/api/tunnels 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for t in data.get('tunnels', []):
    if t.get('proto') == 'https':
        print(t['public_url'])
        break
" 2>/dev/null || echo "")

  if [[ -n "$NGROK_URL" ]]; then
    export GHOST_PUBLIC_URL="$NGROK_URL"
    log "ngrok tunnel: ${NGROK_URL}"
    warn "Note: Ghost's url config is still localhost. For production, update GHOST_URL in docker-compose.yml."
  else
    warn "ngrok started (PID $NGROK_PID) but couldn't detect URL. Check http://localhost:4040"
  fi
else
  warn "ngrok not found. Install with: npm i -g ngrok  or  brew install ngrok"
  warn "Ghost is accessible locally at ${GHOST_LOCAL_URL}"
fi

# --------------------------------------------------------------------------
# 6. Persist to .bashrc
# --------------------------------------------------------------------------

BASHRC="${HOME}/.bashrc"

# Remove old entries if present
if [[ -f "$BASHRC" ]]; then
  sed -i '/^# --- Ghost Blog E2E ---$/,/^# --- \/Ghost Blog E2E ---$/d' "$BASHRC"
fi

cat >> "$BASHRC" << ENVBLOCK
# --- Ghost Blog E2E ---
export GHOST_API_URL="${GHOST_LOCAL_URL}"
export GHOST_ADMIN_API_KEY="${GHOST_ADMIN_API_KEY}"
export GHOST_CONTENT_API_KEY="${GHOST_CONTENT_API_KEY}"
export GHOST_ADMIN_EMAIL="${GHOST_ADMIN_EMAIL}"
export GHOST_PUBLIC_URL="${NGROK_URL:-}"
# --- /Ghost Blog E2E ---
ENVBLOCK

log "Credentials persisted to ${BASHRC}"

# --------------------------------------------------------------------------
# 7. Install npm deps
# --------------------------------------------------------------------------

if [[ ! -d "node_modules" ]]; then
  log "Installing npm dependencies..."
  npm install --silent
fi

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Ghost is running at:  ${GHOST_LOCAL_URL}"
echo "  Admin panel:          ${GHOST_LOCAL_URL}/ghost/"
echo "  ngrok URL:            ${NGROK_URL:-N/A}"
echo ""
echo "  Publish article:      npm run publish -- content/invisible-text-resume-exploit.md"
echo "  Run e2e tests:        npm run test:e2e"
echo "═══════════════════════════════════════════════════════════"
