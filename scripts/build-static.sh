#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Build a static mirror of the running Ghost instance.
#
# Uses wget --mirror to crawl the Ghost site and produce a directory of
# static HTML, CSS, JS, and images suitable for GitHub Pages deployment.
#
# Usage:
#   bash scripts/build-static.sh [output-dir]
#
# Requires:
#   - Ghost running at GHOST_API_URL (default: http://localhost:2368)
#   - wget installed
#   - Article(s) already published
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

GHOST_API_URL="${GHOST_API_URL:-http://localhost:2368}"
OUTPUT_DIR="${1:-${PROJECT_DIR}/_site}"
CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-eng.todie.io}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[build-static]${NC} $*"; }
warn() { echo -e "${YELLOW}[build-static]${NC} $*"; }
err()  { echo -e "${RED}[build-static]${NC} $*" >&2; }

# --------------------------------------------------------------------------
# Pre-flight
# --------------------------------------------------------------------------

if ! command -v wget &> /dev/null; then
  err "wget is required. Install with: apt-get install wget"
  exit 1
fi

log "Checking Ghost is up at ${GHOST_API_URL}..."
if ! curl -sf "${GHOST_API_URL}/ghost/api/admin/site/" > /dev/null 2>&1; then
  # Try without auth (public site check)
  if ! curl -sf "${GHOST_API_URL}/" > /dev/null 2>&1; then
    err "Ghost is not responding at ${GHOST_API_URL}"
    exit 1
  fi
fi
log "Ghost is up."

# --------------------------------------------------------------------------
# Mirror
# --------------------------------------------------------------------------

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Extract host:port from URL for wget domain filtering
GHOST_HOST=$(echo "$GHOST_API_URL" | sed 's|https\?://||' | sed 's|/.*||')

log "Mirroring ${GHOST_API_URL} -> ${OUTPUT_DIR}..."

wget \
  --mirror \
  --convert-links \
  --adjust-extension \
  --page-requisites \
  --no-parent \
  --no-host-directories \
  --directory-prefix="$OUTPUT_DIR" \
  --reject="ghost/api/*" \
  --reject-regex="/ghost/(api|auth|setup).*" \
  --execute robots=off \
  --quiet \
  --show-progress \
  "${GHOST_API_URL}/" 2>&1 || true
  # wget exits non-zero on some redirects/404s; we handle missing files below

# --------------------------------------------------------------------------
# Post-processing
# --------------------------------------------------------------------------

# Remove duplicate article pages (Ghost serves same post at multiple URLs)
# Only dedup article pages (not homepage, tag, author, about, rss pages)
log "Deduplicating mirrored article pages..."
python3 -c "
import os, re, sys, shutil

output_dir = sys.argv[1]
SKIP_DIRS = {'tag', 'author', 'about', 'rss', 'assets', 'public'}

# Map <title> -> list of directories
title_to_dirs = {}

for entry in os.listdir(output_dir):
    entry_path = os.path.join(output_dir, entry)
    if not os.path.isdir(entry_path):
        continue
    if entry in SKIP_DIRS:
        continue
    html_path = os.path.join(entry_path, 'index.html')
    if not os.path.isfile(html_path):
        continue
    with open(html_path) as f:
        content = f.read()
    m = re.search(r'<title>([^<]+)</title>', content)
    if not m:
        continue
    title = m.group(1).strip()
    title_to_dirs.setdefault(title, []).append(entry)

# For duplicate titles, keep the shortest slug (most likely our explicit one)
removed = 0
removed_slugs = []
for title, dirs in title_to_dirs.items():
    if len(dirs) <= 1:
        continue
    dirs.sort(key=len)
    keep = dirs[0]
    for d in dirs[1:]:
        full = os.path.join(output_dir, d)
        print(f'  Removing duplicate: {d}/ (keeping {keep}/)')
        shutil.rmtree(full)
        removed_slugs.append(d)
        removed += 1

# Strip article cards referencing removed slugs from ALL HTML pages
# (covers homepage cards AND per-article 'Read more' sections)
if removed_slugs:
    import glob
    html_files = glob.glob(os.path.join(output_dir, '**', '*.html'), recursive=True)
    for html_file in html_files:
        with open(html_file) as f:
            content = f.read()
        original = content
        for slug in removed_slugs:
            # Match a single <article>...</article> block containing the slug
            # Use [^<]* alternating with <(?!/article) to avoid crossing </article>
            pattern = rf'<article[^>]*>(?:(?!</article>).)*?{re.escape(slug)}/.*?</article>'
            content = re.sub(pattern, '', content, flags=re.DOTALL)
        if content != original:
            with open(html_file, 'w') as f:
                f.write(content)
            print(f'  Cleaned refs in: {os.path.relpath(html_file, output_dir)}')

print(f'  Removed {removed} duplicate dir(s).')
" "$OUTPUT_DIR"

