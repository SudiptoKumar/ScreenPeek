/** Sync-only D1 HTTP transport. Never import it into visitor/client code. */
import type { SqlBatchResult, SqlClient, SqlStatement, SqlValue } from './storage.ts';

export interface HttpD1Options {
  accountId: string;
  databaseId: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

interface Result {
  success: true;
  results?: Record<string, unknown>[];
  meta?: { rows_written?: number };
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const maxSqlBytes = 100_000;
// A conservative client-side bound, not a claim about Cloudflare's body limit.
const maxRequestBytes = 5 * 1024 * 1024;

function checkStatement(statement: SqlStatement) {
  if (typeof statement.sql !== 'string' || !statement.sql.trim()) throw new Error('D1 SQL must not be empty');
  if (byteLength(statement.sql) > maxSqlBytes) throw new Error('D1 SQL exceeds the 100 KB statement limit');
  const params = statement.params ?? [];
  if (!Array.isArray(params) || params.length > 100) throw new Error('D1 statements support at most 100 bound parameters');
  if (params.some(value => value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))) {
    throw new Error('D1 parameters must be strings, finite numbers, or null');
  }
  return { sql: statement.sql, params };
}

/**
 * Official REST request schema accepts {batch:[{sql,params},...]}. Keep each
 * batch in one HTTP request; never split it or retry ambiguous write failures.
 * Binding.batch documents transactions, but the public REST documentation does
 * not explicitly promise identical rollback semantics. Remote rollback and
 * numeric/null parameter checks remain a required credentialed smoke test.
 *
 * Sources: cloudflare/cloudflare-typescript src/resources/d1/database/database.ts
 * (DatabaseQueryParams.MultipleQueries); Cloudflare D1 worker-api/d1-database
 * (batch transactions), and d1/platform/limits (per-statement limits).
 */
export class HttpD1 implements SqlClient {
  #endpoint: string;
  #token: string;
  #fetcher: typeof globalThis.fetch;

  constructor(options: HttpD1Options) {
    if ('document' in globalThis) throw new Error('The D1 sync client is server-only');
    if (!/^[0-9a-f]{32}$/i.test(options.accountId)) throw new Error('Cloudflare account ID must be 32 hexadecimal characters');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.databaseId)) throw new Error('D1 database ID must be a UUID');
    if (typeof options.token !== 'string' || !options.token.trim() || /[\r\n]/.test(options.token)) throw new Error('Set a valid CLOUDFLARE_API_TOKEN for sync');
    this.#endpoint = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/d1/database/${options.databaseId}/query`;
    this.#token = options.token.trim();
    this.#fetcher = options.fetch ?? globalThis.fetch;
  }

  async #request(payload: { sql: string; params: SqlValue[] } | { batch: Array<{ sql: string; params: SqlValue[] }> }, expectedResults: number): Promise<Result[]> {
    const body = JSON.stringify(payload);
    if (byteLength(body) > maxRequestBytes) throw new Error('D1 atomic request exceeds the client 5 MiB limit; reduce the logical batch');
    let response: Response;
    try {
      response = await this.#fetcher(this.#endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('D1 network request failed; write outcome may be unknown');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`D1 request failed (HTTP ${response.status})`);
    }
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error('D1 returned invalid JSON'); }
    if (!data || typeof data !== 'object') throw new Error('D1 returned an invalid result envelope');
    const envelope = data as { success?: unknown; result?: unknown; errors?: unknown };
    if (envelope.success !== true || !Array.isArray(envelope.result) || envelope.result.length < expectedResults
      || (Array.isArray(envelope.errors) && envelope.errors.length > 0)) throw new Error('D1 query failed or returned an incomplete batch');
    for (const result of envelope.result) {
      if (!result || typeof result !== 'object' || result.success !== true
        || (result.results !== undefined && (!Array.isArray(result.results) || result.results.some((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row))))) {
        throw new Error('D1 query failed or returned invalid result rows');
      }
    }
    return envelope.result as Result[];
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const results = await this.#request(checkStatement({ sql, params }), 1);
    return results.flatMap(result => result.results ?? []) as T[];
  }

  async batch(statements: SqlStatement[]): Promise<SqlBatchResult> {
    if (!statements.length) return { rowsWritten: 0 };
    const batch = statements.map(checkStatement);
    const results = await this.#request({ batch }, batch.length);
    let rowsWritten = 0;
    for (const result of results) {
      const count = result.meta?.rows_written;
      if (!Number.isSafeInteger(count) || count! < 0) throw new Error('D1 batch returned invalid write metadata; write outcome may be unknown');
      rowsWritten += count!;
      if (!Number.isSafeInteger(rowsWritten)) throw new Error('D1 batch write metadata exceeds a safe integer');
    }
    return { rowsWritten };
  }
}
