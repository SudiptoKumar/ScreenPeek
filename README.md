<a name="top"></a>
<div align="center">

<img src="assets/hero.svg" width="100%" alt="ScreenPeek — a neon edge-network cinema portal: Movies & TV at a glance. 0 visitor API calls, first screen under 100 KB, Lighthouse 90+." />

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=500&size=20&duration=3000&pause=1000&color=8B5CF6&center=true&vCenter=true&width=640&height=44&lines=Cast+%C2%B7+Trailers+%C2%B7+Ratings;Where+to+watch+%E2%80%94+US+%C2%B7+GB+%C2%B7+CA+%C2%B7+AU;Zero+visitor-triggered+API+calls;First+screen+under+100+KB" alt="Cast, trailers, ratings. Where to watch. Zero visitor-triggered API calls. First screen under 100 KB." />

<img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
<img src="https://img.shields.io/badge/Astro-7-BC52EE?style=for-the-badge&logo=astro&logoColor=white" alt="Astro 7" />
<img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript strict" />
<img src="https://img.shields.io/badge/D1-SQLite%20%2B%20FTS5-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="D1 SQLite with FTS5" />
<img src="https://img.shields.io/badge/Lighthouse-%E2%89%A5%2090-F44B21?style=for-the-badge&logo=lighthouse&logoColor=white" alt="Lighthouse 90 or higher" />
<img src="https://img.shields.io/badge/Node-24-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 24" />

**A fast, information-only movie & TV catalogue — cast, trailers, ratings and per-country where to watch — built on Cloudflare's edge.**