# Remove Ghost admin panel artifacts if captured
rm -rf "${OUTPUT_DIR}/ghost" 2>/dev/null || true
rm -rf "${OUTPUT_DIR}/p/" 2>/dev/null || true

# Strip Ghost portal/search/members JS from mirrored HTML
log "Stripping Ghost interactive JS from static pages..."
find "$OUTPUT_DIR" -name '*.html' -exec sed -i \
  -e '/<script[^>]*portal[^>]*>/d' \
  -e '/<script[^>]*sodo-search[^>]*>/d' \
  -e '/<script[^>]*members[^>]*>/d' \
  -e '/<link[^>]*portal[^>]*>/d' \
  {} +

# Fix Casper's background-color variable so its JS computes dark-text mode
log "Fixing Casper background-color variable..."
find "$OUTPUT_DIR" -name '*.html' -exec sed -i \
  -e 's/--background-color: #ffffff/--background-color: #0a0a0f/g' \
  {} +

# Remove Ghost default cover image tags (loads from external Ghost CDN)
log "Removing Ghost default cover images..."
find "$OUTPUT_DIR" -name '*.html' -exec sed -i \
  -e '/<img[^>]*gh-header-image[^>]*>/d' \
  {} +

# Remove Ghost's orphaned .gh-post-upgrade-cta CSS block
# Ghost injects this without a <style> wrapper, causing raw CSS text to render
log "Removing orphaned Ghost CSS blocks..."
find "$OUTPUT_DIR" -name '*.html' -exec python3 -c "
import sys, re
for f in sys.argv[1:]:
    with open(f) as fh:
        html = fh.read()
    # Remove all .gh-post-upgrade-cta CSS rules that appear outside <style> tags
    html = re.sub(r'\.gh-post-upgrade-cta[^<]*', '', html)
    with open(f, 'w') as fh:
        fh.write(html)
" {} +

# --------------------------------------------------------------------------
# Fix Open Graph / Twitter Card meta tags for link previews
# --------------------------------------------------------------------------

log "Fixing OG/Twitter meta tags for link previews..."

# Generate OG images for each page
pip install Pillow --break-system-packages -q 2>/dev/null || true

python3 -c "
import os, re, sys

output_dir = sys.argv[1]
domain = sys.argv[2]

# Try to generate OG images with Pillow
try:
    from PIL import Image, ImageDraw, ImageFont
    has_pillow = True
except ImportError:
    has_pillow = False
    print('  Pillow not available, using SVG fallback for OG images')

def make_og_image_pillow(title, out_path):
    \"\"\"Generate a 1200x630 OG image matching the site's dark terminal aesthetic.\"\"\"
    img = Image.new('RGB', (1200, 630), color=(10, 10, 15))
    draw = ImageDraw.Draw(img)

    # Try to load a monospace font, fall back to default
    font_title = None
    font_site = None
    for fp in ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
               '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
               '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf']:
        if os.path.isfile(fp):
            font_title = ImageFont.truetype(fp, 42)
            font_site = ImageFont.truetype(fp, 24)
            break
    if font_title is None:
        font_title = ImageFont.load_default()
        font_site = ImageFont.load_default()

    # Draw accent line at top
    draw.rectangle([(0, 0), (1200, 4)], fill=(0, 255, 136))

    # Draw site name
    draw.text((60, 40), 'todie.io/eng', fill=(0, 255, 136), font=font_site)

    # Word-wrap and draw title
    words = title.split()
    lines = []
    current = ''
    for w in words:
        test = (current + ' ' + w).strip()
        bbox = draw.textbbox((0, 0), test, font=font_title)
        if bbox[2] - bbox[0] > 1080:
            if current:
                lines.append(current)
            current = w
        else:
            current = test
    if current:
        lines.append(current)

    y = 160
    for line in lines[:5]:
        draw.text((60, y), line, fill=(240, 240, 240), font=font_title)
        y += 60

    # Draw bottom accent line
    draw.rectangle([(0, 626), (1200, 630)], fill=(0, 255, 136))

    img.save(out_path, 'PNG', optimize=True)

def make_og_image_svg(title, out_path):
    \"\"\"Generate an SVG OG image as fallback.\"\"\"
    # Escape XML entities
    safe_title = title.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('\"', '&quot;')

    # Split into lines (~40 chars each)
    words = safe_title.split()
    lines = []
    current = ''
    for w in words:
        test = (current + ' ' + w).strip()
        if len(test) > 40 and current:
            lines.append(current)
            current = w
        else:
            current = test
    if current:
        lines.append(current)

    title_lines = ''
    for i, line in enumerate(lines[:5]):
        y = 260 + i * 60
        title_lines += f'<text x=\"60\" y=\"{y}\" fill=\"#f0f0f0\" font-family=\"monospace\" font-size=\"42\" font-weight=\"bold\">{line}</text>\n'

    svg = f'''<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1200\" height=\"630\" viewBox=\"0 0 1200 630\">
  <rect width=\"1200\" height=\"630\" fill=\"#0a0a0f\"/>
  <rect width=\"1200\" height=\"4\" fill=\"#00ff88\"/>
  <text x=\"60\" y=\"70\" fill=\"#00ff88\" font-family=\"monospace\" font-size=\"24\">todie.io/eng</text>
  {title_lines}
  <rect y=\"626\" width=\"1200\" height=\"4\" fill=\"#00ff88\"/>
</svg>'''

    # Save as SVG (will still work as og:image)
    with open(out_path, 'w') as f:
        f.write(svg)

