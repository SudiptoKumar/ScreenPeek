# ScreenPeek

Movie and TV information system. Read `AGENTS.md`, `PRD.md`, `docs/`, and
`TASKS.md` before changing the implementation. Phase 1 is in progress.

## Local development

Use Node 24 (pinned in `.node-version`). Run `npm ci`, `npm run db:setup`, then `npm run dev`.
`npm run typecheck` checks TypeScript and Astro templates; `npm run build`
produces the Cloudflare Workers SSR and static output in `dist/`.
`npm run preview` serves the built application with local Cloudflare bindings.

`npm run test:scaffold` runs the production browser smoke test after building.
It uses system Chromium by default; set `CHROMIUM_PATH` to another executable.

`npm run db:setup` applies the supplied schema and removable synthetic samples
to local D1 only. `npm run db:remove-seed` removes only those fixtures. See
`db/README.md` for the database workflow and `npm run test:database` for
repeatability/removal checks.

Tool caches and local Cloudflare state stay in ignored directories. Keep real
credentials in ignored `.env` / `.dev.vars` files or platform settings, never Git.

The owner approved Workers hosting in place of Pages so current patched Astro
packages can be used. See `VERIFICATION.md` and `docs/DECISIONS.md`.
Nothing has been deployed or pushed.

Deployment preparation and owner-only account steps are in
[`DEPLOY-CHECKLIST.md`](DEPLOY-CHECKLIST.md). `npm run deploy:dry-run` is offline;
`npm run deploy` is guarded and remains disabled until Phase 1 is complete and
the owner explicitly enables deployment. Production binding preparation never
embeds credentials into the generated configuration.
