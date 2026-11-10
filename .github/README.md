# GitHub Actions

The owner chose local development with placeholders first. CI uses local data
and requires no account credentials. Remote sync and deployment remain disabled
until the owner configures the requirements below and explicitly enables them.

## CI

`ci.yml` runs on pushes to `main`, pull requests, and manual dispatch. It installs
the locked dependencies using the Node version in `.node-version`, prepares the
local D1 sample catalogue, checks types and source boundaries, runs the
source/image/sync/database tests,
builds the Workers app, and runs the production browser smoke test with managed
Chromium. Browser reports are retained for 14 days when produced. A newer run
cancels an older run for the same pull request.

The action major tags were checked against the official repositories:
`actions/checkout@v7`, `actions/setup-node@v7`, and `actions/upload-artifact@v7`.
They use Node 24 internally. The application version stays pinned separately.

## Daily sync and optional deployment

`nightly.yml` schedules a run at **08:30 UTC daily** and accepts manual dispatch.
GitHub schedules can be delayed; the cron is not a guaranteed exact start time.
Runs are serialised to prevent overlapping catalogue writes.

The remote job runs only on `main` and only when the repository Actions variable
`SCREENPEEK_SYNC_ENABLED` is exactly `1`. Leaving it absent keeps both scheduled
and manually dispatched remote jobs skipped. No workflow creates Cloudflare
accounts, databases, namespaces, buckets, or paid resources.

Before enabling remote sync, the owner must:

1. Create the approved Cloudflare resources and supply their IDs in environment
   settings; prepare the generated production configuration and apply the schema/migrations remotely.
   Use a remote database without the development seed.
2. Configure the repository Actions secrets securely:
   - `TMDB_READ_TOKEN` (preferred), or `TMDB_API_KEY`.
   - `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `D1_DATABASE_ID`, `KV_NAMESPACE_ID`.
   - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
   - Optional failure alerts: `TELEGRAM_BOT_TOKEN`, `OWNER_CHAT_ID`.
   - `CLOUDFLARE_ZONE_ID` is passed through for later cache-purge wiring.
3. Set the repository Actions variables `R2_BUCKET` (defaults to `posters`),
   `R2_PUBLIC_BASE` (owned custom image domain), and `SITE_URL` to the actual resources. `TMDB_BASE_URL` is optional;
   leave it absent to use the documented source default.
4. Set `SCREENPEEK_SYNC_ENABLED=1` and manually dispatch the workflow with
   **deploy unchecked** to verify the real import and image storage first.

Manual `ids` input accepts comma-separated entries such as
`movie:123,tv:456,person:789`. It is passed through an environment variable and a
quoted Bash array to the CLI, which validates it. The workflow does not evaluate
the input as shell code. An empty input runs the normal daily collectors.

After sync succeeds, the workflow builds the app. Deployment is a separate step
of the same job so it uses that exact generated output. It runs only when
`SCREENPEEK_DEPLOY_ENABLED=1` **and** the event is scheduled or the manual
`deploy` checkbox is selected. The manual checkbox defaults to false. Remote sync
still changes D1/R2 when deployment is unchecked.

Deployment uses the approved **Workers with static assets** target. `astro build`
writes `.wrangler/deploy/config.json`. The guarded `npm run deploy` prepares
`dist/server/wrangler.json` from real binding IDs/public settings, selects production
indexing, preserves platform variables and encrypted secrets, and refuses incomplete
Phase 1 checklists. It does not use the obsolete Pages deployment command.
The token must have the minimum permissions for the configured remote operations;
deployment additionally needs Workers script deployment access. Do not enable a
paid plan or provide credentials in source files or workflow input text.

## Later Phase 1 gates

Task 1.23 will add the catalogue snapshot/static-tier preparation and the
15,000-file build guard. Task 1.24 will add the measured first-screen byte and
Lighthouse checks to CI. These gates are not claimed by the current scaffold
workflow. Cache purge after nightly deployment is also pending its implementation.
The daily backup workflow belongs to task 1.34 and has not been added here.
