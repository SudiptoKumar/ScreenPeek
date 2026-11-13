// ScreenPeek Insight — inbound postbacks + conversions (F8).
//
// GET/POST /api/postback/<network>. The per-network secret lives ONLY as
// a platform secret named TRACKING_PB_SECRET_<NETWORK>; its value is
// never written to tr_postbacks_raw (the raw log stores the parameters
// with the secret fields removed). Every call is logged raw with a
// result of matched | duplicate | unknown_click | bad_secret. Duplicate
// deliveries never double-count: the conversion insert is guarded by
// UNIQUE(click_id, txid, event) and aggregates move only on first insert.

import { readTrackingConfig } from './config.ts';

export interface PostbackOutcome { http: number; result: string; body: string }

const DEFAULT_STATUS_MAP: Record<string, string> = {
  approved: 'approved', approve: 'approved', confirmed: 'approved', paid: 'approved', sale: 'approved', complete: 'approved',
  pending: 'pending', hold: 'pending', review: 'pending',
  rejected: 'rejected', reject: 'rejected', declined: 'rejected', denied: 'rejected', chargeback: 'rejected', fraud: 'rejected',
  refund: 'refunded', refunded: 'refunded',
};

export function mapStatus(raw: string, overridesRaw: string): string {
  let overrides: Record<string, string> = {};
  try { overrides = JSON.parse(overridesRaw || '{}') as Record<string, string>; } catch { overrides = {}; }
  const key = raw.trim().toLowerCase();
  return overrides[key] || DEFAULT_STATUS_MAP[key] || 'pending';
}

