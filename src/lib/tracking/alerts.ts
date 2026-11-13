/**
 * ScreenPeek Insight — alerts (F26, docs/06).
 *
 * Every alert is a row in tr_alerts — the admin Alerts view is the
 * guaranteed surface. Rows are deduplicated once per event per day
 * (day + kind + ref). When alert channels are configured, unsent rows
 * are dispatched: telegram goes to the owner's existing money-bot
 * chat. (The project has no mail sender, so an "email" channel is
 * recorded on the row but cannot dispatch until one exists.)
 *
 * Producers: cap hits (recorded by the router, F19), the daily
 * raw-storage cap, conversion-rate drops, outgoing-postback failure
 * streaks, auto-opt shifts (raised inside runAutoopt) and dead links
 * (raised by the health checker). evaluateAlerts() runs the periodic
 * checks from the workflow and flushes anything unsent.
 */
import { readTrackingConfig } from './config.ts';
import { QuotaEngine } from './quota.ts';

export interface AlertEnvironment {
  DB: D1Database;
  CONFIG?: KVNamespace;
  MONEY_BOT_TOKEN?: string;
  MONEY_BOT_CHAT_ID?: string;
  [key: string]: unknown;
}

export interface AlertRow { id: number; day: string; kind: string; ref: string; message: string; sent: number }

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/** Record an alert once per event per day, then try to dispatch it. */
export async function raiseAlert(env: AlertEnvironment, kind: string, ref: string, message: string, now = new Date()): Promise<boolean> {
  const day = dayOf(now);
  try {
    const existing = await env.DB.prepare('SELECT id FROM tr_alerts WHERE day=? AND kind=? AND ref=?').bind(day, kind, ref).first();
    if (existing) return false;
    await env.DB.prepare('INSERT INTO tr_alerts(day,kind,ref,message,sent,created_at) VALUES(?,?,?,?,0,?)')
      .bind(day, kind, ref, message.slice(0, 500), now.toISOString()).run();
  } catch { return false; }
  await dispatchUnsent(env).catch(() => 0);
  return true;
}

async function sendTelegram(env: AlertEnvironment, text: string, fetcher: typeof fetch): Promise<boolean> {
  if (!env.MONEY_BOT_TOKEN || !env.MONEY_BOT_CHAT_ID) return false;
  try {
    const response = await fetcher(`https://api.telegram.org/bot${env.MONEY_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.MONEY_BOT_CHAT_ID, text }),
      signal: AbortSignal.timeout(5000),
    });
    const out = (await response.json().catch(() => null)) as { ok?: boolean } | null;
    return !!out?.ok;
  } catch { return false; }
}

/** Dispatch every unsent alert through the configured channels.
 * Returns how many were newly marked sent. With no telegram channel
 * configured, rows stay unsent and readable in the admin. */
export async function dispatchUnsent(env: AlertEnvironment, fetcher: typeof fetch = fetch): Promise<number> {
  const cfg = await readTrackingConfig(env.DB);
  const channels = cfg.alertChannels.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  if (!channels.includes('telegram')) return 0;
  const rows = await env.DB.prepare('SELECT * FROM tr_alerts WHERE sent=0 ORDER BY id LIMIT 20').all<AlertRow>();
  let sent = 0;
  for (const row of rows.results || []) {
    const text = `ScreenPeek Insight alert — ${row.kind}\n${row.message}`;
    if (await sendTelegram(env, text, fetcher)) {
      await env.DB.prepare('UPDATE tr_alerts SET sent=1 WHERE id=?').bind(row.id).run();
      sent++;
    }
  }
  return sent;
}

/** The periodic checks, run from the workflow (insight_jobs alerts). */
export async function evaluateAlerts(env: AlertEnvironment, now = new Date()): Promise<{ raised: string[] }> {
  const raised: string[] = [];
  const cfg = await readTrackingConfig(env.DB);
  if (!cfg.enabled) return { raised };
  const today = dayOf(now);

  // Daily raw-storage cap reached.
  if (env.CONFIG) {
    const engine = new QuotaEngine(env.CONFIG as KVNamespace);
    const stored = await engine.count(now).catch(() => 0);
    if (stored >= cfg.dailyCap && await raiseAlert(env, 'daily_cap', today,
      `Raw-data storage hit today's cap of ${cfg.dailyCap.toLocaleString()} records. Aggregates keep counting everything; new raw rows are skipped until tomorrow (UTC).`, now)) raised.push('daily_cap');
  }

  // Conversion-rate drop on the top link: today's CR under half the
  // previous 7 days' average CR, with enough clicks to mean something.
  const top = await env.DB.prepare(`SELECT slug, SUM(clicks) AS clicks, SUM(conversions) AS conversions FROM tr_click_daily
    WHERE day=? GROUP BY slug ORDER BY clicks DESC LIMIT 1`).bind(today)
    .first<{ slug: string; clicks: number; conversions: number }>().catch(() => null);
  if (top && top.clicks >= 50) {
    const prev = await env.DB.prepare(`SELECT SUM(clicks) AS clicks, SUM(conversions) AS conversions FROM tr_click_daily
      WHERE slug=? AND day BETWEEN date(?, '-7 days') AND date(?, '-1 day')`).bind(top.slug, today, today)
      .first<{ clicks: number; conversions: number }>().catch(() => null);
    if (prev && prev.clicks > 0) {
      const crToday = top.conversions / top.clicks;
      const crPrev = prev.conversions / prev.clicks;
      if (crPrev > 0 && crToday < crPrev * 0.5 && await raiseAlert(env, 'cr_drop', top.slug,
        `Conversion rate on ${top.slug} dropped over 50%: ${(crToday * 100).toFixed(2)}% today vs a ${(crPrev * 100).toFixed(2)}% 7-day average (${top.clicks.toLocaleString()} clicks today).`, now)) raised.push('cr_drop');
    }
  }

  // Outgoing postback failure streak: the five newest queue rows all failed.
  const latest = await env.DB.prepare('SELECT status FROM tr_postbacks_out ORDER BY id DESC LIMIT 5')
    .all<{ status: string }>().catch(() => null);
  const streak = latest?.results || [];
  if (streak.length === 5 && streak.every(row => row.status === 'failed')
    && await raiseAlert(env, 'postback_streak', 'outgoing',
      'The last 5 outgoing postbacks all failed. Check the networks\u2019 endpoints in Tracking → Conversions → Outgoing postbacks.', now)) raised.push('postback_streak');

  await dispatchUnsent(env).catch(() => 0);
  return { raised };
}