[Highlights](#highlights) · [Features](#features) · [Architecture](#architecture) · [Quick start](#quick-start) · [Admin](#admin-panel) · [Automation](#automation) · [Go live](#go-live) · [Status](#status) · [Security](#security) · [Docs](#docs)

</div>

> [!NOTE]
> ScreenPeek never streams, hosts, or links to downloads. A scheduled job copies catalogue data from [TMDb](https://www.themoviedb.org/) into ScreenPeek's own database, and visitors are served entirely from that store plus poster images on Cloudflare R2 — **no visitor request ever triggers a call to the TMDb API.**

<img src="assets/divider.svg" width="100%" alt="" />

<a name="highlights"></a>
<h2 align="center">⚡ Highlights</h2>

<table>
  <tr>
    <td width="33%" valign="top">🔌 <b>Zero visitor-triggered API calls</b><br/>Visitors read D1 / KV / R2 only. CI fails the build if visitor code references TMDb URLs or imports from <code>sync/</code>.</td>
    <td width="33%" valign="top">⚡ <b>Speed budget, enforced in CI</b><br/>First screen stays under <b>100,000 bytes</b>, and Lighthouse mobile scores <b>≥ 90</b> on home, detail and list pages.</td>
    <td width="33%" valign="top">🧱 <b>Hybrid static + SSR</b><br/>Hubs and the top-N titles (3,000 by default) are pre-rendered; the long tail is server-rendered at the edge with Cache API caching.</td>
  </tr>
  <tr>
    <td width="33%" valign="top">🖼️ <b>Owned images</b><br/>Posters become WebP once, live in R2 with 1-year <code>immutable</code> caching and ship from an owned custom domain.</td>
    <td width="33%" valign="top">🛠️ <b>Full admin panel</b><br/>Behind Cloudflare Access: links, ads, content, SEO, sync, backups, history with undo, trash and a health report.</td>
    <td width="33%" valign="top">🪙 <b>Built for free-tier limits</b><br/>A write governor for D1's 100,000 rows/day, a 15,000-file static cap and buffered click / vote counters.</td>
  </tr>
</table>

<img src="assets/metrics.svg" width="100%" alt="Live gauges: first-screen budget under 100 KB enforced in CI, Lighthouse mobile 90+ on home, detail and list pages, and zero TMDb calls on any visitor request." />

<a name="features"></a>
<h2 align="center">🛰️ Features</h2>

<table>
  <tr>
    <td width="50%" valign="top">🧭 <b>Browse</b><br/>Configurable home, movie & TV pages, seasons & episodes, people with filmography, genre / collection / language hubs, top 10, new and upcoming.</td>
    <td width="50%" valign="top">🎯 <b>Decide</b><br/>Ratings strip, cast, gallery, similar titles, click-to-load trailers, and per-country where to watch (Stream · Free · Rent · Buy for US · GB · CA · AU, credited to JustWatch).</td>
  </tr>
  <tr>
    <td width="50%" valign="top">🗳️ <b>Interact</b><br/>Instant search (SQLite FTS5), Must Watch / Good / Average / Skip verdict votes (one per title per day) and a browser-only My List. No accounts.</td>
    <td width="50%" valign="top">🔎 <b>Get found</b><br/>Canonical URLs, Open Graph / Twitter cards with a generated 1200×630 share card per title, JSON-LD, split sitemaps, <code>noindex</code> gating, plus editable About / Privacy / DMCA / Contact pages.</td>
  </tr>
</table>

<img src="assets/divider.svg" width="100%" alt="" />

<a name="architecture"></a>
<h2 align="center">🧬 Architecture</h2>

<img src="assets/architecture.svg" width="100%" alt="Animated system map: TMDb feeds a server-side GitHub Actions sync, which writes D1 and R2 and triggers a build; the build deploys static HTML and an Astro SSR Worker on Cloudflare's edge; visitors read static pages or the Worker, admins enter through Access plus JWT plus a role row, and the Worker reads D1, KV and R2 read-only." />

**Stack** — Astro 7 · Cloudflare Workers with Static Assets · D1 (SQLite + FTS5) · KV · R2 · `sharp` · TypeScript (strict) · `node:test` + Playwright · GitHub Actions.

<details>
<summary><b>Static diagram (Mermaid)</b></summary>

```mermaid
flowchart TB
    TMDB(["TMDb API"])
    V(("Visitor"))
    ADM(["Admin"])
    subgraph GH["GitHub Actions"]
        SYNC["Sync — collect · transform · images"]
        BUILD["Build — freeze the static tier"]
    end
    subgraph EDGE["Cloudflare edge"]
        STATIC["Static HTML — served without the Worker"]
        SSR["Astro SSR Worker + Cache API"]
    end
    subgraph DATA["Cloudflare storage"]
        D1[("D1 catalogue")]
        KV[("KV config · links · ads")]
        R2[("R2 posters")]
    end
    TMDB -.->|server-side only| SYNC
    SYNC --> D1 & R2
    SYNC --> BUILD
    BUILD -->|deploy + purge| STATIC & SSR
    V --> STATIC & SSR
    ADM -->|Access + JWT + role| SSR
    SSR -.->|visitors: read-only| D1
    SSR -.-> KV & R2
```

</details>

<h3 align="center">🔁 Sync pipeline</h3>

<img src="assets/pipeline.svg" width="100%" alt="The sync pipeline flows through six stages: collect, filter, fetch, transform, images, persist. Idempotent, at most 2,000 titles and 25 minutes per run, with a D1 write governor; overflow defers to the next run." />

`collect` → `filter` → `fetch` → `transform` → `images` → `persist`. Idempotent and budgeted (≤ 2,000 titles and 25 minutes per run, plus a daily D1 write governor); work that doesn't fit is deferred to the next run. Only titles that pass the **quality gate** (poster, overview, popularity, cast or providers) reach listings, sitemaps and static pages.

<img src="assets/divider.svg" width="100%" alt="" />

<a name="quick-start"></a>
<h2 align="center">🚀 Quick start</h2>

<img src="assets/terminal.svg" width="100%" alt="Terminal demo: npm ci, npm run db:setup, npm run dev — the dev server starts in sample mode with local D1, KV and R2 bindings at http://localhost:4321." />

```bash
npm ci                # install the locked dependencies
npm run db:setup      # local D1: schema + migrations + 50 fictional sample titles
npm run dev           # dev server → http://localhost:4321
```

Needs **Node.js 24** (pinned in `.node-version`) — no Cloudflare or TMDb account for local work. While sample data is present the site runs in **sample mode** (`noindex`); run `npm run db:remove-seed` before importing real data, and **never apply the seed to a remote database**.

| Command | What it does |
| --- | --- |
| `npm run build` · `npm run preview` | Build the Worker + static tier into `dist/`, then serve it with local bindings |
| `npm run sync:fixture` | Offline importer rehearsal with fictional data — no keys, no network |
| `npm run sync:run -- --local` | Real TMDb import into local D1 / R2 (add `TMDB_READ_TOKEN` to `.env`) |
| `npm run check:boundaries` | Fails if visitor code references TMDb or imports `sync/` |
| `npm run check:performance` | 100 KB first-screen gate + Lighthouse mobile ≥ 90 |
| `npm run test:browser` | All Playwright specs (run after `npm run build`) |

**Quality gates:** 43 `node:test` files, 28 Playwright specs, the boundary check and the performance gate. The exact CI order lives in `.github/workflows/ci.yml`.

<a name="admin-panel"></a>
<h2 align="center">🛡️ Admin panel</h2>

<div align="center">

Lives at `/admin/` and is **triple-locked**: `Cloudflare Access → signed-JWT verification in the Worker → role row in admin_users`

<img src="https://img.shields.io/badge/OWNER-7C3AED?style=flat-square" alt="Owner role" />
<img src="https://img.shields.io/badge/EDITOR-22D3EE?style=flat-square" alt="Editor role" />
<img src="https://img.shields.io/badge/ADS-FBBF24?style=flat-square" alt="Ads role" />
<img src="https://img.shields.io/badge/VIEWER-64748B?style=flat-square" alt="Viewer role" />

</div>

- **Modules** — Dashboard (revenue, free-tier meters, health) · Links & Offers · Ads · Show / Hide · Info Pages · Sync · Settings · Backup · SEO · Title & People editors · History · Tools.
- **Undo & audit** — every change is logged with actor and before / after values; one-click undo where safe.
- **Trash** — soft-delete, restorable for 30 days; deleted titles return `410` and are blocklisted so sync can't resurrect them.
- **Conflict-proof** — edits carry a `revision` and stale forms are rejected; field locks stop sync from overwriting manual edits.
- **Reliable propagation** — every save mirrors to KV and purges the cache through a retryable outbox.
- **Health report** — failed syncs, missing posters, empty ad slots, hot 404s and quota usage, each with a **Fix** link.

<a name="automation"></a>
<h2 align="center">🤖 Automation</h2>

Remote jobs ship **disabled**: they run only on `main` once the repository variable `SCREENPEEK_SYNC_ENABLED` is `1` (backups use `SCREENPEEK_BACKUP_ENABLED`).

| Workflow | Runs | Does |
| --- | --- | --- |
| `ci.yml` | Push to `main`, PRs, manual | Typecheck → boundaries → test suites → build → static-tier checks → performance gates → Playwright. No credentials needed. |
| `nightly.yml` | Every 3 h (UTC), manual | Sync from TMDb → build the static tier → optional deploy + cache purge |
| `backup.yml` | Daily 09:15 UTC, manual | Private D1 + config backup to a separate R2 bucket; newest **14** kept |
| `money.yml` | Every 30 min, manual | Adsterra stats → D1, Telegram revenue alerts |

Admin **Restore** covers configuration tables only. To recover the catalogue, gunzip a snapshot and apply its `sql` field to a fresh D1 (verified by `tests/backup-roundtrip.test.ts`). One-off ops workflows: `db-bootstrap.yml`, `go-live.yml`, `pacing-fix.yml`, `admin-diagnose.yml`.

<img src="assets/divider.svg" width="100%" alt="" />

<a name="go-live"></a>
<h2 align="center">🛰️ Go live</h2>

Target: **Workers with Static Assets** (not Pages). Deployment is gated on purpose.

1. **Create** a Worker, a D1 database `movie-db`, a KV namespace, a public R2 bucket on an owned custom domain, a separate private R2 bucket for backups, and a Cloudflare Access app.
2. **Configure GitHub** — add the repository secrets and variables (credentials, resource IDs, buckets, `SITE_URL`, the `SCREENPEEK_*_ENABLED` switches; names are in `.env.example`). Leave `SCREENPEEK_SYNC_ENABLED` unset for now.
3. **Bootstrap** — run `db-bootstrap.yml` against a database without sample data, set the Worker secrets with `wrangler secret put`, and add your first `admin_users` owner row.
4. **Verify, then ship** — set `SCREENPEEK_SYNC_ENABLED=1`, run the daily sync manually with deploy unchecked (remote sync still writes to D1 / R2), then `npm run deploy`.

> [!WARNING]
> `npm run deploy` refuses to run unless deploy is enabled, every Phase 1 task in `TASKS.md` is ticked, tokens and IDs are real, `R2_PUBLIC_BASE` is an owned custom domain (not `r2.dev`, `workers.dev` or `pages.dev`), the backup bucket is separate and private, and the static tier was built from the real catalogue (≤ 15,000 files).

Want a look first? `go-live.yml` launches a `noindex` preview on `workers.dev` — edit its owner-specific values first (see **Forking** below).

<a name="status"></a>
<h2 align="center">📡 Status</h2>

| Phase | Focus | State |
| --- | --- | --- |
| 1 · MVP | Catalogue, sync, admin, CI, backups | **37 / 38 tasks.** The last one, **1.26** (live R2 custom-domain check), is what currently blocks `npm run deploy` — use `go-live.yml` for a preview until a domain is configured. |
| 2 · Growth | Link A/B splits · Telegram auto-posting · `/on/<provider>/` pages · external ratings · analytics · media manager · request inbox | Planned |
| 3 · Scale | Push notifications · trivia pages · monthly TMDb reconciliation · quota monitoring · hardening | Planned |

<a name="security"></a>
<h2 align="center">🔐 Security &amp; privacy</h2>

<table>
  <tr>
    <td width="50%" valign="top"><b>🔐 Security</b><br/><br/>
      • Credentials live only in env, GitHub secrets or Worker secrets — deploy tooling refuses secret-like Wrangler vars<br/>
      • Admin = Access <b>and</b> JWT verification <b>and</b> a role row<br/>
      • Same-origin checks and streamed body-size caps on mutating routes<br/>
      • HTTPS-only outbound redirects; Markdown rendered with raw HTML disabled<br/>
      • Upstream error bodies are never logged or echoed; TMDb requests never follow redirects
    </td>
    <td width="50%" valign="top"><b>🕶️ Privacy</b><br/><br/>
      • No accounts — My List, history and vote markers live in <code>localStorage</code><br/>
      • Votes use a daily hash, with no per-voter records<br/>
      • Trailers load YouTube only after a click<br/>
      • Country preference is a 30-day cookie<br/>
      • With ads enabled, ad networks may process request data under their own policies — review the editable Privacy page
    </td>
  </tr>
</table>

<details>
<summary><b>🍴 Forking? Review these owner-specific values first</b></summary>
<br/>

- `.github/workflows/go-live.yml` — `SITE_URL`, `OWNER_EMAIL`, bucket names, Telegram webhook URL, `GITHUB_REPO` (the default `GITHUB_REPO` also lives in `scripts/deploy-config.mjs` and `.env.example`)
- `scripts/money_check.py` — `DOMAIN_ID`, `EPOCH` · `src/components/admin/AdminPanel.astro` — Adsterra placement IDs and labels
- `public/sw.js` — an ad-network service-worker stub that imports a third-party script: replace or remove it if you don't use that network
- `sync/engine.ts` — pacing rules (12-episode series limit, 5,000 / 2,000 title goals, 5 : 1 interleave)
- `db/migrations/005-trust-pages.sql` — default About / Privacy / DMCA / Contact text
- `wrangler.toml` — placeholder resource IDs and names · `.github/workflows/pacing-fix.yml` — one-time owner job, delete when not needed
- `src/lib/admin/*` — admin dates are shown in Bangladesh time (UTC+6) and stored as UTC

</details>

<img src="assets/divider.svg" width="100%" alt="" />

<a name="docs"></a>
<h2 align="center">📚 Docs</h2>

| Where | What |
| --- | --- |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Full reference — env vars, runtime settings, database, sync pipeline, routes, admin roles, backups, troubleshooting |
| [db/README.md](db/README.md) · [sync/README.md](sync/README.md) · [.github/README.md](.github/README.md) | Sample DB & seed rules · importer usage & exit codes · workflow notes (the workflow files win if they differ) |
| [.env.example](.env.example) · [TASKS.md](TASKS.md) · [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | Every env variable name · phase checklist · asset licences & attribution |

<a name="attribution"></a>
<h2 align="center">🎬 Attribution &amp; licence</h2>

This product uses the TMDb API but is not endorsed or certified by TMDb. Movie, TV and people metadata and images originate from TMDb. Watch-provider data is supplied by **JustWatch** and credited wherever it appears. The TMDb logo (`public/tmdb.svg`) is distributed by Simple Icons under CC0-1.0; brand trademarks remain the property of their owners. See `THIRD-PARTY-NOTICES.md`.

No `LICENSE` file is included yet — add one before redistributing the code.

<div align="center">

<a href="#top">↑ Back to top</a>

<img src="assets/footer.svg" width="100%" alt="Built on the edge — Cloudflare Workers · D1 · KV · R2 · Astro" />

</div>
