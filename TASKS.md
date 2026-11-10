# TASKS — build checklist (tick as verified, not just written)

## Phase 1 — MVP
- [x] 1.1 Astro + TS scaffold, repo structure, base layout, single CSS, AdSlot placeholder component
- [x] 1.2 `db/schema.sql` applied locally; seed script (~50 sample titles) + seed removal note
- [x] 1.3 `sync/tmdb.ts` client (Bearer auth, 429 backoff, concurrency cap)
- [x] 1.4 Sync: changes + discovery collectors, filter, bundled detail fetch, transform + slugs
- [x] 1.5 Poster pipeline: R2 upload, WebP w185/w500 + profile w185 + backdrop w300 (sharp), idempotent
- [x] 1.6 Sync: D1 upserts, lookup counts, FTS update, sync_log, Telegram failure alert
- [x] 1.7 Workflows: `sync.yml` (daily 08:30 UTC + dispatch), `ci.yml` (typecheck + build)
- [x] 1.8 Home page (sections per design doc) + movies/series lists with filters + pagination
- [x] 1.9 Detail pages (movie + TV) with fixed anatomy; ratings strip; verdict widget; gallery
- [x] 1.10 TV season + episode pages
- [x] 1.11 Cast/person pages with filmography
- [x] 1.12 Genre / collection / language grids; `/new/`, `/top10/`, `/upcoming/`
- [x] 1.13 Trailer page (click-to-load YouTube facade) + similar rail
- [x] 1.14 Search: `/api/search` (FTS5) + suggestions UI + `/search/` results
- [x] 1.15 Watch page: geo country, provider groups, `/go/` outbound, JustWatch credit, no popunder
- [x] 1.16 `/go/[slug]` function: KV rules (country/device), batched click log, safe fallbacks
- [x] 1.17 `/api/vote` + My List/history (localStorage) + `/mylist/`
- [x] 1.18 Ads: slot resolution from KV, popunder session cap, Social Bar global slot, preview-safe placeholders
- [x] 1.19 Admin: Dashboard, Link Manager, Ad Manager, Content (pin/hide), Sync (status + run-now), Settings, Backup export
- [x] 1.20 Trust pages (About with TMDb attribution, Privacy, DMCA, Contact) + styled 404
- [x] 1.21 SEO: meta/OG/JSON-LD, dynamic sitemaps, robots.txt, noindex gating
- [x] 1.22 Deploy prep: `DEPLOY-CHECKLIST.md`, Cloudflare bindings wired, Phase 1 verification list run + reported
- [x] 1.23 Hybrid static tier: nightly workflow = sync → prerender hubs + top `static_top_n` titles → deploy; build fails if static files > 15,000
- [x] 1.24 CI speed gate: byte-budget hard fail (>~100 KB first screen) + Lighthouse mobile ≥90 report on home/detail/list (ads as placeholders)
- [x] 1.25 Speculation-rules prefetch on grids + CSS fade-in (no JS files added)
- [ ] 1.26 R2 custom domain + immutable 1-year cache headers; width/height on all images (CLS 0)
  - Code complete; live custom-domain verification deferred to the deployment phase (owner deferred domain purchase; deployment setup is handled separately after Phase 1).
- [x] 1.27 Detail originality: facts line + Q&A block (+ FAQ schema) + "Updated" date; schema set WITHOUT third-party aggregateRating
- [x] 1.28 Filter/sort URL control: noindex + canonical to clean URL (local routes verified; custom-domain edge rule deferred in VERIFICATION.md)
- [x] 1.29 Redirects table honoured before render (301); owner-deleted titles → 410; 404s logged to `notfound_log`
- [x] 1.30 OG cards: sync composes 1200×630 for gated titles → R2 `og/`; detail OG tags wired
- [x] 1.31 Poster colour: sync extracts dominant colour; placeholders + detail tint; scroll-snap swipe rows (Trending, Cast)
- [x] 1.32 "Streaming on" logo strip on detail (first 3 + "+N more")
- [x] 1.33 Admin v2: cache purge on save (+ Dashboard retry), `admin_log` change history with Undo, duplicate ad-code warning, SEO tab (redirects, 404 log, overrides, verification values), Dashboard free-limit meter + Search Console/Lighthouse cards
- [x] 1.34 `backup.yml`: daily D1 + config export to R2 `backups/` (keep 14)
- [x] 1.35 Admin universal powers (ADMIN-PANEL §A): search/filter/sort/CSV, bulk edit, soft-delete → Trash (30-day, restore, "used in N places"), scheduling on links/ads/pins, actor-stamped history
- [x] 1.36 Not-working report (core checks: sync failures, missing poster/overview, empty/duplicate slots, visited 404s, quota > 80%) with Fix deep links
- [x] 1.37 Titles & People editor core: field edit + locks vs sync, pin/hide/delete (+ blocklist), re-fetch/import by TMDb ID via workflow dispatch, reset votes
- [x] 1.38 Admin Tools module: global search, preview-as-visitor (country cookie + device frame), run-any-job buttons; Settings & Health: secrets set/not-set panel, cache TTL settings

## Phase 2 — Growth
- [ ] 2.1 Link splits (A/B %) + full rule precedence + per-destination click stats
- [ ] 2.2 Admin Stats via Adsterra Publisher API + Dashboard revenue card
- [ ] 2.3 Telegram auto-posting after successful syncs (capped, toggleable)
- [ ] 2.4 `/on/<provider>/` landing pages (country-aware)
- [ ] 2.5 Per-country release date + certification on detail pages
- [ ] 2.6 External ratings weekly job + strip rendering (only if owner enables the flag)
- [ ] 2.7 Performance/quota optimisation pass with measured numbers reported
- [ ] 2.8 New pages: `/year/<yyyy>/`, `/movies-like/<slug>/`, `/tv/calendar/` (SEO-gated, in sitemaps)
- [ ] 2.9 Core Web Vitals polish: CrUX/RUM review in admin Stats; fix the worst template first
- [ ] 2.10 Tracking module: CF GraphQL analytics (page type/title/country/device/referrer), search_log top + zero-result searches, drop alerts (>40% vs 7-day avg → Telegram)
- [ ] 2.11 Media Files module: R2 browse/replace/delete, missing + unused finders, storage meter; link health-check workflow → Not-working report
- [ ] 2.12 Requests inbox: Turnstile-protected contact + takedown forms → `inbox`, one-click hide title
- [ ] 2.13 Alerts & Reports: per-event toggles, Telegram digest (daily/weekly), Telegram posting history
- [ ] 2.14 Users & Access: `admin_users` roles (Owner/Editor/Ads/Viewer) + per-module switches, server-side checks; seasons/episodes full editing

## Phase 3 — Scale
- [ ] 3.1 Push notifications (opt-in, follows, sync triggers)
- [ ] 3.2 Trivia step pages from stored metadata
- [ ] 3.3 Monthly reconciliation via TMDb Daily ID Exports (report-only deletes)
- [ ] 3.4 Quota monitoring + Workers Paid upgrade decision pack (owner approves any spend)
- [ ] 3.5 Hardening: dependency audit, backup restore drill, Access policy re-check
