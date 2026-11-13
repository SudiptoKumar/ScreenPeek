/**
 * ScreenPeek Insight — weekly report (F26, docs/06).
 *
 * On the configured report day, the workflow builds the last 7 days'
 * summary from the same aggregate queries the admin Charts view uses
 * (so the numbers match the admin for the same range) and sends it on
 * the configured channels — telegram to the money-bot chat. A marker
 * in config makes it fire once per week even though the workflow runs
 * several times a day.
 */
import { readTrackingConfig } from './config.ts';
import { trackingCharts, type TrackingFilters } from '../admin/tracking-data.ts';

export interface ReportEnvironment {
  DB: D1Database;
  CONFIG?: KVNamespace;
  MONEY_BOT_TOKEN?: string;
  MONEY_BOT_CHAT_ID?: string;
  [key: string]: unknown;
}

export interface WeeklyReport {
  sent: boolean;
  reason: string;
  text?: string;
  totals?: { clicks: number; conversions: number; revenueMinor: number; pageviews: number };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export async function buildWeeklyReport(env: { DB: D1Database }, now = new Date()): Promise<{ text: string; totals: NonNullable<WeeklyReport['totals']> }> {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  const filters: TrackingFilters = { from, to, link: '', country: '', device: '', band: '', network: '', q: '' };
  const charts = await trackingCharts({ DB: env.DB }, filters);
  const totals = {
    clicks: charts.days.reduce((sum, day) => sum + day.clicks, 0),
    conversions: charts.days.reduce((sum, day) => sum + day.conversions, 0),
    revenueMinor: charts.days.reduce((sum, day) => sum + day.revenueMinor, 0),
    pageviews: charts.days.reduce((sum, day) => sum + day.pageviews, 0),
  };
  const lines = [
    'ScreenPeek Insight — weekly report',
    `${from} to ${to} (UTC)`,
    `Clicks: ${totals.clicks.toLocaleString()}`,
    `Conversions: ${totals.conversions.toLocaleString()}`,
    `Revenue (all currencies, minor units): ${totals.revenueMinor.toLocaleString()}`,
    `Pageviews: ${totals.pageviews.toLocaleString()}`,
  ];
  if (charts.countries.length) {
    lines.push(`Top countries: ${charts.countries.slice(0, 5).map(row => `${row.label || 'Unknown'} ${row.clicks.toLocaleString()}`).join(', ')}`);
  }
  lines.push('Full detail: Tracking in the admin panel.');
  return { text: lines.join('\n'), totals };
}

export async function sendWeeklyReport(env: ReportEnvironment, fetcher: typeof fetch = fetch, now = new Date()): Promise<WeeklyReport> {
  const cfg = await readTrackingConfig(env.DB);
  if (!cfg.enabled) return { sent: false, reason: 'tracking_off' };
  if (WEEKDAYS[now.getUTCDay()] !== cfg.reportDay.toLowerCase()) return { sent: false, reason: 'not_report_day' };
  const marker = await env.DB.prepare("SELECT value FROM config WHERE key='tracking_report_last_sent'").first<{ value: string }>().catch(() => null);
  if (marker?.value) {
    const last = Date.parse(`${marker.value}T00:00:00Z`);
    if (Number.isFinite(last) && now.getTime() - last < 6 * 86_400_000) return { sent: false, reason: 'already_sent_this_week' };
  }
  const { text, totals } = await buildWeeklyReport(env, now);
  const channels = cfg.alertChannels.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  let sent = false;
  if (channels.includes('telegram') && env.MONEY_BOT_TOKEN && env.MONEY_BOT_CHAT_ID) {
    try {
      const response = await fetcher(`https://api.telegram.org/bot${env.MONEY_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.MONEY_BOT_CHAT_ID, text }),
        signal: AbortSignal.timeout(5000),
      });
      const out = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      sent = !!out?.ok;
    } catch { sent = false; }
  }
  if (sent) {
    const today = now.toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO config(key,value) VALUES('tracking_report_last_sent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, revision=revision+1")
      .bind(today).run();
    if (env.CONFIG) { try { await env.CONFIG.put('config:tracking_report_last_sent', today); } catch { /* mirror is best-effort */ } }
  }
  return { sent, reason: sent ? 'sent' : 'no_channel_or_send_failed', text, totals };
}
