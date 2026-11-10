# ScreenPeek

Movie and TV information system — catalogue, cast, trailers and per-country
watch providers. Information only: nothing to download.

Built for speed and zero visitor-triggered API calls. A nightly sync refreshes
the catalogue from TMDb into ScreenPeek's own database; visitors are served
entirely from that store and from poster images hosted on Cloudflare R2.
First screen is roughly 100 KB of ScreenPeek's own bytes.

## What is inside

- Public site: home, movie/TV hubs and lists, title detail, full cast, person
  pages, where-to-watch (per country), trailer pages, search.
- Admin panel (behind Cloudflare Access): content, links, ads, sync, SEO,
  media, trust pages and requests, alerts, users, backups, settings, tools.
- Nightly sync (GitHub Actions): imports new and changed titles, copies
  posters to R2 once, rebuilds the static tier.
- Daily D1 backup to a private R2 bucket.

## Stack

Astro (SSR + static tier) on Cloudflare Workers with Static Assets,
D1 (catalogue), KV (configuration), R2 (images and backups),
GitHub Actions (sync, backup, CI, deploy).

## Local development

Use Node 24 (pinned in `.node-version`).

- `npm ci` — install dependencies.
- `npm run db:setup` — apply the schema and removable synthetic samples to
  local D1 only. `npm run db:remove-seed` removes only those fixtures.
  See `db/README.md` for the database workflow.
- `npm run dev` — local development server.
- `npm run typecheck` — TypeScript and Astro template checks.
- `npm run build` — Cloudflare Workers SSR and static output in `dist/`.
- `npm run preview` — serve the built application with local Cloudflare
  bindings.
- `npm run test:scaffold` — production browser smoke test after building.
  Uses system Chromium by default; set `CHROMIUM_PATH` to another executable.

Keep real credentials in ignored `.env` / `.dev.vars` files or in platform
settings — never in Git. `.env.example` lists every variable name the system
expects.

## Deployment

`npm run deploy:dry-run` is offline. `npm run deploy` is guarded: it refuses
to run until the Phase 1 checklist in `TASKS.md` is complete, deployment is
explicitly enabled (`SCREENPEEK_DEPLOY_ENABLED=1`), and the required
Cloudflare credentials are present in the environment. Production binding
preparation never embeds credentials into the generated configuration.

## Data and attribution

This product uses the TMDb API but is not endorsed or certified by TMDb.
Watch-provider data is supplied by JustWatch. See `THIRD-PARTY-NOTICES.md`.
