/**
 * ScreenPeek Insight — outgoing postbacks (F23, docs/06).
 *
 * When a conversion is stored, networks that need a callback get one:
 * the fire-URL template lives in the tracking_networks config JSON as
 * "postback_url" on the network's entry (with an optional per-link
 * override in "postback_url_by_slug"). Macros: {click_id} {event}
 * {payout} {currency} {txid} {sub1} {country} {device}.
 *
 * The queue row stores host+path only — never the expanded URL with
 * its macro values (gate G23.4). Retries rebuild the URL from the
 * stored conversion + click and the network's current template.
 * Schedule: first fire immediately (backgrounded, never delaying the
 * incoming postback response), retries after 1m, 10m and 1h, driven by
 * the sync-workflow job. After the third retry the row is 'failed' and
 * can be re-fired from the admin.
 */
import { readTrackingConfig } from './config.ts';

export const RETRY_DELAYS_SECONDS = [60, 600, 3600];
export const MAX_ATTEMPTS = 1 + RETRY_DELAYS_SECONDS.length;

export interface MacroValues {
  click_id: string;
  event: string;
  payout: string;
  currency: string;
  txid: string;
  sub1: string;
  country: string;
  device: string;
}

export function expandMacros(template: string, values: MacroValues): string {
  return template.replace(/\{(click_id|event|payout|currency|txid|sub1|country|device)\}/g,
    (_match, key: string) => encodeURIComponent(values[key as keyof MacroValues] ?? ''));
}

export function templateForNetwork(networksJson: string, network: string, slug: string): string {
  try {
    const parsed = JSON.parse(networksJson || '{}') as Record<string, unknown>;
    const entry = parsed[network];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
    const record = entry as Record<string, unknown>;
    const bySlug = record.postback_url_by_slug;
    if (bySlug && typeof bySlug === 'object' && !Array.isArray(bySlug)) {
      const override = (bySlug as Record<string, unknown>)[slug];
      if (typeof override === 'string' && override) return override;
    }
    return typeof record.postback_url === 'string' ? record.postback_url : '';
  } catch { return ''; }
}

/** host + path only — what the attempt log is allowed to keep. */
export function hostPathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname;
  } catch { return ''; }
}

const payoutDecimal = (minor: number) => (minor / 100).toFixed(2);
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function macrosFor(click: Record<string, unknown>, conversion: { event: string; payout_minor: number; currency: string; txid: string }): MacroValues {
  return {
    click_id: String(click.click_id || ''),
    event: conversion.event,
    payout: payoutDecimal(conversion.payout_minor),
    currency: conversion.currency,
    txid: conversion.txid,
    sub1: String(click.sub1 || ''),
    country: String(click.country || ''),
    device: String(click.device_type || ''),
  };
}

/**
 * Queue one outgoing postback for a stored conversion. Returns the
 * queue row id, or null when the network has no template. Insert only —
 * firing is the caller's background step (fireOutgoingRow).
 */
export async function queueOutgoingForConversion(
  env: { DB: D1Database },
  conversionId: number,
  click: Record<string, unknown>,
  conversion: { network: string; event: string; payoutMinor: number; currency: string; txid: string },
): Promise<number | null> {
  const cfg = await readTrackingConfig(env.DB);
  const template = templateForNetwork(cfg.networksJson, conversion.network, String(click.slug || ''));
  if (!template) return null;
  const url = expandMacros(template, macrosFor(click, {
    event: conversion.event, payout_minor: conversion.payoutMinor, currency: conversion.currency, txid: conversion.txid,
  }));
  const hostPath = hostPathOf(url);
  if (!hostPath) return null;
  const inserted = await env.DB.prepare(
    "INSERT INTO tr_postbacks_out(conversion_id,network,url_host,status,attempts,created_at) VALUES(?,?,?,'queued',0,?)",
  ).bind(conversionId, conversion.network, hostPath, nowSql()).run();
  if (!(inserted.meta?.changes ?? 0)) return null;
  const row = await env.DB.prepare('SELECT MAX(id) AS id FROM tr_postbacks_out WHERE conversion_id=?').bind(conversionId).first<{ id: number }>();
  return row?.id ?? null;
}

