# Roadmap

## Phase 0: Bootstrap (DONE)
- [x] Ghost + MySQL docker-compose
- [x] Setup script: admin user, API keys, ngrok, bashrc persistence
- [x] Markdown -> Ghost publish script (Admin API, JWT auth, mobiledoc)
- [x] E2E test: publish + verify render pipeline
- [x] First article: "Invisible Ink: Unicode Exploits in AI Resume Screening"
- [x] CLAUDE.md for Claude Code handoff

## Phase 1: Publishing Pipeline
- [ ] Front-matter parser (title, slug, tags, excerpt, featured image, status)
- [ ] `publish.mjs --draft` flag for preview before publish
- [ ] `publish.mjs --update` to update existing posts by slug (PUT instead of POST)
- [ ] Batch publish: `publish.mjs content/*.md`
- [ ] Dry-run mode that shows what would be published without hitting the API
- [ ] Drop `@tryghost/admin-api` dep or migrate to it -- pick one approach

## Phase 2: Content Authoring
- [ ] Article template / scaffolding script (`npm run new -- "My Article Title"`)
- [ ] Image handling: local images -> Ghost upload API -> inline in mobiledoc
- [ ] Code block syntax highlighting verification (Ghost theme Prism.js config)
- [ ] RSS feed validation after publish
- [ ] OpenGraph / Twitter card metadata via front-matter

## Phase 3: Deployment
- [x] CI pipeline: lint + e2e with Ghost-in-Docker (`.github/workflows/ci.yml`)
- [x] Deploy pipeline: manual trigger → static mirror → GitHub Pages (`.github/workflows/deploy.yml`)
- [x] Static site build script (`scripts/build-static.sh`, `wget --mirror`)
- [x] GitHub Pages enabled with custom domain `eng.todie.io`
- [x] Branch protection on `main` (required status checks: lint + e2e)
- [x] DNS migration guide: Namecheap → Cloudflare (`docs/dns-setup.md`)
- [x] DNS CNAME record: `eng` → `todie.github.io` (Cloudflare, DNS only)
- [x] Namecheap nameservers → Cloudflare (`lady.ns.cloudflare.com`, `rudy.ns.cloudflare.com`)
- [ ] Enable HTTPS enforcement on Pages after DNS propagation
- [ ] `GHOST_URL` env var plumbing so internal links resolve to `eng.todie.io`
- [ ] Persistent volume backup strategy (content + MySQL)
- [ ] GitHub Actions: on push to `content/`, auto-publish changed articles
- [ ] Health check endpoint / uptime monitoring

## Phase 4: Theme & Design
- [ ] Evaluate Ghost themes for engineering/technical blog (Casper customization vs. third-party)
- [ ] Code block styling: line numbers, copy button, language labels
- [ ] Dark mode
- [ ] Custom 404

## Phase 5: Distribution
- [ ] Newsletter integration (Ghost native or Buttondown)
- [ ] Cross-post script to dev.to / Hashnode / Medium via their APIs
- [ ] Sitemap generation and search console submission
- [ ] Analytics (Plausible or Umami, self-hosted)

## Parking Lot
- Membership / paywall (Ghost supports this natively, but do we want it?)
- Comments (Ghost native, or external like giscus?)
- Search (Ghost has basic search, or add Pagefind for static-site-quality search)
- Multi-author support
- Series / collections grouping
