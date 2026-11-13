/**
 * ScreenPeek Insight — reporting API (F26, docs/06).
 *
 * Read-only JSON: GET /api/insight/stats and /api/insight/clicks.
 * The config key tracking_api_key holds the NAME of a platform secret;
 * the key value lives only in that secret and is compared server-side,
 * never stored or logged. Until a name is configured AND the secret
 * exists, the API answers 404 (disabled). A configured API with a
 * missing or wrong key answers 401. Clicks follow the export rules:
 * same filters, same 3,000-row cap (with the cap stated in the
 * response), and IP addresses are never included.
 */

export interface InsightApiFilters { from: string; to: string; link: string; country: string; device: string }

const dateParam = (url: URL, name: string, fallback: string) => {
  const value = (url.searchParams.get(name) || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
};

export function insightApiFilters(url: URL): InsightApiFilters {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const clean = (name: string, max = 60) => (url.searchParams.get(name) || '').slice(0, max);
  return {
    from: dateParam(url, 'from', weekAgo), to: dateParam(url, 'to', today),
    link: clean('link', 120), country: clean('country', 4).toUpperCase(), device: clean('device', 20),
  };
}

export async function authorizeInsightApi(
  env: { DB: D1Database } & Record<string, unknown>,
  request: Request,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key='tracking_api_key'").first<{ value: string }>().catch(() => null);
  const secretName = (row?.value || '').trim();
  if (!secretName) return { ok: false, status: 404, message: 'The reporting API is disabled — no API key secret name is configured in Tracking Settings.' };
  const expected = env[secretName];
  if (typeof expected !== 'string' || !expected) return { ok: false, status: 404, message: 'The reporting API is disabled — the configured secret does not exist yet.' };
  const provided = request.headers.get('X-Insight-Key') || new URL(request.url).searchParams.get('key') || '';
  if (!provided || provided !== expected) return { ok: false, status: 401, message: 'Missing or wrong API key.' };
  return { ok: true };
}

export async function insightStats(db: D1Database, filters: InsightApiFilters) {
  const days = await db.prepare(`SELECT day, SUM(clicks) AS clicks, SUM(conversions) AS conversions FROM tr_click_daily
    WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`).bind(filters.from, filters.to)
    .all<{ day: string; clicks: number; conversions: number }>();
  const revenue = await db.prepare(`SELECT currency, SUM(revenue_minor) AS revenueMinor FROM tr_click_daily
    WHERE day BETWEEN ? AND ? AND currency <> '' GROUP BY currency`).bind(filters.from, filters.to)
    .all<{ currency: string; revenueMinor: number }>();
  const pages = await db.prepare('SELECT COALESCE(SUM(pageviews),0) AS pageviews, COALESCE(SUM(unique_sessions),0) AS sessions FROM tr_page_daily WHERE day BETWEEN ? AND ?')
    .bind(filters.from, filters.to).first<{ pageviews: number; sessions: number }>();
  const dayRows = days.results || [];
  return {
    range: { from: filters.from, to: filters.to },
    totals: {
      clicks: dayRows.reduce((sum, row) => sum + row.clicks, 0),
      conversions: dayRows.reduce((sum, row) => sum + row.conversions, 0),
      revenueByCurrency: revenue.results || [],
      pageviews: pages?.pageviews || 0,
      sessions: pages?.sessions || 0,
    },
    days: dayRows,
  };
}

export const INSIGHT_CLICKS_CAP = 3000;

export async function insightClicks(db: D1Database, filters: InsightApiFilters) {
  const where = ['date(ts) BETWEEN ? AND ?'];
  const binds: unknown[] = [filters.from, filters.to];
  if (filters.link) { where.push('slug=?'); binds.push(filters.link); }
  if (filters.country) { where.push('country=?'); binds.push(filters.country); }
  if (filters.device) { where.push('device_type=?'); binds.push(filters.device); }
  const whereSql = ` WHERE ${where.join(' AND ')}`;
  const total = (await db.prepare(`SELECT COUNT(*) AS count FROM tr_clicks${whereSql}`).bind(...binds).first<{ count: number }>())?.count || 0;
  const rows = await db.prepare(`SELECT * FROM tr_clicks${whereSql} ORDER BY id DESC LIMIT ${INSIGHT_CLICKS_CAP}`)
    .bind(...binds).all<Record<string, unknown>>();
  const cleaned = (rows.results || []).map(row => {
    const copy = { ...row };
    delete copy.ip; // IP addresses never leave through the API
    return copy;
  });
  const capped = total > INSIGHT_CLICKS_CAP;
  return {
    range: { from: filters.from, to: filters.to },
    total,
    capped,
    message: capped ? `Result capped at ${INSIGHT_CLICKS_CAP.toLocaleString()} rows — narrow your filters (from/to, link, country, device).` : undefined,
    rows: cleaned,
  };
}
