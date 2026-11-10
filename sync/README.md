# Daily importer

Run from the repository root using Node 24. All TMDb source URL knowledge stays
in `tmdb.ts`; public routes must never import any module from this directory.

## Offline development

```sh
npm run sync:fixture -- --init --state .cache/fixture-validation
npm run sync:fixture -- --state .cache/fixture-validation
```

This uses 50 explicitly fictional titles and generated solid-colour images,
actual local D1/R2 bindings, and no API keys or outbound content requests. The
state path is separate from the normal development seed. The second run adds
zero new rows. `--init` is repeatable and applies the base schema plus tracked
additive migrations. Fixture mode refuses `--remote`.

For the default development seed use `npm run db:setup`; remove those fixtures
before connecting live data. See `db/README.md`.

## Real source, only after configuring credentials

```sh
npm run sync:run -- --local
npm run sync:run -- --remote
npm run sync:run -- --remote --ids movie:123,tv:456,person:789
```

The first command requires a TMDb token but writes only local D1/R2. Remote mode
requires TMDb, Cloudflare D1 and R2 credentials from `.env`/platform settings as
listed in `.env.example`. Never put values on the command line or in Git.
Node uses the inherited proxy and CA trust with TLS verification enabled.

Import is upsert-based, keeps stable slugs and manual field locks, checks the
owner blocklist and deletion state, copies images once, updates FTS and taxonomy
counts, and writes a sync log. The default title limit is 2,000; a conservative
50,000-row-write budget and 12-minute processing budget defer remaining work.
Failures retain queued candidates; a 404 hides a title rather than deleting it.
The catch-up window extends to 14 days; older gaps are reported for manual
reconciliation. Telegram failure alerts are skipped silently unless configured.

Exit codes: 0 = completed or partial, 1 = failed. Partial/deferred status remains
explicit in the JSON result, sync log and optional owner alert. A workflow must
report partial work honestly while allowing successfully imported metadata to
deploy. Image errors use placeholders and are reported; they do not fail a run.

`npm run test:sync`, `npm run test:images` and `npm run test:sync-integration`
exercise the offline workflow. Live REST batching rollback, numeric/null binding
roundtrips, real TMDb authentication and actual S3 uploads remain unverified
until credentials are provided; local binding transactions are verified.
