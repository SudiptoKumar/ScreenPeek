// ScreenPeek Insight — admin data layer (F10+). Read models for the
// Tracking section. Charts and totals read the AGGREGATE tables
// (tr_click_daily / tr_page_daily), which count 100% of traffic; raw
// tables are sampled by the daily cap, and the UI says so wherever a
// raw number is shown next to an aggregate one.

import { readTrackingConfig, type TrackingConfig } from '../tracking/config.ts';
import { QuotaEngine } from '../tracking/quota.ts';
import { deadLinkSlugs } from '../tracking/health.ts';

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
  deadLinks: Array<{ slug: string; url: string; httpStatus: number | null }>;
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
    db.prepare('SELECT slug, SUM(clicks) AS clicks, SUM(conversions) AS conversions, SUM(revenue_minor) AS revenueMinor FROM tr_click_daily WHERE day=? GROUP BY slug ORDER BY clicks DESC LIMIT 5').bind(day).all<{ slug: string; clicks: number; conversions: number; revenueMinor: number }>(),
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
    deadLinks: await deadLinkSlugs(db, now).catch(() => []),
  };
}

export const TRACKING_VIEWS = ['overview', 'clicks', 'pages', 'sessions', 'conversions', 'funnels', 'quality', 'variants', 'charts', 'export', 'settings', 'tools', 'alerts'] as const;
export type TrackingView = typeof TRACKING_VIEWS[number];
export const trackingView = (url: URL): TrackingView => {
  const view = url.searchParams.get('view') || 'overview';
  return (TRACKING_VIEWS as readonly string[]).includes(view) ? view as TrackingView : 'overview';
};

// ---- F11: lists + click detail -------------------------------------------

export const LIST_PAGE_SIZE = 500;

export interface TrackingListResult {
  rows: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pages: number;
  from: string;
  to: string;
}

const dateParam = (url: URL, name: string, fallback: string) => {
  const value = url.searchParams.get(name) || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
};

export interface TrackingFilters { from: string; to: string; link: string; country: string; device: string; band: string; network: string; q: string }

export function trackingFilters(url: URL): TrackingFilters {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const clean = (name: string, max = 60) => (url.searchParams.get(name) || '').slice(0, max);
  return {
    from: dateParam(url, 'from', weekAgo), to: dateParam(url, 'to', today),
    link: clean('link', 120), country: clean('country', 4).toUpperCase(), device: clean('device', 20),
    band: clean('band', 20), network: clean('network', 40), q: clean('q', 120),
  };
}

