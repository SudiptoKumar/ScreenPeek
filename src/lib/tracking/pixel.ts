/**
 * ScreenPeek Insight — browser pixel conversions (F22, docs/06).
 *
 * GET /api/pixel/<network>?cid=&event=&payout=&cur=&txid= for networks
 * that cannot do server-to-server postbacks. Match order: explicit cid
 * → the sp_vid cookie's clicks inside the attribution window (mode
 * first|last) → unmatched (logged, nothing stored). Conversions are
 * stored with source='pixel' and the same dedupe and status mapping as
 * S2S. The endpoint answers a 1×1 GIF (or 204 for the JS variant) and
 * is rate-limited per IP like the beacon.
 */
import { readTrackingConfig } from './config.ts';
import { mapStatus, payoutToMinor, recordConversion } from './postback.ts';
import { clientInfo } from './parse.ts';

export const PIXEL_GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  character => character.charCodeAt(0),
);

export interface PixelOutcome { status: number; result: string }

const cookieValue = (request: Request, name: string): string => {
  const match = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
};

async function logRaw(env: { DB: D1Database }, network: string, params: URLSearchParams, result: string) {
  const stored: Record<string, string> = {};
  for (const [key, value] of params.entries()) stored[key] = value.slice(0, 500);
  try {
    await env.DB.prepare('INSERT INTO tr_postbacks_raw(network,params_json,result) VALUES(?,?,?)')
      .bind(network, JSON.stringify({ ...stored, source: 'pixel' }), result).run();
  } catch { /* the raw log must never break the pixel */ }
}

export async function ingestPixel(
  env: { DB: D1Database; CONFIG: KVNamespace; background?: (promise: Promise<unknown>) => void },
  network: string,
  request: Request,
  params: URLSearchParams,
): Promise<PixelOutcome> {
  const cfg = await readTrackingConfig(env.DB);
  if (!cfg.enabled) return { status: 404, result: 'dark' };

  // Per-IP soft rate cap, same shape as the beacon's.
  const info = clientInfo(request);
  const minute = new Date().toISOString().slice(0, 16);
  const rlKey = `sp_pxl:${info.ip || 'unknown'}:${minute}`;
  try {
    const hits = Number(await env.CONFIG.get(rlKey)) || 0;
    if (hits > 60) return { status: 204, result: 'rate_limited' };
    await env.CONFIG.put(rlKey, String(hits + 1), { expirationTtl: 120 });
  } catch { /* best-effort */ }

  const event = (params.get('event') || 'conversion').slice(0, 64);
  const txid = (params.get('txid') || params.get('transaction_id') || '').slice(0, 120);
  const payoutMinor = payoutToMinor(params.get('payout'));
  const currency = (params.get('cur') || params.get('currency') || 'USD').toUpperCase().slice(0, 3);
  const statusRaw = params.get('status') || 'approved';
  const status = mapStatus(statusRaw, cfg.statusMapJson);

  let click: Record<string, unknown> | null = null;
  const cid = (params.get('cid') || params.get('click_id') || '').slice(0, 80);
  if (cid) {
    click = await env.DB.prepare('SELECT * FROM tr_clicks WHERE click_id=?').bind(cid).first<Record<string, unknown>>();
  }
  if (!click) {
    const visitorId = cookieValue(request, 'sp_vid');
    if (visitorId) {
      const order = cfg.attributionMode === 'first' ? 'ASC' : 'DESC';
      click = await env.DB.prepare(
        `SELECT * FROM tr_clicks WHERE visitor_id=? AND ts >= datetime('now', ?) ORDER BY ts ${order} LIMIT 1`,
      ).bind(visitorId, `-${cfg.attributionWindowDays} days`).first<Record<string, unknown>>();
    }
  }
  if (!click) {
    await logRaw(env, network, params, 'unmatched_pixel');
    return { status: 200, result: 'unmatched' };
  }
  const created = await recordConversion(env, {
    click, network, event, payoutMinor, currency, status, statusRaw,
    txid: txid || `px-${String(click.click_id)}-${event}`, source: 'pixel',
    attributionWindowDays: cfg.attributionWindowDays,
  });
  await logRaw(env, network, params, created ? 'matched' : 'duplicate');
  return { status: 200, result: created ? 'matched' : 'duplicate' };
}
