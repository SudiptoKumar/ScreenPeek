// ScreenPeek Insight — /go/ click capture (F3).
//
// Runs in the background (waitUntil) so the 302 is never delayed. One raw
// row per click when the quota engine allows storage; the tr_click_daily
// aggregate is upserted either way, so admin totals always count 100% of
// clicks. Any failure is swallowed to a warning — a tracking fault must
// never affect the visitor flow (docs/01 failure behaviour).

import { readTrackingConfig, type TrackingConfig } from './config.ts';
import { QuotaEngine } from './quota.ts';
import { connClassFromOrg, flagsForSignals, tzCountryMismatch } from './quality.ts';
import { clientInfo, classifyReferrer, maskIp, parseUserAgent } from './parse.ts';

export const newClickId = () => crypto.randomUUID();

export interface ClickCaptureInput {
  request: Request;
  slug: string;
  linkName: string;
  linkType: string;
  /** The resolved destination BEFORE any click-id param is appended. */
  destination: string;
  routeReason: string;
  clickId: string;
  variantId?: number | null;
  isTest?: boolean;
  /** Identity overrides (F5): when the handler minted ids for this very
   * request, the row carries them even though the request had no cookies. */
  visitorId?: string;
  sessionId?: string;
}

const cookieValue = (request: Request, name: string) =>
  request.headers.get('Cookie')?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1] ?? '';

export function buildClickRow(input: ClickCaptureInput, cfg: TrackingConfig, now = new Date()) {
  const { request } = input;
  const url = new URL(request.url);
  const params = url.searchParams;
  const ua = parseUserAgent(request.headers.get('User-Agent') || '');
  const info = clientInfo(request);
  const referrer = request.headers.get('Referer') || '';
  const ref = classifyReferrer(referrer, url.host);
  let destHost = '';
  try { destHost = new URL(input.destination).hostname; } catch { /* keep empty */ }
  const param = (name: string) => (params.get(name) || '').slice(0, 500);
  return {
    click_id: input.clickId,
    ts: now.toISOString().replace('T', ' ').slice(0, 19),
    slug: input.slug,
    link_name: input.linkName,
    link_type: input.linkType,
    destination: input.destination,
    dest_host: destHost,
    route_reason: input.routeReason,
    ip: maskIp(info.ip, cfg.ipMode),
    country: info.country.toUpperCase(),
    region: info.region,
    city: info.city,
    continent: info.continent,
    postal_code: info.postalCode,
    lat: info.lat,
    lon: info.lon,
    ip_timezone: info.ipTimezone,
    asn: info.asn,
    as_org: info.asOrg,
    http_protocol: info.httpProtocol,
    tls_version: info.tlsVersion,
    trust_score: info.trustScore,
    ua_raw: (request.headers.get('User-Agent') || '').slice(0, 1000),
    browser: ua.browser,
    browser_major: ua.browserMajor,
    os: ua.os,
    os_version: ua.osVersion,
    device_type: ua.deviceType,
    device_brand: ua.deviceBrand,
    device_model: ua.deviceModel,
    language: (request.headers.get('Accept-Language') || '').slice(0, 100),
    referrer,
    referrer_domain: ref.domain,
    referrer_class: ref.cls,
    visitor_id: input.visitorId ?? cookieValue(request, 'sp_vid'),
    session_id: input.sessionId ?? cookieValue(request, 'sp_sid'),
    utm_source: param('utm_source'), utm_medium: param('utm_medium'), utm_campaign: param('utm_campaign'),
    utm_content: param('utm_content'), utm_term: param('utm_term'),
    sub1: param('sub1'), sub2: param('sub2'), sub3: param('sub3'), sub4: param('sub4'), sub5: param('sub5'),
    sp_page: param('sp_page'), sp_title: param('sp_title'),
    is_bot_ua: ua.isBotUa ? 1 : 0,
    is_test: input.isTest ? 1 : 0,
    quality_band: '',
    quality_flags: '[]',
    variant_id: input.variantId ?? null,
    conn_class: '',
    disguise_score: null as number | null,
    disguise_reasons: '[]',
  };
}

