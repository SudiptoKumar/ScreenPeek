import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSyncLog, finishSyncLog } from '../sync/log.ts';
import type { SyncSummary } from '../sync/log.ts';
import type { SqlClient, SqlStatement, SqlValue } from '../sync/storage.ts';

const summary: SyncSummary = {
  status: 'partial', source: 'manual', startedAt: '2026-11-09T08:30:00.000Z',
  finishedAt: '2026-11-09T08:31:00.000Z', added: 12, updated: 3,
  errors: ["Could not import movie 9; special characters: ' \" ;"],
};

test('start log uses bound parameters and returns the inserted log ID', async () => {
  let call: { sql: string; params?: SqlValue[] } | undefined;
  const db: SqlClient = {
    async query<T extends Record<string, unknown>>(sql: string, params?: SqlValue[]) {
      call = { sql, params };
      return [{ id: 42 }] as unknown as T[];
    },
    async batch() { assert.fail('start must use INSERT RETURNING'); },
  };
  assert.equal(await startSyncLog(db, summary.startedAt, summary.source), 42);
  assert.match(call!.sql, /INSERT INTO sync_log/);
  assert.match(call!.sql, /'running'/);
  assert.match(call!.sql, /RETURNING id/);
  assert.equal(call!.sql.includes(summary.startedAt), false);
  assert.deepEqual(call!.params, [summary.startedAt, summary.source]);
});

test('finish log records final counts, status, times, source, and JSON errors in one update', async () => {
  let statements: SqlStatement[] = [];
  const db: SqlClient = {
    async query() { assert.fail('finish must update rather than insert another run'); },
    async batch(value) { statements = value; return { rowsWritten: 1 }; },
  };
  await finishSyncLog(db, 42, summary);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /UPDATE sync_log SET/);
  assert.match(statements[0].sql, /WHERE id = \?/);
  assert.equal(statements[0].sql.includes(summary.errors[0]), false);
  assert.deepEqual(statements[0].params, [summary.startedAt, summary.finishedAt, 'partial', 12, 3,
    JSON.stringify(summary.errors), 'manual', 42]);
  assert.deepEqual(JSON.parse(statements[0].params![5] as string), summary.errors);
});

test('failed inserts and invalid final log IDs are reported instead of silently losing history', async () => {
  let writes = 0;
  const db: SqlClient = {
    async query() { return []; },
    async batch() { writes++; return { rowsWritten: 1 }; },
  };
  await assert.rejects(() => startSyncLog(db, summary.startedAt, 'cron'), /create the sync log/);
  await assert.rejects(() => finishSyncLog(db, 0, summary), /Invalid sync log ID/);
  assert.equal(writes, 0);
});
