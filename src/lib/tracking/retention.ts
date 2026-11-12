/**
 * ScreenPeek Insight — retention purge (F14).
 *
 * Deletes raw rows older than the configured retention windows. Daily
 * aggregates (tr_click_daily, tr_page_daily) are kept — they are the
 * permanent history. Dry-run counts without deleting so the owner can
 * see the effect before anything is removed.
 */
import type { TrackingConfig } from './config.ts';

export interface RetentionResult {
  dryRun: boolean;
  clicks: number;
  events: number;
  sessions: number;
  postbacksRaw: number;
}

const cutoff = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

const TABLES: Array<{ name: 'clicks' | 'events' | 'sessions' | 'postbacksRaw'; table: string; column: string; days: (cfg: TrackingConfig) => number }> = [
  { name: 'clicks', table: 'tr_clicks', column: 'ts', days: cfg => cfg.retentionClicksDays },
  { name: 'events', table: 'tr_events', column: 'ts_received', days: cfg => cfg.retentionEventsDays },
  { name: 'sessions', table: 'tr_sessions', column: 'started_at', days: cfg => cfg.retentionSessionsDays },
  { name: 'postbacksRaw', table: 'tr_postbacks_raw', column: 'ts', days: cfg => cfg.retentionPostbacksDays },
];

export async function runRetention(db: D1Database, cfg: TrackingConfig, dryRun: boolean): Promise<RetentionResult> {
  const result: RetentionResult = { dryRun, clicks: 0, events: 0, sessions: 0, postbacksRaw: 0 };
  for (const entry of TABLES) {
    const before = cutoff(entry.days(cfg));
    if (dryRun) {
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${entry.table} WHERE ${entry.column} < ?`).bind(before).first<{ count: number }>();
      result[entry.name] = row?.count || 0;
    } else {
      const deleted = await db.prepare(`DELETE FROM ${entry.table} WHERE ${entry.column} < ?`).bind(before).run();
      result[entry.name] = deleted.meta.changes || 0;
    }
  }
  return result;
}

/** Deletes every row marked is_test (clicks, conversions, events, sessions). */
export async function purgeTestData(db: D1Database): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ['tr_clicks', 'tr_conversions', 'tr_events', 'tr_sessions']) {
    const deleted = await db.prepare(`DELETE FROM ${table} WHERE is_test=1`).run();
    counts[table] = deleted.meta.changes || 0;
  }
  return counts;
}
