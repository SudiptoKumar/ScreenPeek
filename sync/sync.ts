import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runSync } from './engine.ts';
import { tmdbFromEnv } from './tmdb.ts';
import { HttpD1 } from './d1.ts';
import { R2Store } from './r2.ts';
import type { Candidate } from './types.ts';

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const local = has('--local');
const remote = has('--remote');
const fixture = has('--fixture');
let dispose: (() => Promise<void>) | undefined;

try {
  if (local === remote || (fixture && !local)) throw new Error('Choose --local or --remote. --fixture is permitted only with --local.');
  const targets: Candidate[] = [];
  const personIds: number[] = [];
  for (const item of (value('--ids') || '').split(',').filter(Boolean)) {
    const match = /^(movie|tv|person):([1-9]\d*)$/.exec(item.trim());
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('IDs must use movie:123,tv:456,person:789 format');
    if (match[1] === 'person') personIds.push(Number(match[2]));
    else targets.push({ id: Number(match[2]), type: match[1] as 'movie' | 'tv', changed: true });
  }
  const client = fixture ? (await import('./fixtures.ts')).fixtureSource() : tmdbFromEnv(process.env);
  let db, images;
  if (local) {
    const state = value('--state') || '.wrangler/state';
    if (has('--init')) {
      for (const command of [
        ['d1', 'execute', 'movie-db', '--local', '--persist-to', state, '--file', 'db/schema.sql'],
        ['d1', 'migrations', 'apply', 'movie-db', '--local', '--persist-to', state],
      ]) execFileSync(process.execPath, ['scripts/tool.mjs', 'wrangler', ...command], { stdio: 'inherit' });
    }
    const bindings = await (await import('./local.ts')).localBindings(resolve(state));
    ({ db, images } = bindings); dispose = bindings.dispose;
  } else {
    const required = (name: string) => { const configured = process.env[name]; if (!configured) throw new Error(`Set ${name} before remote sync`); return configured; };
    db = new HttpD1({ accountId: required('CLOUDFLARE_ACCOUNT_ID'), databaseId: required('D1_DATABASE_ID'), token: required('CLOUDFLARE_API_TOKEN') });
    images = new R2Store({ accountId: required('CLOUDFLARE_ACCOUNT_ID'), bucket: required('R2_BUCKET'), accessKeyId: required('R2_ACCESS_KEY_ID'), secretAccessKey: required('R2_SECRET_ACCESS_KEY') });
  }
  if (fixture) await db.batch([{ sql: "INSERT INTO config(key,value) VALUES('dev:fixture_import','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value" }]);
  // Manual imports may need a longer clock than the engine's 12-minute
  // default; the operator can raise it per run via SYNC_MAX_DURATION_MS,
  // clamped to [1 minute, 25 minutes] so it stays inside the job timeout.
  const requestedDuration = Number(process.env.SYNC_MAX_DURATION_MS);
  const maxDurationMs = Number.isSafeInteger(requestedDuration) && requestedDuration > 0
    ? Math.min(Math.max(requestedDuration, 60_000), 25 * 60_000) : undefined;
  const summary = await runSync({ db, images, client,
    environment: fixture ? {} : process.env,
    source: process.env.GITHUB_EVENT_NAME === 'schedule' ? 'cron' : 'manual',
    targets: targets.length ? targets : undefined, personIds: personIds.length ? personIds : undefined,
    maxDurationMs,
  });
  console.log(JSON.stringify({ local, fixture, ...summary }, null, 2));
  if (summary.status === 'partial' && process.env.GITHUB_ACTIONS === 'true') console.warn('::warning::Sync completed with partial or deferred work. Review the sync log before treating the catalogue as fully refreshed.');
  if (summary.status === 'failed') process.exitCode = 1;
  // Partial work (for example one missing poster or a capped queue) is retained
  // and may be deployed. Its partial status stays visible in logs and alerts.
} catch (error) {
  // Validation messages are controlled; infrastructure exceptions can contain URLs.
  const message = error instanceof Error && /^(Choose |IDs must|Set |Source base|Cloudflare account|D1 database|R2 account|Invalid R2 bucket)/.test(error.message) ? error.message : 'Sync could not start. Check local schema, bindings and required environment variables.';
  console.error(message); process.exitCode = 1;
} finally { await dispose?.(); }
