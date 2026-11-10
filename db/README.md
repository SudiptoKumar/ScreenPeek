# Local sample database

The base `schema.sql` is copied unchanged from `templates/schema.sql`. Future
schema changes belong in additive migrations. The base schema does not contain
relationship foreign keys, so fixture removal explicitly clears dependent rows.

Use Node 24 and run from `/workspace/ScreenPeek` (or the checkout root locally):

```sh
npm run db:setup
npm run dev
```

`db:setup` applies the schema and the sample seed to **local** Wrangler D1. It
does not create a remote account, resource, or database. Astro dev and these
commands share `.wrangler/state` beneath the project root. Keep that directory
ignored. Explicit `--persist-to` paths refer to its root, not the `v3` child.

The equivalent commands are:

```sh
node scripts/tool.mjs wrangler d1 execute DB --local --persist-to .wrangler/state --file db/schema.sql
node scripts/tool.mjs wrangler d1 migrations apply DB --local --persist-to .wrangler/state
mkdir -p .cache
node db/seed.mjs > .cache/sample-seed.sql
node scripts/tool.mjs wrangler d1 execute DB --local --persist-to .wrangler/state --file .cache/sample-seed.sql
```

There are 50 **fictional, explicitly labelled sample titles**: 30 movies and 20
TV series, 12 fictional people, cast/creator credits, 40 seasons and 120
episodes, and sample providers covering US/GB/CA/AU. Some titles intentionally
have no providers. Dates and text vary; timestamps are explicit UTC ISO values.
Images, trailers and ratings are empty. All titles start with `quality_gate=0`;
synthetic metadata with missing images must not enter a production sitemap.
There are no real API calls, admin users, ad codes, or monetised destinations.

On a migrated local database the helper also creates a clearly labelled six-title
sample collection. It attaches fixtures only when its own collection marker is
present; a pre-existing unowned collection with that slug is preserved. Shared
lookup rows remain empty after fixture removal, with counts refreshed.

`seed-manifest.json` reserves negative IDs and owns fixtures through the
`dev:sample_data` config marker. Reruns preserve existing fixture edits and
rebuild their FTS rows without creating duplicates. A conflicting reserved ID
or changed ownership marker aborts the seed before fixtures are changed.

## Remove the seed before connecting live data

```sh
npm run db:remove-seed
```

Removal clears only manifest-owned sample titles and their dependent records,
then removes the ownership marker. Unrelated rows remain. Sample people still
referenced by nonfixture titles remain. Shared genre/language lookup rows stay,
with their counts recomputed from the remaining visible catalogue. A missing or
changed ownership marker prevents fixture deletions. Reseeding is supported.

Do not import sample SQL into production. Creating remote resources requires
the owner's Cloudflare account and approval. Once a real D1 exists, replace the
placeholder database ID in `wrangler.toml`, then apply **only** the base schema:

```sh
node scripts/tool.mjs wrangler d1 create movie-db
node scripts/tool.mjs wrangler d1 execute DB --remote --file db/schema.sql
node scripts/tool.mjs wrangler d1 migrations apply DB --remote
```

`d1 create` creates a real Cloudflare resource; it is not needed for local
development. Never use `--remote` with the sample seed or sample removal file.

`npm run test:database` uses an isolated actual local D1 instance and verifies
repeatability, search indexing, safe removal, reseeding and collision refusal.

The npm seed/removal helpers also maintain additive taxonomy/collection relations
when migrations are present. Prefer those helpers over applying the base removal
SQL file directly to a migrated database.
