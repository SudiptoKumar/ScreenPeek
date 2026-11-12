// ScreenPeek Insight — beacon ingestion (F7).
//
// POST /api/beacon. Fixed schema: unknown keys are dropped server-side
// (gate G7.3), garbage gets a safe 204 with nothing stored (G7.2), and
// the endpoint answers 404 while the module is dark. Events are stored
// under the quota engine; session summaries and the tr_page_daily
// aggregate are maintained from the stored events only.

import { readTrackingConfig, type TrackingConfig } from './config.ts';
import { QuotaEngine } from './quota.ts';
import { clientInfo, parseUserAgent } from './parse.ts';
import { consentAllows, resolveIdentity } from './identity.ts';
import { browserTzMismatch, computeDisguise, languageCountryMismatch } from './disguise.ts';

export const BEACON_BODY_CAP = 4096;
const EVENT_TYPES = new Set(['pageview', 'scroll', 'cta', 'exit']);

const STRING_KEYS = ['page_url', 'page_type', 'title_id', 'referrer', 'orientation', 'browser_timezone',
  'languages', 'connection_type', 'webgl_renderer', 'canvas_hash', 'audio_hash', 'webgpu_vendor', 'webrtc_ip', 'cta'] as const;
const NUMBER_KEYS = ['screen_w', 'screen_h', 'avail_w', 'avail_h', 'viewport_w', 'viewport_h', 'dpr',
  'color_depth', 'cpu_cores', 'ram_bucket_gb', 'touch_points', 'downlink_mbps', 'rtt_ms', 'save_data',
  'dark_mode', 'reduced_motion', 'scroll_pct', 'duration_s', 'max_scroll_pct', 'is_webdriver',
  'plugins_count', 'pdf_viewer', 'battery_level', 'battery_charging'] as const;

export interface BeaconEvent {
  type: string;
  strings: Record<string, string>;
  numbers: Record<string, number | null>;
  mediaDevices: { audioinput: number; videoinput: number; audiooutput: number } | null;
}

