/**
 * ScreenPeek Insight — scheduled jobs runner (F20/F23/F26).
 *
 * Runs inside the nightly GitHub Actions workflow against the remote D1
 * over its HTTP API. Usage: node scripts/insight_jobs.ts <job>
 * Jobs: autoopt | retention | postbacks-retry | link-health | weekly-report
 * Each job is safe to re-run and exits non-zero only on hard failure.
 */
import { HttpD1 } from '../sync/d1.ts';
import type { SqlClient } from '../sync/storage.ts';

/** Adapt the sync SqlClient to the D1Database shape the Insight libs use. */
export function sqlClientDb(client: SqlClient): D1Database {
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { params = values; return statement; },
      async all<T>() {
        const rows = await client.query<T & Record<string, unknown>>(sql, params as never[]);
        return { results: rows, success: true, meta: { changes: 0 } };
      },
      async first<T>() {
        const rows = await client.query<T & Record<string, unknown>>(sql, params as never[]);
        return (rows[0] ?? null) as T | null;
      },
      async run() {
        const result = await client.batch([{ sql, params: params as never[] }]);
        return { success: true, meta: { changes: result.rowsWritten } };
      },
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements: Array<{ bind: (...values: unknown[]) => unknown }>) {
      void statements;
      throw new Error('batch is not supported by the jobs adapter; use prepare().run()');
    },
  } as unknown as D1Database;
}

/** KV over the Cloudflare API, for the few jobs that need mirrors/counters. */
export function httpKv(accountId: string, namespaceId: string, token: string): KVNamespace {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
  const headers = { Authorization: `Bearer ${token}` };
  return {
    async get(key: string) {
      const response = await fetch(`${base}/${encodeURIComponent(key)}`, { headers });
      return response.ok ? response.text() : null;
    },
    async put(key: string, value: string) {
      await fetch(`${base}/${encodeURIComponent(key)}`, { method: 'PUT', headers, body: value });
    },
  } as unknown as KVNamespace;
}

async function main() {
  const job = process.argv[2] || '';
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const databaseId = process.env.D1_DATABASE_ID || '';
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  if (!accountId || !databaseId || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and CLOUDFLARE_API_TOKEN are required.');
  const db = sqlClientDb(new HttpD1({ accountId, databaseId, token }));
  const kv = httpKv(accountId, process.env.KV_NAMESPACE_ID || '', token);
  // process.env rides along so alert/report dispatch can reach the
  // money-bot secrets (MONEY_BOT_TOKEN / MONEY_BOT_CHAT_ID).
  const env = { DB: db, CONFIG: kv, ...(process.env as Record<string, unknown>) } as { DB: D1Database; CONFIG: KVNamespace } & Record<string, unknown>;

  if (job === 'autoopt') {
    const { runAutoopt } = await import('../src/lib/tracking/autoopt.ts');
    const run = await runAutoopt(env);
    console.log(`autoopt: ${run.linksChecked} links checked, ${run.proposals.length} proposals (${run.proposals.filter(p => p.applied).length} applied)`);
    return;
  }
  if (job === 'retention') {
    const { readTrackingConfig } = await import('../src/lib/tracking/config.ts');
    const { runRetention } = await import('../src/lib/tracking/retention.ts');
    const result = await runRetention(db, await readTrackingConfig(db), false);
    console.log(`retention: deleted clicks ${result.clicks}, events ${result.events}, sessions ${result.sessions}, postback log ${result.postbacksRaw}`);
    return;
  }
  if (job === 'postbacks-retry') {
    const { retryOutgoingPostbacks } = await import('../src/lib/tracking/outgoing.ts');
    const result = await retryOutgoingPostbacks(env);
    console.log(`postbacks-retry: attempted ${result.attempted}, sent ${result.sent}, failed ${result.failed}`);
    return;
  }
  if (job === 'link-health') {
    const { runLinkHealth } = await import('../src/lib/tracking/health.ts');
    const result = await runLinkHealth(env);
    console.log(`link-health: checked ${result.checked}, dead ${result.dead.length}`);
    return;
  }
  if (job === 'weekly-report') {
    const { sendWeeklyReport } = await import('../src/lib/tracking/report.ts');
    const result = await sendWeeklyReport(env);
    console.log(`weekly-report: ${result.sent ? 'sent' : `skipped (${result.reason})`}`);
    return;
  }
  if (job === 'alerts') {
    const { evaluateAlerts } = await import('../src/lib/tracking/alerts.ts');
    const result = await evaluateAlerts(env);
    console.log(`alerts: raised ${result.raised.length ? result.raised.join(', ') : 'none'}`);
    return;
  }
  throw new Error(`Unknown insight job: ${job}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