/** Fire one attempt for a queued row. Rebuilds the URL from the stored
 * conversion + click and the network's current template. */
export async function fireOutgoingRow(
  env: { DB: D1Database },
  rowId: number,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; httpStatus: number }> {
  const row = await env.DB.prepare('SELECT * FROM tr_postbacks_out WHERE id=?').bind(rowId)
    .first<{ conversion_id: number; network: string; attempts: number }>();
  if (!row) return { ok: false, httpStatus: 0 };
  const conversion = await env.DB.prepare('SELECT * FROM tr_conversions WHERE id=?').bind(row.conversion_id)
    .first<{ click_id: string; event: string; payout_minor: number; currency: string; txid: string }>();
  if (!conversion) {
    await env.DB.prepare("UPDATE tr_postbacks_out SET status='failed', last_try_at=? WHERE id=?").bind(nowSql(), rowId).run();
    return { ok: false, httpStatus: 0 };
  }
  const click = await env.DB.prepare('SELECT * FROM tr_clicks WHERE click_id=?').bind(conversion.click_id)
    .first<Record<string, unknown>>() || { click_id: conversion.click_id };
  const cfg = await readTrackingConfig(env.DB);
  const template = templateForNetwork(cfg.networksJson, row.network, String(click.slug || ''));
  let httpStatus = 0;
  let ok = false;
  if (template) {
    const url = expandMacros(template, macrosFor(click, conversion));
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(5000) });
      httpStatus = response.status;
      ok = response.status >= 200 && response.status < 300;
    } catch { httpStatus = 0; ok = false; }
  }
  const attempts = row.attempts + 1;
  const status = ok ? 'sent' : (attempts >= MAX_ATTEMPTS || !template ? 'failed' : 'queued');
  await env.DB.prepare('UPDATE tr_postbacks_out SET status=?, http_status=?, attempts=?, last_try_at=? WHERE id=?')
    .bind(status, httpStatus || null, attempts, nowSql(), rowId).run();
  return { ok, httpStatus };
}

/** Workflow step: fire every queued row whose retry time has come.
 * A never-attempted row gets a 30-second grace first, so the retry
 * step never races the background first fire from the request that
 * queued it (a lost background fire is picked up right after). */
export async function retryOutgoingPostbacks(
  env: { DB: D1Database },
  now: Date = new Date(),
): Promise<{ attempted: number; sent: number; failed: number }> {
  const rows = await env.DB.prepare("SELECT id, attempts, last_try_at, created_at FROM tr_postbacks_out WHERE status='queued' ORDER BY id LIMIT 200")
    .all<{ id: number; attempts: number; last_try_at: string; created_at: string }>();
  let attempted = 0, sent = 0, failed = 0;
  for (const row of rows.results || []) {
    if (row.attempts === 0) {
      const created = Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
      if (Number.isFinite(created) && now.getTime() - created < 30_000) continue;
    } else {
      const delay = RETRY_DELAYS_SECONDS[Math.min(row.attempts - 1, RETRY_DELAYS_SECONDS.length - 1)];
      const lastTry = Date.parse(`${row.last_try_at.replace(' ', 'T')}Z`);
      if (Number.isFinite(lastTry) && now.getTime() - lastTry < delay * 1000) continue;
    }
    attempted++;
    const result = await fireOutgoingRow(env, row.id);
    if (result.ok) sent++; else failed++;
  }
  return { attempted, sent, failed };
}

/** Admin test-fire: a clearly-marked test payload, no conversion and no
 * queue row is created (gate G23.5). */
export async function testFireOutgoing(
  template: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; httpStatus: number }> {
  const url = expandMacros(template, {
    click_id: 'TEST-CLICK', event: 'test', payout: '0.00', currency: 'USD',
    txid: 'TEST-TX', sub1: 'test', country: 'US', device: 'desktop',
  });
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(5000) });
    return { ok: response.status >= 200 && response.status < 300, httpStatus: response.status };
  } catch { return { ok: false, httpStatus: 0 }; }
}
