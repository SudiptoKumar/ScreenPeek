# ScreenPeek design system

The built design language for the public site and the admin panel, as shipped in
the 2026-11 redesign (public "Ambient" design + admin v4 control desk). This file
describes what exists; PRODUCT.md describes what the product is.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0d0d0f` | Page ground (main background) |
| Header | `#151518` | Public header background; admin top bar uses it translucent |
| `--panel` | `#1b1b20` | Cards background, panels, tiles |
| `--panel2` | `#202027` | Raised/inner surfaces, bar tracks |
| `--line` | `rgba(255,255,255,.08)` (site) / `#26262f` | Hairline dividers, borders |
| `--text` | `#f5f5f7` | Primary text |
| `--muted` | `#a2a2ad` | Secondary text, labels |
| `--accent` | `#ff5a5f` | Brand coral: logo, accents, chart fills |
| `--cta` / `--cta-hover` | `#d92f35` / `#c22830` | Primary buttons, play disc |
| `--gold` | `#f5c518` | Ratings only |

Card radius 10–12px (panels 16–18px in admin). Page side padding
`clamp(18px, 4vw, 58px)` on the public site; the admin shell is a 920px column.

## Typography

Archivo, self-hosted as one variable font (`public/fonts/archivo-var.woff2`,
27 KB subset: Latin + the site's symbols), weights 400–900. Display headings are
tight (`letter-spacing: -.02em`), and every figure uses tabular numerals. No
third-party font requests anywhere.

## Hard rules

- **No gradients** as design. The only fades allowed sit on top of photos
  (hero shade, trailer shade). Genre tiles are single solid colours.
- **No emoji in UI.** Icons are Lucide-style inline SVG.
- **No view counters, no My List, no accounts** on the public site.
- Provider identity is shown with real platform logo chips, never coloured
  dots: `.plogo.nf` (black/red), `.plogo.pv` (navy `#0b2239` / `#00a8e1`),
  `.plogo.ap` (white/black), `.plogo.amz` (`#232f3e` / white).
- Genre colours are one shared map (`genreTileColor` in `src/lib/catalogue.ts`)
  used by the home page and the genres page: Drama `#6d4bd8`, Animation
  `#d6336c`, Crime `#0e7c86`, Comedy `#c77400`, Action `#d92f35`,
  Science Fiction `#2470c9`, plus a five-colour fallback rotation.
- Admin labels that tests depend on (e.g. `{page} / {placement}`,
  "Duplicate code also used") are load-bearing copy — never rename them
  casually.

## Public site patterns

- **Ambient hero** (home + detail): backdrops are stored small, so the backdrop
  is shown heavily blurred and darkened as a colour field while the sharp
  poster carries focus. One `<picture>` per hero — phones get the w185 poster,
  wide screens w500 — so a viewport downloads exactly one poster. On the detail
  page the backdrop image itself is desktop-only; phones use the poster-colour
  gradient behind the shade.
- **Shelves**: horizontal poster rails with a heading row (title left, "See
  all" right). Trending Movies and Trending Series are separate shelves;
  provider shelves ("New on Netflix", "New on Prime Video", …) carry the
  platform chip in the heading.
- **Poster cards**: poster, title, one meta line (gold star rating · year).
  Nothing else — no counters, no list buttons.
- **Coming Soon**: poster cards with a red release-date tag.
- **Detail page**: hero (poster, title, rating + votes, year, runtime as
  `2h 37m`, credits line "Directed by … · Starring …", genre chips, actions) →
  The Story → Where to Watch → Top Cast → Trailer card → Box Office (fact
  rows) → Seasons (series) → Gallery → Questions & answers
  → More Like This. A "Details" sidebar (fact rows + catalogue facts) sits
  beside the main column on wide screens and stacks below on phones. There is
  no Reviews section (owner decision, 2026-11-14).
- **Fact rows** (`.fact-rows`, `.ledger`): label left in muted, value right,
  semibold, tabular; hairline between rows. This is the standard way to show
  data on both the site and the panel.
- **Ad areas** (owner rules, 2026-11-14): every in-flow area is a stack of up
  to three units from different networks (base + `_b` + `_c` partners;
  partners render only when filled). The home page carries one dedicated
  area directly below each content section (Trending Movies → 300×250 stack,
  Trending Series → native stack, provider shelves → infeed stack, Genres →
  lower 300×250 stack); detail carries four areas; every ad type must be
  visible within the first two pages of the journey. Exactly one popunder
  per visit (detail page only), one sticky bar, and each global format once
  (in-page push may stack one partner). Networks set no per-page cap for
  banner/native units; the stack-of-three and one-popunder limits are ours
  and are not to be exceeded. The Smartlink has exactly two designated
  placements, both labelled Sponsored and routed through `/go/` so clicks
  are tracked: a "Watch Now" button in the detail hero actions and a
  sponsored row above the provider groups on the watch page — each renders
  only while the `smartlink-main` managed link is active. No other button
  or link may be wired to the Smartlink.
- **Trailer**: the detail page shows a 16:9 facade (own image, play badge)
  linking to the trailer page; the trailer page shows the same facade with a
  red play disc and loads the YouTube iframe only on click. No iframe and no
  external request exist before the click.
- **Watch page**: country chips (US / UK / CA / AU, current filled), provider
  groups Stream / Free / Rent / Buy; each provider row shows its logo in a
  white rounded app-style chip. No prices are shown or invented.
- **Lists**: heading, filter panel (Genre / Year / TMDb rating / Sort by —
  server-side), results line with tabular counts, poster grid with one native
  ad unit inside the grid, pagination. Below-fold images load through the
  `data-lazy-src` IntersectionObserver pattern, never native `loading=lazy`
  alone (the byte gate counts what Chrome actually fetches).

## Admin panel patterns (v4 control desk)

Reading screens are **data only**: label → value, short fragments, no
explanatory sentences. No stat tiles. Tables stay tables on desktop; on
phones each row becomes a card of ledger lines — every cell carries a
`data-label`, so a value never appears without its label (the traffic-sheet
rule). The Tracking section follows this in full (owner catch, 2026-11-14:
its overview was still stat tiles and its phone lists showed unlabeled
values).

- **Header**: module heading left; top-right is only a person icon in a circle
  (account email/role live in its tooltip). Module nav, bottom tab bar and the
  More sheet are unchanged from v3.
- **Dashboard order**: since-line (today's revenue · link clicks · last sync)
  → attention strip (only real open problems, links to the health report) →
  **The Vault** → Operations → Progress → Recent changes → health report →
  advanced tools.
- **The Vault**: unpaid balance as the one big figure (labelled an estimate),
  payout progress as a bar with printed figures (never a ring), a ledger of
  Today / Yesterday / This month / Earned all time / Minimum payout, the
  7-day chart with the value printed over every bar, per-format ledger rows,
  and one short fine-print line. **Hide amounts** blurs every figure in the
  Vault (values carry `data-amt`) and persists in `localStorage` (`sp_hide`).
- **Operations**: fragment rows — last sync (status dot + status + Dhaka
  time), link clicks today, publishing state, Cloudflare usage link.
- **Progress**: Movies and Series bars against the sync goals from config
  (`sync_movie_goal` / `sync_series_goal`, complete = poster stored), then
  Titles / People / Ready-for-search-engines rows.

## Performance contract

Every public page must stay under 100,000 bytes of own first-screen resources
at 360×800 with cache off (CI gate, `npm run check:performance`); Lighthouse
mobile performance target ≥ 90. Images are served from R2 as WebP; posters
exist at w185 and w500 only, backdrops at w300.

Admin update (2026-11-14, Claude redesign merged with the owner's rules): the module
nav and the More sheet are grouped — Overview / Money / Website content / System.
The dashboard opens with a today strip (Earned today · Link clicks today · Last sync
with a status dot), then the attention strip, then The Vault — the earnings card
carries a ticket-stub tear line (dashed, notched) between the balance and its ledger.
The Ads module has an All / On / Off / Empty slot filter. Tables in Links, Sync and
Recent changes carry data-labels like Tracking's. The panel stays on the owner's
dark palette and data-only rule: no module ledes, the person chip stays icon-only.