/** Whitelist-sanitize one payload. Returns null for anything unusable. */
export function sanitizeBeacon(raw: unknown): BeaconEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const type = typeof input.type === 'string' ? input.type : '';
  if (!EVENT_TYPES.has(type)) return null;
  const strings: Record<string, string> = {};
  for (const key of STRING_KEYS) if (typeof input[key] === 'string') strings[key] = (input[key] as string).slice(0, 500);
  const numbers: Record<string, number | null> = {};
  for (const key of NUMBER_KEYS) {
    const value = input[key];
    numbers[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  let mediaDevices: BeaconEvent['mediaDevices'] = null;
  const media = input.media_devices;
  if (media && typeof media === 'object' && !Array.isArray(media)) {
    const counts = media as Record<string, unknown>;
    const pick = (key: string) => (typeof counts[key] === 'number' && Number.isFinite(counts[key]) ? counts[key] as number : 0);
    mediaDevices = { audioinput: pick('audioinput'), videoinput: pick('videoinput'), audiooutput: pick('audiooutput') };
  }
  return { type, strings, numbers, mediaDevices };
}

export interface BeaconOutcome { status: number; setCookies: string[] }

const NO_STORE: BeaconOutcome = { status: 204, setCookies: [] };

export async function ingestBeacon(env: { DB: D1Database; CONFIG: KVNamespace }, request: Request): Promise<BeaconOutcome> {
  const cfg: TrackingConfig = await readTrackingConfig(env.DB);
  if (!cfg.enabled) return { status: 404, setCookies: [] };
  const body = await request.text();
  if (body.length > BEACON_BODY_CAP) return NO_STORE;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return NO_STORE; }
  const event = sanitizeBeacon(parsed);
  if (!event) return NO_STORE;
  if (!consentAllows(request, cfg.consentMode)) return NO_STORE;

  const identity = resolveIdentity(request, cfg.consentMode);
  const info = clientInfo(request);
  const now = new Date();
  const nowSql = now.toISOString().replace('T', ' ').slice(0, 19);
  const day = nowSql.slice(0, 10);

  // Per-IP soft rate cap (docs/01): bursts beyond 60/minute are dropped.
  const rlKey = `sp_rl:${info.ip || 'unknown'}:${nowSql.slice(0, 16)}`;
  try {
    const hits = Number(await env.CONFIG.get(rlKey)) || 0;
    if (hits > 60) return { status: 204, setCookies: identity.setCookies };
    await env.CONFIG.put(rlKey, String(hits + 1), { expirationTtl: 120 });
  } catch { /* rate limiting is best-effort */ }

  const engine = new QuotaEngine(env.CONFIG, async degraded => {
    try {
      await env.DB.prepare("UPDATE config SET value=?, revision=revision+1 WHERE key='tracking_degraded'").bind(degraded ? '1' : '0').run();
      await env.CONFIG.put('config:tracking_degraded', degraded ? '1' : '0');
    } catch { /* best-effort */ }
  });
  const quota = await engine.decide({ kind: 'event', country: info.country }, cfg, now);
  if (quota.decision === 'skip') return { status: 204, setCookies: identity.setCookies };

  const s = event.strings, n = event.numbers;
  const payload = { ...s, ...n, media_devices: event.mediaDevices, type: event.type };
  const ua = parseUserAgent(request.headers.get('User-Agent') || '');
  const sessionId = identity.sessionId;
  const statements: D1PreparedStatement[] = [];
  statements.push(env.DB.prepare(
    `INSERT INTO tr_events(session_id,visitor_id,page_url,page_type,title_id,event_type,referrer,
     screen_w,screen_h,avail_w,avail_h,viewport_w,viewport_h,dpr,color_depth,orientation,browser_timezone,
     languages,cpu_cores,ram_bucket_gb,touch_points,connection_type,downlink_mbps,rtt_ms,save_data,
     dark_mode,reduced_motion,webgl_renderer,canvas_hash,payload_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(sessionId, identity.visitorId, s.page_url || '', s.page_type || '', s.title_id || '', event.type, s.referrer || '',
    n.screen_w, n.screen_h, n.avail_w, n.avail_h, n.viewport_w, n.viewport_h, n.dpr, n.color_depth,
    s.orientation || '', s.browser_timezone || '', s.languages || '', n.cpu_cores, n.ram_bucket_gb, n.touch_points,
    s.connection_type || '', n.downlink_mbps, n.rtt_ms, n.save_data, n.dark_mode, n.reduced_motion,
    s.webgl_renderer || '', s.canvas_hash || '', JSON.stringify(payload)));

  if (sessionId) {
    if (event.type === 'pageview') {
      statements.push(env.DB.prepare(
        `INSERT INTO tr_sessions(session_id,visitor_id,started_at,last_seen_at,pageviews,entry_page,exit_page,
         device_type,country,browser,os,screen_w,screen_h,browser_timezone)
         VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, pageviews=pageviews+1, exit_page=excluded.exit_page`,
      ).bind(sessionId, identity.visitorId, nowSql, nowSql, s.page_url || '', s.page_url || '',
        ua.deviceType, info.country.toUpperCase(), ua.browser, ua.os, n.screen_w, n.screen_h, s.browser_timezone || ''));
      // Page aggregate: pageviews always; unique session counted when this
      // session has no earlier stored pageview for the same page today.
      const earlier = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tr_events WHERE session_id=? AND page_url=? AND event_type='pageview' AND date(ts_received)=?",
      ).bind(sessionId, s.page_url || '', day).first<{ count: number }>();
      statements.push(env.DB.prepare(
        `INSERT INTO tr_page_daily(day,page_type,page_url,pageviews,unique_sessions) VALUES(?,?,?,?,?)
         ON CONFLICT(day,page_type,page_url) DO UPDATE SET pageviews=pageviews+1, unique_sessions=unique_sessions+excluded.unique_sessions`,
      ).bind(day, s.page_type || '', s.page_url || '', 1, earlier && earlier.count > 0 ? 0 : 1));
    } else if (event.type === 'scroll') {
      statements.push(env.DB.prepare(
        'UPDATE tr_sessions SET max_scroll_pct=MAX(max_scroll_pct,?), last_seen_at=? WHERE session_id=?',
      ).bind(n.scroll_pct ?? 0, nowSql, sessionId));
    } else if (event.type === 'exit') {
      statements.push(env.DB.prepare(
        'UPDATE tr_sessions SET total_duration_s=total_duration_s+?, max_scroll_pct=MAX(max_scroll_pct,?), exit_page=?, last_seen_at=? WHERE session_id=?',
      ).bind(n.duration_s ?? 0, n.max_scroll_pct ?? 0, s.page_url || '', nowSql, sessionId));
      statements.push(env.DB.prepare(
        `UPDATE tr_page_daily SET avg_duration_s=(avg_duration_s*MAX(pageviews-1,0)+?)/MAX(pageviews,1),
         avg_max_scroll_pct=(avg_max_scroll_pct*MAX(pageviews-1,0)+?)/MAX(pageviews,1) WHERE day=? AND page_url=?`,
      ).bind(n.duration_s ?? 0, n.max_scroll_pct ?? 0, day, s.page_url || ''));
    } else if (event.type === 'cta') {
      statements.push(env.DB.prepare(
        `INSERT INTO tr_page_daily(day,page_type,page_url,cta_clicks) VALUES(?,?,?,1)
         ON CONFLICT(day,page_type,page_url) DO UPDATE SET cta_clicks=cta_clicks+1`,
      ).bind(day, s.page_type || '', s.page_url || ''));
      statements.push(env.DB.prepare('UPDATE tr_sessions SET last_seen_at=? WHERE session_id=?').bind(nowSql, sessionId));
    }
  }
  await env.DB.batch(statements);
  // Consistency-score refresh (F16): once browser-side session data
  // lands, recompute the score for clicks in this session with the
  // fuller signal set. Best-effort — a failure never affects the beacon.
  if (sessionId && event.type === 'pageview' && (s.browser_timezone || s.languages || s.webrtc_ip)) {
    try {
      const clicks = await env.DB.prepare('SELECT click_id, country, ip, conn_class, trust_score FROM tr_clicks WHERE session_id=?')
        .bind(sessionId).all<{ click_id: string; country: string; ip: string; conn_class: string; trust_score: number | null }>();
      for (const click of clicks.results || []) {
        const verdict = computeDisguise({
          tzMismatch: browserTzMismatch(s.browser_timezone || '', click.country),
          languageMismatch: languageCountryMismatch(s.languages || '', click.country),
          webrtcMismatch: Boolean(s.webrtc_ip) && Boolean(click.ip) && !String(click.ip).startsWith('0.') && s.webrtc_ip !== click.ip,
          connClass: click.conn_class,
          trustScore: click.trust_score,
        }, cfg.disguiseWeightsJson);
        await env.DB.prepare('UPDATE tr_clicks SET disguise_score=?, disguise_reasons=? WHERE click_id=?')
          .bind(verdict.score, JSON.stringify(verdict.reasons), click.click_id).run();
      }
    } catch { /* refresh is best-effort */ }
  }
  return { status: 204, setCookies: identity.setCookies };
}