const CLICK_COLUMNS = ['click_id', 'ts', 'slug', 'link_name', 'link_type', 'destination', 'dest_host', 'route_reason',
  'ip', 'country', 'region', 'city', 'continent', 'postal_code', 'lat', 'lon', 'ip_timezone', 'asn', 'as_org',
  'http_protocol', 'tls_version', 'trust_score', 'ua_raw', 'browser', 'browser_major', 'os', 'os_version',
  'device_type', 'device_brand', 'device_model', 'language', 'referrer', 'referrer_domain', 'referrer_class',
  'visitor_id', 'session_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'sp_page', 'sp_title', 'is_bot_ua', 'is_test', 'quality_band',
  'quality_flags', 'variant_id', 'conn_class', 'disguise_score', 'disguise_reasons'] as const;

export async function captureClick(env: { DB: D1Database; CONFIG: KVNamespace }, input: ClickCaptureInput & { cfg?: TrackingConfig }): Promise<void> {
  try {
    // Callers on the redirect path pass a config they already read, so
    // the background capture costs no extra config query (gate G3.6).
    const cfg = input.cfg ?? await readTrackingConfig(env.DB);
    if (!cfg.enabled) return;
    const row = buildClickRow(input, cfg);
    const day = row.ts.slice(0, 10);
    const engine = new QuotaEngine(env.CONFIG, async degraded => {
      try {
        await env.DB.prepare("UPDATE config SET value=?, revision=revision+1 WHERE key='tracking_degraded'").bind(degraded ? '1' : '0').run();
        await env.CONFIG.put('config:tracking_degraded', degraded ? '1' : '0');
      } catch { /* flag persistence is best-effort */ }
    });
    const quota = await engine.decide({ kind: 'click', country: row.country }, cfg);
    const statements: D1PreparedStatement[] = [];
    let uniqueAdd = 0;
    if (quota.decision === 'store') {
      // One combined lookup feeds both the unique-visitor aggregate and
      // the quality verdict, so a stored click costs three D1 calls in
      // total (config, this lookup, one batch). Quality flags are
      // computed here, before the insert — flag-only, never read by any
      // visitor-facing path.
      const lookup = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM tr_clicks v WHERE v.ip=?1 AND ?1<>'' AND v.ts >= datetime('now','-1 hour')) AS velocity,
           (SELECT s.browser_timezone FROM tr_sessions s WHERE s.session_id=?2) AS session_tz,
           (SELECT 1 FROM tr_clicks u WHERE u.visitor_id=?3 AND u.slug=?4 AND date(u.ts)=?5 LIMIT 1) AS seen`,
      ).bind(row.ip, row.session_id, row.visitor_id, row.slug, day).first<{ velocity: number; session_tz: string | null; seen: number | null }>();
      uniqueAdd = row.visitor_id && !lookup?.seen ? 1 : 0;
      const verdict = flagsForSignals({
        isBotUa: row.is_bot_ua === 1,
        connClass: connClassFromOrg(row.as_org),
        trustScore: row.trust_score,
        tzMismatch: tzCountryMismatch(lookup?.session_tz || '', row.ip_timezone, row.country),
        velocityPerHour: (lookup?.velocity || 0) + 1,
        noReferrerOnSiteClick: Boolean(row.sp_page) && !row.referrer,
      }, cfg.qualityWeightsJson);
      row.quality_flags = JSON.stringify(verdict.flags);
      row.quality_band = verdict.band;
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO tr_clicks(${CLICK_COLUMNS.join(',')}) VALUES(${CLICK_COLUMNS.map(() => '?').join(',')})`,
      ).bind(...CLICK_COLUMNS.map(column => row[column])));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO tr_click_daily(day,slug,country,device_type,dest_host,currency,clicks,unique_visitors) VALUES(?,?,?,?,?,'',1,?)
       ON CONFLICT(day,slug,country,device_type,dest_host,currency) DO UPDATE SET clicks=clicks+1, unique_visitors=unique_visitors+excluded.unique_visitors`,
    ).bind(day, row.slug, row.country, row.device_type, row.dest_host, uniqueAdd));
    await env.DB.batch(statements);
  } catch { console.warn('Insight click capture was unavailable.'); }
}
