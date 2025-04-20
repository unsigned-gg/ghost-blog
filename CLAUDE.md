# Ghost Blog — Engineering Blog Platform

## What This Is

A self-hosted Ghost CMS blog with automated publishing via the Ghost Admin API, tunneled through ngrok for dev/preview. The first article is a security research explainer on invisible Unicode exploits in AI resume screening.

## Architecture

```
ghost-blog/
├── .github/workflows/
│   ├── ci.yml             # Lint + e2e on push/PR (Ghost in Docker)
│   └── deploy.yml         # Manual trigger: build static mirror → GitHub Pages
├── docker-compose.yml     # Ghost 5 (Alpine) + MySQL 8
├── package.json           # ESM, node scripts for publish + e2e
├── lib/
│   └── ghost.mjs          # Shared: JWT auth, mobiledoc encoding, markdown parsing
├── scripts/
│   ├── setup.sh           # One-shot bootstrap
│   ├── publish.mjs        # Markdown -> Ghost mobiledoc -> Admin API POST
│   └── build-static.sh    # wget --mirror Ghost → _site/ for GitHub Pages
├── test/
│   └── e2e.mjs            # 5-phase e2e test
├── content/
│   └── *.md               # Article source files (markdown, H1 = title)
├── docs/
│   └── dns-setup.md       # DNS migration guide (Namecheap → Cloudflare)
├── .env.example
└── ROADMAP.md
```

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| CMS | Ghost over Hugo/Jekyll | CMS with an API, not a static site generator |
| Database | MySQL over SQLite | Ghost recommends MySQL for anything beyond single-user local dev |
| Module system | ESM throughout | All `.mjs` files, `"type": "module"` in package.json |
| Content format | mobiledoc with HTML card | markdown → HTML via marked, then wrap in a single html card |
| Dev access | ngrok tunnel | Temporary tunnel for sharing/previewing. Not for production |
| Shared code | `lib/ghost.mjs` | JWT, mobiledoc, and markdown parsing shared between publish + e2e |

## Environment Variables

All set by `source scripts/setup.sh` and persisted to `~/.bashrc`:

| Variable | Value | Source |
|---|---|---|
| `GHOST_API_URL` | `http://localhost:2368` | Default |
| `GHOST_ADMIN_API_KEY` | `<key_id>:<hex_secret>` | Ghost integration (setup.sh) |
| `GHOST_CONTENT_API_KEY` | hex string | Ghost integration (setup.sh) |
| `GHOST_ADMIN_EMAIL` | email | setup.sh default |
| `GHOST_PUBLIC_URL` | `https://<random>.ngrok-free.app` | ngrok (if available) |

## Commands

```bash
source scripts/setup.sh                          # full bootstrap
npm run publish -- content/<article>.md           # publish a markdown file
npm run test:e2e                                  # run e2e verification
npm run dev                                       # just start docker
npm run down                                      # stop
npm run nuke                                      # stop + delete volumes
npm run lint                                      # eslint (zero warnings)
npm run check:all                                 # lint + syntax + yaml
bash scripts/build-static.sh                      # build static mirror to _site/
```

## CI/CD

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Push/PR to `main` | Lint → syntax check → boot Ghost in Docker → run e2e |
| `deploy.yml` | Manual (`workflow_dispatch`) | Lint → boot Ghost → publish all articles → `wget --mirror` → deploy to GitHub Pages |

The deploy workflow has a `skip_e2e` input for fast deploys when the CI run already passed.

## Hosting

Ghost runs locally (Docker) as the authoring CMS. A static mirror is generated via `wget --mirror` and deployed to GitHub Pages at `eng.todie.io`.

| Layer | Technology | Notes |
|---|---|---|
| Authoring | Ghost 5 (local Docker) | Admin API for publishing |
| Static build | `wget --mirror` | Captures full rendered site |
| Hosting | GitHub Pages | Free, CDN-backed |
| Domain | `eng.todie.io` | CNAME → `todie.github.io` |
| DNS | Cloudflare (target) | Migration from Namecheap; see `docs/dns-setup.md` |

## Testing Strategy

E2E only. The e2e test (`test/e2e.mjs`) is the single source of truth:

| Phase | What it does |
|---|---|
| 1/5 | Wait for Ghost health via Admin API `/site/` endpoint |
| 2/5 | Publish the article (deletes existing by slug first for idempotence) |
| 3/5 | Fetch via Content API, assert tags |
| 4/5 | Assert 11 content fragments survived the markdown → mobiledoc → Ghost HTML pipeline |
| 5/5 | Fetch public URL, assert HTML document with title and code blocks |

No unit tests. The publish script is ~70 lines (with shared code in `lib/ghost.mjs`) and the interesting failure modes are all at the Ghost API boundary.

## Conventions

- Markdown articles go in `content/`. The first `# H1` is extracted as the post title.
- Slugs are auto-derived from title (lowercase, hyphenated) in `lib/ghost.mjs`.
- Tags are hardcoded per-article in the publish script. TODO: front-matter parser.
- All scripts exit non-zero on failure with descriptive errors.

## Tech Stack

| Package | Purpose |
|---|---|
| Ghost 5 (Alpine) | CMS, Docker image |
| MySQL 8 | Database, Docker image |
| `jsonwebtoken` | Ghost Admin API auth (HS256 JWT with hex-decoded secret) |
| `marked` | Markdown → HTML |
| `ngrok` | Dev tunneling |
| `husky` + `lint-staged` | Pre-commit validation |
| `eslint` (flat config, v9+) | JS linting with strict rules |
| `yaml` | YAML validation in pre-commit |

## Pre-commit Validation

Husky + lint-staged runs on every commit:

| Glob | Check |
|---|---|
| `*.mjs` | ESLint (zero warnings) + `node --check` syntax |
| `*.sh` | `bash -n` syntax validation |
| `*.yml` | YAML parse validation |
| `*.md` | Non-empty check |

After cloning, run `npm install` — husky's `prepare` script auto-installs the git hooks.

## GitHub Settings

- **Repo visibility**: Public (required for GitHub Pages on free plan)
- **Branch protection on `main`**: Required status checks (`Lint & syntax check`, `E2E (Ghost in Docker)`), strict (branch must be up to date), no force pushes, no deletions
- **Pages**: Source = GitHub Actions, custom domain = `eng.todie.io`, HTTPS enforced (after DNS)

## Known Issues

- No front-matter support yet — tags and metadata are hardcoded in `publish.mjs`.
- Ghost `url` config in docker-compose is `localhost` — ngrok URLs won't match for internal links.
- e2e test hardcodes the article slug instead of deriving it from the markdown.
- Static build requires Ghost to be running — no offline build from markdown alone yet.
- HTTPS enforcement on Pages pending DNS CNAME setup (see `docs/dns-setup.md`).