async function listQuery(db: D1Database, view: TrackingView, filters: TrackingFilters, page: number): Promise<TrackingListResult> {
  const where: string[] = [];
  const binds: unknown[] = [];
  let fromSql = '', orderSql = 'ORDER BY id DESC';
  if (view === 'clicks' || view === 'quality') {
    fromSql = 'FROM tr_clicks';
    where.push('date(ts) BETWEEN ? AND ?'); binds.push(filters.from, filters.to);
    if (view === 'quality') where.push("quality_band <> 'clean'");
    if (filters.link) { where.push('slug=?'); binds.push(filters.link); }
    if (filters.country) { where.push('country=?'); binds.push(filters.country); }
    if (filters.device) { where.push('device_type=?'); binds.push(filters.device); }
    if (filters.band) { where.push('quality_band=?'); binds.push(filters.band); }
    if (filters.q) { where.push('(click_id LIKE ? OR dest_host LIKE ?)'); binds.push(`%${filters.q}%`, `%${filters.q}%`); }
  } else if (view === 'pages') {
    fromSql = 'FROM tr_page_daily';
    where.push('day BETWEEN ? AND ?'); binds.push(filters.from, filters.to);
    orderSql = 'ORDER BY pageviews DESC';
  } else if (view === 'sessions') {
    fromSql = 'FROM tr_sessions';
    where.push('date(started_at) BETWEEN ? AND ?'); binds.push(filters.from, filters.to);
    if (filters.country) { where.push('country=?'); binds.push(filters.country); }
    if (filters.device) { where.push('device_type=?'); binds.push(filters.device); }
    orderSql = 'ORDER BY started_at DESC';
  } else if (view === 'conversions') {
    fromSql = 'FROM tr_conversions c LEFT JOIN tr_clicks k ON k.click_id=c.click_id';
    where.push('date(c.ts_received) BETWEEN ? AND ?'); binds.push(filters.from, filters.to);
    if (filters.network) { where.push('c.network=?'); binds.push(filters.network); }
    if (filters.link) { where.push('k.slug=?'); binds.push(filters.link); }
    orderSql = 'ORDER BY c.id DESC';
  } else {
    return { rows: [], total: 0, page: 1, pages: 1, from: filters.from, to: filters.to };
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const select = view === 'pages'
    ? 'SELECT page_url, page_type, SUM(pageviews) AS pageviews, SUM(unique_sessions) AS unique_sessions, SUM(cta_clicks) AS cta_clicks, ROUND(AVG(avg_duration_s),1) AS avg_duration_s, ROUND(AVG(avg_max_scroll_pct)) AS avg_max_scroll_pct'
    : view === 'conversions'
      ? 'SELECT c.*, k.slug AS slug, k.country AS country, k.device_type AS device_type'
      : 'SELECT *';
  const groupSql = view === 'pages' ? ' GROUP BY page_url, page_type' : '';
  const totalRow = await db.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 ${fromSql}${whereSql}${groupSql})`).bind(...binds).first<{ count: number }>();
  const total = totalRow?.count || 0;
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const rows = await db.prepare(`${select} ${fromSql}${whereSql}${groupSql} ${orderSql} LIMIT ${LIST_PAGE_SIZE} OFFSET ${(safePage - 1) * LIST_PAGE_SIZE}`)
    .bind(...binds).all<Record<string, unknown>>();
  return { rows: rows.results || [], total, page: safePage, pages, from: filters.from, to: filters.to };
}

export interface TrackingAdminData {
  overview: TrackingOverview;
  view: TrackingView;
  filters: TrackingFilters;
  list: TrackingListResult | null;
  detail: Record<string, unknown> | null;
  qualitySummary: Array<{ flag: string; count: number }> | null;
  charts: TrackingCharts | null;
  exportCounts: Record<ExportDataset, number> | null;
  settings: Record<string, string> | null;
  variants: TrackingVariantsData | null;
  outgoing: Array<Record<string, unknown>> | null;
  funnels: TrackingFunnelsData | null;
  profit: ProfitRow[] | null;
  alerts: Array<Record<string, unknown>> | null;
}

export async function trackingAdminData(env: { DB: D1Database; CONFIG: KVNamespace }, url: URL): Promise<TrackingAdminData> {
  const overview = await trackingOverview(env);
  const view = trackingView(url);
  const filters = trackingFilters(url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1') || 1);
  let list: TrackingListResult | null = null;
  let detail: Record<string, unknown> | null = null;
  let qualitySummary: TrackingAdminData['qualitySummary'] = null;
  let charts: TrackingCharts | null = null;
  if (view === 'charts') charts = await trackingCharts(env, filters).catch(() => null);
  let variants: TrackingVariantsData | null = null;
  if (view === 'variants') {
    variants = await trackingVariants(env, url, overview.cfg.autooptMinClicks).catch(() => null);
  }
  let settings: Record<string, string> | null = null;
  if (view === 'settings') {
    const rows = await env.DB.prepare("SELECT key, value FROM config WHERE key LIKE 'tracking_%'").all<{ key: string; value: string }>().catch(() => null);
    settings = {};
    for (const row of rows?.results || []) settings[row.key] = row.value;
  }
  let exportCounts: TrackingAdminData['exportCounts'] = null;
  if (view === 'export') {
    exportCounts = { clicks: 0, conversions: 0, sessions: 0, postbacks: 0 };
    for (const dataset of EXPORT_DATASETS) {
      const counted = await exportCount(env.DB, dataset, filters).catch(() => 0);
      exportCounts[dataset] = counted;
    }
  }
  if (['clicks', 'pages', 'sessions', 'conversions', 'quality'].includes(view)) {
    list = await listQuery(env.DB, view, filters, page);
  }
  if (view === 'quality') {
    const known = ['bot_ua', 'datacentre', 'vpn_proxy', 'trust_low', 'tz_mismatch', 'velocity', 'no_referrer'];
    qualitySummary = [];
    for (const flag of known) {
      const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM tr_clicks WHERE date(ts) BETWEEN ? AND ? AND quality_flags LIKE ?")
        .bind(filters.from, filters.to, `%"${flag}"%`).first<{ count: number }>();
      if (row?.count) qualitySummary.push({ flag, count: row.count });
    }
  }
  let profit: TrackingAdminData['profit'] = null;
  if (view === 'charts') {
    profit = await trackingProfit(env.DB, filters, overview.cfg.costRulesJson).catch(() => null);
  }
  let funnels: TrackingAdminData['funnels'] = null;
  if (view === 'funnels') {
    funnels = await trackingFunnels(env.DB, filters, overview.cfg.funnelsJson, url.searchParams.get('network') || '').catch(() => null);
  }
  let alerts: TrackingAdminData['alerts'] = null;
  if (view === 'alerts') {
    const rows = await env.DB.prepare('SELECT * FROM tr_alerts ORDER BY id DESC LIMIT 50').all<Record<string, unknown>>().catch(() => null);
    alerts = rows?.results || [];
  }
  let outgoing: TrackingAdminData['outgoing'] = null;
  if (view === 'conversions') {
    const rows = await env.DB.prepare('SELECT * FROM tr_postbacks_out ORDER BY id DESC LIMIT 50').all<Record<string, unknown>>().catch(() => null);
    outgoing = rows?.results || [];
  }
  const clickId = (url.searchParams.get('click') || '').slice(0, 80);
  if (clickId) {
    detail = await env.DB.prepare('SELECT * FROM tr_clicks WHERE click_id=?').bind(clickId).first<Record<string, unknown>>();
  }
  return { overview, view, filters, list, detail, qualitySummary, charts, exportCounts, settings, variants, outgoing, funnels, profit, alerts };
}

// ---- F12: charts (aggregates only; breakdowns labelled as raw sample) ----

export interface TrackingCharts {
  days: Array<{ day: string; clicks: number; conversions: number; revenueMinor: number; pageviews: number }>;
  countries: Array<{ label: string; clicks: number }>;
  devices: Array<{ label: string; clicks: number }>;
  browsers: Array<{ label: string; clicks: number }>;
  referrers: Array<{ label: string; clicks: number }>;
  bands: Array<{ label: string; clicks: number }>;
  rawStored: number;
  rawTotal: number;
}

export async function trackingCharts(env: { DB: D1Database }, filters: TrackingFilters): Promise<TrackingCharts> {
  const db = env.DB;
  const [clickDays, pageDays, countries, devices, browsers, referrers, bands, storedRow] = await Promise.all([
    db.prepare('SELECT day, SUM(clicks) AS clicks, SUM(conversions) AS conversions, SUM(revenue_minor) AS revenueMinor FROM tr_click_daily WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day')
      .bind(filters.from, filters.to).all<{ day: string; clicks: number; conversions: number; revenueMinor: number }>(),
    db.prepare('SELECT day, SUM(pageviews) AS pageviews FROM tr_page_daily WHERE day BETWEEN ? AND ? GROUP BY day')
      .bind(filters.from, filters.to).all<{ day: string; pageviews: number }>(),
    db.prepare('SELECT country AS label, SUM(clicks) AS clicks FROM tr_click_daily WHERE day BETWEEN ? AND ? GROUP BY country ORDER BY clicks DESC LIMIT 10')
      .bind(filters.from, filters.to).all<{ label: string; clicks: number }>(),
    db.prepare('SELECT device_type AS label, SUM(clicks) AS clicks FROM tr_click_daily WHERE day BETWEEN ? AND ? GROUP BY device_type ORDER BY clicks DESC')
      .bind(filters.from, filters.to).all<{ label: string; clicks: number }>(),
    db.prepare('SELECT browser AS label, COUNT(*) AS clicks FROM tr_clicks WHERE date(ts) BETWEEN ? AND ? GROUP BY browser ORDER BY clicks DESC LIMIT 10')
      .bind(filters.from, filters.to).all<{ label: string; clicks: number }>(),
    db.prepare('SELECT referrer_class AS label, COUNT(*) AS clicks FROM tr_clicks WHERE date(ts) BETWEEN ? AND ? GROUP BY referrer_class ORDER BY clicks DESC')
      .bind(filters.from, filters.to).all<{ label: string; clicks: number }>(),
    db.prepare('SELECT quality_band AS label, COUNT(*) AS clicks FROM tr_clicks WHERE date(ts) BETWEEN ? AND ? GROUP BY quality_band ORDER BY clicks DESC')
      .bind(filters.from, filters.to).all<{ label: string; clicks: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM tr_clicks WHERE date(ts) BETWEEN ? AND ?').bind(filters.from, filters.to).first<{ count: number }>(),
  ]);
  const pageByDay = new Map((pageDays.results || []).map(row => [row.day, row.pageviews]));
  const days = (clickDays.results || []).map(row => ({ ...row, pageviews: pageByDay.get(row.day) || 0 }));
  const label = (rows: Array<{ label: string; clicks: number }>) => rows.map(row => ({ label: row.label || 'Unknown', clicks: row.clicks }));
  return {
    days,
    countries: label(countries.results || []),
    devices: label(devices.results || []),
    browsers: label(browsers.results || []),
    referrers: label(referrers.results || []),
    bands: label(bands.results || []),
    rawStored: storedRow?.count || 0,
    rawTotal: days.reduce((sum, row) => sum + row.clicks, 0),
  };
}

// ---- F13: export centre ---------------------------------------------------

export const EXPORT_DATASETS = ['clicks', 'conversions', 'sessions', 'postbacks'] as const;
export type ExportDataset = typeof EXPORT_DATASETS[number];
export const EXPORT_ROW_LIMIT = 3000;

function exportSource(dataset: ExportDataset, filters: TrackingFilters): { fromSql: string; whereSql: string; binds: unknown[]; orderSql: string } {
  const where: string[] = [];
  const binds: unknown[] = [];
  let fromSql = '', orderSql = 'ORDER BY id DESC';
  if (dataset === 'clicks') {
    fromSql = 'FROM tr_clicks';
    where.push('date(ts) BETWEEN ? AND ?'); binds.push(filters.from, filters.to);
    if (filters.link) { where.push('slug=?'); binds.push(filters.link); }
    if (filters.country) { where.push('country=?'); binds.push(filters.country); }
    if (filters.device) { where.push('device_type=?'); binds.push(filters.device); }
  } else if (dataset === 'conversions') {
    fromSql = 'FROM tr_conversions';
    where.push('date(ts_received) BETWEEN ? AND ?'); binds.push(filters.from, filters.to);
    if (filters.network) { where.push('network=?'); binds.push(filters.network); }
  } else if (dataset === 'sessions') {
    fromSql = 'FROM tr_sessions';
    where.push('date(started_at) BETWEEN ? AND ?'); binds.push(filters.from, filters.to);
    orderSql = 'ORDER BY started_at DESC';
  } else {
    fromSql = 'FROM tr_postbacks_raw';
    where.push('date(ts) BETWEEN ? AND ?'); binds.push(filters.from, filters.to);
    if (filters.network) { where.push('network=?'); binds.push(filters.network); }
  }
  return { fromSql, whereSql: where.length ? ` WHERE ${where.join(' AND ')}` : '', binds, orderSql };
}

export async function exportCount(db: D1Database, dataset: ExportDataset, filters: TrackingFilters): Promise<number> {
  const source = exportSource(dataset, filters);
  const row = await db.prepare(`SELECT COUNT(*) AS count ${source.fromSql}${source.whereSql}`).bind(...source.binds).first<{ count: number }>();
  return row?.count || 0;
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export interface BuiltExport { body: string; filename: string; contentType: string; rows: number }

export async function buildExport(env: { DB: D1Database }, dataset: ExportDataset, filters: TrackingFilters, format: 'csv' | 'json', includeIp: boolean): Promise<BuiltExport> {
  const count = await exportCount(env.DB, dataset, filters);
  if (count > EXPORT_ROW_LIMIT) {
    throw new Error(`This export has ${count.toLocaleString()} rows, over the ${EXPORT_ROW_LIMIT.toLocaleString()}-row limit. Narrow your filters.`);
  }
  const source = exportSource(dataset, filters);
  const result = await env.DB.prepare(`SELECT * ${source.fromSql}${source.whereSql} ${source.orderSql} LIMIT ${EXPORT_ROW_LIMIT}`).bind(...source.binds)
    .all<Record<string, unknown>>();
  let rows = result.results || [];
  if (dataset === 'clicks' && !includeIp) rows = rows.map(({ ip, ...rest }) => rest);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (format === 'json') {
    return { body: JSON.stringify(rows, null, 1), filename: `screenpeek-${dataset}-${stamp}.json`, contentType: 'application/json; charset=utf-8', rows: rows.length };
  }
  const columns = rows.length ? Object.keys(rows[0]) : ['id'];
  const body = [columns.join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\n') + '\n';
  return { body, filename: `screenpeek-${dataset}-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', rows: rows.length };
}

