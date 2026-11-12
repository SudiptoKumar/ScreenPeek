// ScreenPeek Insight — admin data layer (F10+). Read models for the
// Tracking section. Charts and totals read the AGGREGATE tables
// (tr_click_daily / tr_page_daily), which count 100% of traffic; raw
// tables are sampled by the daily cap, and the UI says so wherever a
// raw number is shown next to an aggregate one.

import { readTrackingConfig, type TrackingConfig } from '../tracking/config.ts';
import { QuotaEngine } from '../tracking/quota.ts';

export interface TrackingOverview {
  cfg: TrackingConfig;
  day: string;
  clicksToday: number;
  uniqueVisitorsToday: number;
  conversionsToday: number;
  revenueToday: Array<{ currency: string; revenueMinor: number }>;
  storedRaw: number;
  totalRaw: number;
  quotaCapped: boolean;
  sessionsToday: number;
  pageviewsToday: number;
  liveFeed: Array<Record<string, unknown>>;
  topLinks: Array<{ slug: string; clicks: number; conversions: number; revenueMinor: number }>;
  topCountries: Array<{ country: string; clicks: number }>;
  postbackResults: Array<{ result: string; count: number }>;
}

export async function trackingOverview(env: { DB: D1Database; CONFIG: KVNamespace }): Promise<TrackingOverview> {
  const db = env.DB;
  const cfg = await readTrackingConfig(db);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const engine = new QuotaEngine(env.CONFIG);
  const [storedRaw, totalRaw] = await Promise.all([engine.count(now), engine.total(now)]);
  const [totals, sessions, pageviews, liveFeed, topLinks, topCountries, postbacks] = await Promise.all([
    db.prepare('SELECT COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(unique_visitors),0) AS uniques, COALESCE(SUM(conversions),0) AS conversions FROM tr_click_daily WHERE day=?').bind(day).first<{ clicks: number; uniques: number; conversions: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM tr_sessions WHERE date(started_at)=?").bind(day).first<{ count: number }>(),
    db.prepare('SELECT COALESCE(SUM(pageviews),0) AS pageviews FROM tr_page_daily WHERE day=?').bind(day).first<{ pageviews: number }>(),
    db.prepare('SELECT click_id,ts,slug,country,device_type,device_model,dest_host,quality_band,disguise_score,route_reason FROM tr_clicks ORDER BY id DESC LIMIT 20').all<Record<string, unknown>>(),
    db.prepare('SELECT slug, SUM(clicks) AS clicks, SUM(conversions) AS conversions, SUM(revenue_minor) AS revenue FROM tr_click_daily WHERE day=? GROUP BY slug ORDER BY clicks DESC LIMIT 5').bind(day).all<{ slug: string; clicks: number; conversions: number; revenue: number }>(),
    db.prepare('SELECT country, SUM(clicks) AS clicks FROM tr_click_daily WHERE day=? GROUP BY country ORDER BY clicks DESC LIMIT 5').bind(day).all<{ country: string; clicks: number }>(),
    db.prepare("SELECT result, COUNT(*) AS count FROM tr_postbacks_raw WHERE ts >= datetime('now','-1 day') GROUP BY result ORDER BY count DESC").all<{ result: string; count: number }>(),
  ]);
  const revenueRows = await db.prepare('SELECT currency, SUM(revenue_minor) AS revenue FROM tr_click_daily WHERE day=? GROUP BY currency ORDER BY revenue DESC').bind(day)
    .all<{ currency: string; revenue: number }>();
  return {
    cfg, day,
    clicksToday: totals?.clicks || 0,
    uniqueVisitorsToday: totals?.uniques || 0,
    conversionsToday: totals?.conversions || 0,
    revenueToday: (revenueRows.results || []).filter(row => row.currency).map(row => ({ currency: row.currency, revenueMinor: row.revenue })),
    storedRaw, totalRaw: Math.max(totalRaw, storedRaw),
    quotaCapped: storedRaw >= cfg.dailyCap,
    sessionsToday: sessions?.count || 0,
    pageviewsToday: pageviews?.pageviews || 0,
    liveFeed: liveFeed.results || [],
    topLinks: topLinks.results || [],
    topCountries: topCountries.results || [],
    postbackResults: postbacks.results || [],
  };
}

export const TRACKING_VIEWS = ['overview', 'clicks', 'pages', 'sessions', 'conversions', 'quality', 'charts', 'export', 'settings', 'tools'] as const;
export type TrackingView = typeof TRACKING_VIEWS[number];
export const trackingView = (url: URL): TrackingView => {
  const view = url.searchParams.get('view') || 'overview';
  return (TRACKING_VIEWS as readonly string[]).includes(view) ? view as TrackingView : 'overview';
};