# Create og-images directory
og_dir = os.path.join(output_dir, 'og-images')
os.makedirs(og_dir, exist_ok=True)

# Process all HTML files to fix meta tags and generate OG images
html_files = []
for root, dirs, files in os.walk(output_dir):
    for fname in files:
        if fname.endswith('.html'):
            html_files.append(os.path.join(root, fname))

for html_file in html_files:
    with open(html_file) as f:
        content = f.read()

    original = content

    # Extract title for OG image
    title_match = re.search(r'<meta property=\"og:title\" content=\"([^\"]+)\"', content)
    page_title = title_match.group(1) if title_match else 'todie.io/eng'

    # Determine the page path relative to output dir
    rel_path = os.path.relpath(os.path.dirname(html_file), output_dir)
    if rel_path == '.':
        slug = 'index'
    else:
        slug = rel_path.replace('/', '-')

    # Generate OG image
    og_filename = f'{slug}.png' if has_pillow else f'{slug}.svg'
    og_path = os.path.join(og_dir, og_filename)
    if has_pillow:
        make_og_image_pillow(page_title, og_path)
    else:
        make_og_image_svg(page_title, og_path)

    og_url = f'https://{domain}/og-images/{og_filename}'

    # Fix og:url and twitter:url — replace localhost with real domain
    content = re.sub(
        r'(<meta property=\"og:url\" content=\")http://localhost:\d+(/[^\"]*\")',
        rf'\g<1>https://{domain}\2',
        content
    )
    content = re.sub(
        r'(<meta name=\"twitter:url\" content=\")http://localhost:\d+(/[^\"]*\")',
        rf'\g<1>https://{domain}\2',
        content
    )

    # Fix og:image and twitter:image — replace Ghost default with our OG image
    content = re.sub(
        r'<meta property=\"og:image\" content=\"[^\"]*\">',
        f'<meta property=\"og:image\" content=\"{og_url}\">',
        content
    )
    content = re.sub(
        r'<meta name=\"twitter:image\" content=\"[^\"]*\">',
        f'<meta name=\"twitter:image\" content=\"{og_url}\">',
        content
    )

    # Fix og:image dimensions (our images are 1200x630)
    content = re.sub(
        r'<meta property=\"og:image:width\" content=\"[^\"]*\">',
        '<meta property=\"og:image:width\" content=\"1200\">',
        content
    )
    content = re.sub(
        r'<meta property=\"og:image:height\" content=\"[^\"]*\">',
        '<meta property=\"og:image:height\" content=\"630\">',
        content
    )

    # Fix twitter:site — remove Ghost's @ghost handle
    content = re.sub(
        r'<meta name=\"twitter:site\" content=\"@ghost\">',
        '',
        content
    )

    # Fix canonical URL
    content = re.sub(
        r'(<link rel=\"canonical\" href=\")http://localhost:\d+(/[^\"]*\")',
        rf'\g<1>https://{domain}\2',
        content
    )

    # Fix any remaining localhost references in meta tags
    content = re.sub(
        r'http://localhost:\d+',
        f'https://{domain}',
        content
    )

    if content != original:
        with open(html_file, 'w') as f:
            f.write(content)

print('  OG/Twitter meta tags fixed across all pages.')
print(f'  Generated OG images in {og_dir}/')
" "$OUTPUT_DIR" "$CUSTOM_DOMAIN"

# Add CNAME for GitHub Pages custom domain
echo "$CUSTOM_DOMAIN" > "${OUTPUT_DIR}/CNAME"

# Add .nojekyll to skip Jekyll processing (preserves _files)
touch "${OUTPUT_DIR}/.nojekyll"

# --------------------------------------------------------------------------
# Verify
# --------------------------------------------------------------------------

INDEX="${OUTPUT_DIR}/index.html"
if [[ -f "$INDEX" ]]; then
  PAGE_COUNT=$(find "$OUTPUT_DIR" -name "*.html" | wc -l)
  TOTAL_SIZE=$(du -sh "$OUTPUT_DIR" | cut -f1)
  log "Static build complete:"
  log "  Output:     ${OUTPUT_DIR}"
  log "  HTML pages: ${PAGE_COUNT}"
  log "  Total size: ${TOTAL_SIZE}"
  log "  CNAME:      ${CUSTOM_DOMAIN}"
else
  err "No index.html found. Mirror may have failed."
  err "Check that Ghost has at least one published post."
  ls -la "$OUTPUT_DIR"
  exit 1
fi