/** "12.50" -> 1250 minor units; garbage -> 0. */
export function payoutToMinor(raw: string | null): number {
  const value = Number.parseFloat(raw || '');
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

const SECRET_KEYS = ['key', 'secret', 'token'];

export async function ingestPostback(
  env: { DB: D1Database; CONFIG?: KVNamespace } & Record<string, unknown>,
  network: string,
  params: URLSearchParams,
): Promise<PostbackOutcome> {
  const cfg = await readTrackingConfig(env.DB);
  if (!cfg.enabled) return { http: 404, result: 'dark', body: 'Not found' };

  const storedParams: Record<string, string> = {};
  for (const [key, value] of params.entries()) if (!SECRET_KEYS.includes(key.toLowerCase())) storedParams[key] = value.slice(0, 500);
  const logRaw = async (result: string) => {
    try {
      await env.DB.prepare('INSERT INTO tr_postbacks_raw(network,params_json,result) VALUES(?,?,?)')
        .bind(network, JSON.stringify(storedParams), result).run();
    } catch { /* the raw log must never break the response */ }
  };

  let networks: Record<string, { secret_config_key?: string; currency_default?: string }> = {};
  try { networks = JSON.parse(cfg.networksJson || '{}') as typeof networks; } catch { networks = {}; }
  const networkCfg = networks[network] || {};
  const secretName = networkCfg.secret_config_key || `TRACKING_PB_SECRET_${network.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const expected = env[secretName];
  const provided = params.get('key') || params.get('secret') || '';
  if (typeof expected !== 'string' || !expected || provided !== expected) {
    await logRaw('bad_secret');
    return { http: 401, result: 'bad_secret', body: 'Unauthorized' };
  }

  const clickId = params.get('click_id') || params.get('sp_cid') || params.get('cid') || '';
  const txid = params.get('txid') || params.get('transaction_id') || '';
  const event = (params.get('event') || 'conversion').slice(0, 64);
  const click = clickId ? await env.DB.prepare('SELECT * FROM tr_clicks WHERE click_id=?').bind(clickId)
    .first<Record<string, unknown>>() : null;
  if (!click) {
    await logRaw('unknown_click');
    return { http: 200, result: 'unknown_click', body: 'OK' };
  }

  const statusRaw = params.get('status') || '';
  const status = mapStatus(statusRaw, cfg.statusMapJson);
  const payoutMinor = payoutToMinor(params.get('payout'));
  const currency = (params.get('currency') || networkCfg.currency_default || 'USD').toUpperCase().slice(0, 3);
  const created = await recordConversion(env, {
    click, network, event, payoutMinor, currency, status, statusRaw, txid, source: 's2s',
    attributionWindowDays: cfg.attributionWindowDays,
  });
  if (created) {
    await logRaw('matched');
    return { http: 200, result: 'matched', body: 'OK' };
  }
  await logRaw('duplicate');
  return { http: 200, result: 'duplicate', body: 'OK' };
}

/**
 * Shared conversion writer (F8 S2S + F22 pixel): dedupe on
 * (click_id, txid, event); on first insert only, the daily aggregate
 * gains the conversion + revenue (keyed by the CLICK's day) and the
 * variant conversion counter moves. Returns true when a row was created.
 * Attribution fields (country, device, page) join via click_id at read
 * time — the conversions table stays lean by design (v3 schema).
 */
export async function recordConversion(
  env: { DB: D1Database; CONFIG?: KVNamespace; background?: (promise: Promise<unknown>) => void },
  input: {
    click: Record<string, unknown>;
    network: string;
    event: string;
    payoutMinor: number;
    currency: string;
    status: string;
    statusRaw: string;
    txid: string;
    source: string;
    attributionWindowDays?: number;
  },
): Promise<boolean> {
  const { click } = input;
  // F24 attribution window: a conversion arriving after the window
  // closes is stored as 'late' (the raw status is kept on the row) and
  // excluded from EPC and auto-optimisation.
  let status = input.status;
  if (input.attributionWindowDays) {
    const clickTs = Date.parse(`${String(click.ts || '').replace(' ', 'T')}Z`);
    if (Number.isFinite(clickTs) && Date.now() - clickTs > input.attributionWindowDays * 86_400_000) status = 'late';
  }
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO tr_conversions(click_id,network,event,payout_minor,currency,status_mapped,status_raw,txid,is_test,source)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).bind(String(click.click_id || ''), input.network, input.event, input.payoutMinor, input.currency,
    status, input.statusRaw, input.txid, Number(click.is_test || 0), input.source).run();
  const created = (insert.meta?.changes ?? 0) > 0;
  if (!created) return false;
  if (env.CONFIG && click.variant_id != null) {
    const { bumpVariantCounter } = await import('./routing.ts');
    await bumpVariantCounter({ CONFIG: env.CONFIG }, 'conversions', Number(click.variant_id), new Date());
  }
  const day = String(click.ts || '').slice(0, 10);
  if (day) {
    await env.DB.prepare(
      `INSERT INTO tr_click_daily(day,slug,country,device_type,dest_host,currency,conversions,revenue_minor) VALUES(?,?,?,?,?,?,1,?)
       ON CONFLICT(day,slug,country,device_type,dest_host,currency) DO UPDATE SET conversions=conversions+1, revenue_minor=revenue_minor+excluded.revenue_minor`,
    ).bind(day, String(click.slug || ''), String(click.country || ''), String(click.device_type || ''),
      String(click.dest_host || ''), input.currency, input.payoutMinor).run();
  }
  // F23: queue the outgoing postback, then fire its first attempt in
  // the background — the incoming response is never delayed by it
  // (gate G23.2). If the background fire is lost, the row stays queued
  // and the workflow retry step picks it up.
  try {
    const { queueOutgoingForConversion, fireOutgoingRow } = await import('./outgoing.ts');
    const conversion = await env.DB.prepare('SELECT id FROM tr_conversions WHERE click_id=? AND txid=? AND event=?')
      .bind(String(click.click_id || ''), input.txid, input.event).first<{ id: number }>();
    if (conversion) {
      const rowId = await queueOutgoingForConversion(env, conversion.id, click, input);
      if (rowId) {
        const fire = fireOutgoingRow(env, rowId).catch(() => {});
        if (typeof env.background === 'function') env.background(fire);
      }
    }
  } catch { /* outgoing postbacks are best-effort */ }
  return true;
}