// ---- F18: variant editor data + A/B readout --------------------------------

export interface VariantStats { variantId: number; clicks: number; conversions: number; revenueMinor: number; cr: number; epc: number }
export interface TrackingVariantsData {
  slugs: Array<{ slug: string; name: string }>;
  slug: string;
  variants: Array<Record<string, unknown>>;
  stats: VariantStats[];
  settings: { autoopt: number; safe_url: string };
  leaderId: number | null;
  minSample: number;
}

export async function trackingVariants(env: { DB: D1Database }, url: URL, minSample: number): Promise<TrackingVariantsData> {
  const db = env.DB;
  const slugs = await db.prepare("SELECT slug, name FROM links WHERE deleted_at IS NULL ORDER BY slug").all<{ slug: string; name: string }>();
  const slug = (url.searchParams.get('link') || slugs.results?.[0]?.slug || '').slice(0, 120);
  const variants = slug
    ? (await db.prepare('SELECT * FROM tr_link_variants WHERE link_slug=? ORDER BY chain_order, id').bind(slug).all<Record<string, unknown>>()).results || []
    : [];
  const stats: VariantStats[] = [];
  for (const variant of variants) {
    const id = Number(variant.id);
    const clicks = await db.prepare("SELECT COUNT(*) AS count FROM tr_clicks WHERE variant_id=? AND ts >= datetime('now','-7 days')").bind(id).first<{ count: number }>();
    const conv = await db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(c.payout_minor),0) AS revenue FROM tr_conversions c
      JOIN tr_clicks k ON k.click_id=c.click_id WHERE k.variant_id=? AND c.ts_received >= datetime('now','-7 days') AND c.status_mapped <> 'late'`).bind(id).first<{ count: number; revenue: number }>();
    const clickCount = clicks?.count || 0;
    const convCount = conv?.count || 0;
    stats.push({
      variantId: id, clicks: clickCount, conversions: convCount, revenueMinor: conv?.revenue || 0,
      cr: clickCount ? Math.round((convCount / clickCount) * 10000) / 100 : 0,
      epc: clickCount ? Math.round(((conv?.revenue || 0) / clickCount)) / 100 : 0,
    });
  }
  // Honest A/B readout: a leader is only called when EVERY variant has
  // at least the minimum sample; otherwise no winner is claimed.
  let leaderId: number | null = null;
  if (stats.length > 1 && stats.every(row => row.clicks >= minSample)) {
    leaderId = stats.reduce((best, row) => (row.epc > best.epc ? row : best), stats[0]).variantId;
  }
  const settings = slug
    ? await db.prepare('SELECT autoopt, safe_url FROM tr_link_settings WHERE slug=?').bind(slug).first<{ autoopt: number; safe_url: string }>()
    : null;
  return {
    slugs: slugs.results || [], slug, variants, stats,
    settings: { autoopt: settings?.autoopt || 0, safe_url: settings?.safe_url || '' },
    leaderId, minSample,
  };
}

// ---- F24: funnels -----------------------------------------------------------

export interface FunnelStep { event: string; label: string }
export interface FunnelChain { network: string; steps: FunnelStep[] }
export interface TrackingFunnelsData {
  chains: FunnelChain[];
  network: string;
  steps: FunnelStep[];
  rows: Array<{ slug: string; clicks: number; counts: number[]; rates: Array<number | null> }>;
}

/** tracking_funnels JSON: network → ordered events, each either a plain
 * event name or { event, label }. Anything malformed is skipped. */
export function parseFunnels(json: string): FunnelChain[] {
  try {
    const parsed: unknown = JSON.parse(json || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const chains: FunnelChain[] = [];
    for (const [network, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(raw)) continue;
      const steps: FunnelStep[] = [];
      for (const item of raw) {
        if (typeof item === 'string' && item) steps.push({ event: item, label: item });
        else if (item && typeof item === 'object' && typeof (item as { event?: unknown }).event === 'string') {
          const record = item as { event: string; label?: unknown };
          steps.push({ event: record.event, label: typeof record.label === 'string' && record.label ? record.label : record.event });
        }
      }
      if (steps.length) chains.push({ network, steps });
    }
    return chains;
  } catch { return []; }
}

/** Per-link funnel: stored clicks → each configured event in order, with
 * the step conversion rate against the previous step (clicks for the
 * first step). Counts come from stored raw rows, like the other
 * breakdowns; networks without a configured chain keep the plain
 * single-event Conversions list (gate G24.4). */
export async function trackingFunnels(db: D1Database, filters: TrackingFilters, funnelsJson: string, networkParam: string): Promise<TrackingFunnelsData> {
  const chains = parseFunnels(funnelsJson);
  const chain = chains.find(item => item.network === networkParam) || chains[0];
  if (!chain) return { chains, network: '', steps: [], rows: [] };
  const clickRows = await db.prepare('SELECT slug, COUNT(*) AS count FROM tr_clicks WHERE date(ts) BETWEEN ? AND ? GROUP BY slug')
    .bind(filters.from, filters.to).all<{ slug: string; count: number }>();
  const convRows = await db.prepare(`SELECT k.slug AS slug, c.event AS event, COUNT(*) AS count FROM tr_conversions c
    JOIN tr_clicks k ON k.click_id=c.click_id
    WHERE c.network=? AND date(c.ts_received) BETWEEN ? AND ? GROUP BY k.slug, c.event`)
    .bind(chain.network, filters.from, filters.to).all<{ slug: string; event: string; count: number }>();
  const convBySlug = new Map<string, Map<string, number>>();
  for (const row of convRows.results || []) {
    if (!convBySlug.has(row.slug)) convBySlug.set(row.slug, new Map());
    convBySlug.get(row.slug)!.set(row.event, row.count);
  }
  const slugs = new Set<string>([...(clickRows.results || []).map(row => row.slug), ...convBySlug.keys()]);
  const rows = [...slugs].map(slug => {
    const clicks = (clickRows.results || []).find(row => row.slug === slug)?.count || 0;
    const counts = chain.steps.map(step => convBySlug.get(slug)?.get(step.event) || 0);
    const rates = counts.map((count, index) => {
      const base = index === 0 ? clicks : counts[index - 1];
      return base > 0 ? Math.round((count / base) * 1000) / 10 : null;
    });
    return { slug, clicks, counts, rates };
  }).sort((a, b) => b.clicks - a.clicks);
  return { chains, network: chain.network, steps: chain.steps, rows };
}

// ---- F25: cost, profit, ROI --------------------------------------------------

export interface CostRule { cpcMinor: number; currency: string }
export interface ProfitRow {
  slug: string;
  currency: string;
  revenueMinor: number;
  costMinor: number | null; // null = no cost data at all — the UI shows "—", never 0
  profitMinor: number | null;
  roiPct: number | null;
}

/** tracking_cost_rules JSON: source token (the click's sub1) →
 * { cpc_minor, currency }. The "default" key prices clicks with no
 * sub1. Malformed entries are skipped. */
export function parseCostRules(json: string): Map<string, CostRule> {
  const rules = new Map<string, CostRule>();
  try {
    const parsed: unknown = JSON.parse(json || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rules;
    for (const [token, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const cpcMinor = typeof record.cpc_minor === 'number' && Number.isFinite(record.cpc_minor) ? Math.max(0, Math.round(record.cpc_minor)) : 0;
      const currency = typeof record.currency === 'string' && /^[A-Za-z]{3}$/.test(record.currency) ? record.currency.toUpperCase() : 'USD';
      if (cpcMinor > 0) rules.set(token, { cpcMinor, currency });
    }
  } catch { /* empty rules */ }
  return rules;
}

/**
 * Profit per link and currency — currencies are NEVER summed together.
 * Revenue comes from the daily aggregates (100% of traffic). Cost is
 * imported rows from tr_cost_daily plus CPC-rule cost over stored
 * clicks (clicks × the rule for their source token). A link/currency
 * with revenue but no cost source at all reports cost as null.
 */
export async function trackingProfit(db: D1Database, filters: TrackingFilters, costRulesJson: string): Promise<ProfitRow[]> {
  const revenue = await db.prepare(`SELECT slug, currency, SUM(revenue_minor) AS revenue FROM tr_click_daily
    WHERE day BETWEEN ? AND ? AND currency <> '' GROUP BY slug, currency`)
    .bind(filters.from, filters.to).all<{ slug: string; currency: string; revenue: number }>();
  const costs = new Map<string, number>();
  const addCost = (slug: string, currency: string, minor: number) => {
    const key = `${slug}|${currency}`;
    costs.set(key, (costs.get(key) || 0) + minor);
  };
  const imported = await db.prepare('SELECT link_slug, currency, SUM(cost_minor) AS cost FROM tr_cost_daily WHERE day BETWEEN ? AND ? GROUP BY link_slug, currency')
    .bind(filters.from, filters.to).all<{ link_slug: string; currency: string; cost: number }>();
  for (const row of imported.results || []) addCost(row.link_slug, row.currency, row.cost);
  const rules = parseCostRules(costRulesJson);
  if (rules.size) {
    const clickRows = await db.prepare('SELECT slug, sub1, COUNT(*) AS count FROM tr_clicks WHERE date(ts) BETWEEN ? AND ? GROUP BY slug, sub1')
      .bind(filters.from, filters.to).all<{ slug: string; sub1: string; count: number }>();
    for (const row of clickRows.results || []) {
      const rule = rules.get(row.sub1 || '') || (row.sub1 ? undefined : rules.get('default'));
      if (rule) addCost(row.slug, rule.currency, rule.cpcMinor * row.count);
    }
  }
  const rows: ProfitRow[] = [];
  const seen = new Set<string>();
  for (const row of revenue.results || []) {
    const key = `${row.slug}|${row.currency}`;
    seen.add(key);
    const cost = costs.has(key) ? costs.get(key)! : null;
    rows.push({
      slug: row.slug, currency: row.currency, revenueMinor: row.revenue,
      costMinor: cost,
      profitMinor: cost === null ? null : row.revenue - cost,
      roiPct: cost !== null && cost > 0 ? Math.round(((row.revenue - cost) / cost) * 1000) / 10 : null,
    });
  }
  // Cost-only rows (spend with no recorded revenue) still surface.
  for (const [key, cost] of costs) {
    if (seen.has(key)) continue;
    const [slug, currency] = key.split('|');
    rows.push({ slug, currency, revenueMinor: 0, costMinor: cost, profitMinor: -cost, roiPct: -100 });
  }
  return rows.sort((a, b) => a.slug.localeCompare(b.slug) || a.currency.localeCompare(b.currency));
}
