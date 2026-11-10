import type { SqlClient } from './storage.ts';

export interface SyncSummary {
  status: 'ok' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string;
  source: 'cron' | 'manual';
  added: number;
  updated: number;
  errors: string[];
}

export async function startSyncLog(db: SqlClient, startedAt: string, source: 'cron' | 'manual'): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO sync_log (started_at, status, added, updated, errors, source)
     VALUES (?, 'running', 0, 0, '[]', ?) RETURNING id`,
    [startedAt, source],
  );
  const id = rows[0]?.id;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Could not create the sync log entry');
  return id;
}

export async function finishSyncLog(db: SqlClient, id: number, summary: SyncSummary): Promise<void> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid sync log ID');
  await db.batch([{
    sql: `UPDATE sync_log SET started_at = ?, finished_at = ?, status = ?,
          added = ?, updated = ?, errors = ?, source = ? WHERE id = ?`,
    params: [summary.startedAt, summary.finishedAt, summary.status, summary.added,
      summary.updated, JSON.stringify(summary.errors), summary.source, id],
  }]);
}
