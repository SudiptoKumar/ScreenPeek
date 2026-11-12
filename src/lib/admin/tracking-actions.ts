/**
 * ScreenPeek Insight — admin POST actions (F14).
 *
 * Settings saves, the postback tester, test-data purge and the manual
 * retention run. Settings and tools are owner-only; every action is
 * written to the admin audit log. Saves mirror to KV `config:<key>`
 * like every other config write in this admin.
 */
import { AdminError } from './access.ts';
import type { AdminIdentity } from './access.ts';
import { TRACKING_FIELDS } from '../tracking/fields.ts';
import { readTrackingConfig } from '../tracking/config.ts';
import { ingestPostback } from '../tracking/postback.ts';
import { purgeTestData, runRetention } from '../tracking/retention.ts';

export interface TrackingActionEnvironment { DB: D1Database; CONFIG: KVNamespace; [key: string]: unknown }

const text = (form: URLSearchParams, name: string, max = 4000) => (form.get(name) || '').slice(0, max);

async function log(env: TrackingActionEnvironment, actor: AdminIdentity, entity: string, after: unknown) {
  try {
    await env.DB.prepare("INSERT INTO admin_log(actor,entity,entity_id,after) VALUES(?,'tracking_action',?,?)")
      .bind(actor.email, entity, JSON.stringify(after)).run();
  } catch { /* Audit is best-effort beside the action itself. */ }
}

function validateValue(key: string, raw: string): string {
  const field = TRACKING_FIELDS.find(item => item.key === key);
  if (!field) throw new AdminError(`Unknown tracking setting: ${key}`);
  const value = raw.trim();
  if (field.kind === 'toggle') {
    if (!['0', '1'].includes(value)) throw new AdminError(`${field.label}: use 0 for off or 1 for on.`);
    return value;
  }
  if (field.kind === 'number') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < (field.min ?? 0) || numeric > (field.max ?? Number.MAX_SAFE_INTEGER)) {
      throw new AdminError(`${field.label}: use a number between ${field.min ?? 0} and ${field.max ?? '—'}.`);
    }
    return String(Math.trunc(numeric));
  }
  if (field.kind === 'select') {
    if (!field.options?.includes(value)) throw new AdminError(`${field.label}: choose one of ${field.options?.join(', ')}.`);
    return value;
  }
  if (field.kind === 'json') {
    if (!value) return '{}';
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected');
    } catch { throw new AdminError(`${field.label}: enter valid JSON (an object).`); }
    return value;
  }
  if (key === 'tracking_tier1_countries') {
    const codes = value.toUpperCase().split(',').map(code => code.trim()).filter(Boolean);
    if (!codes.length || codes.some(code => !/^[A-Z]{2}$/.test(code))) throw new AdminError('Tier-1 countries: use comma-separated two-letter codes like US,GB,CA,AU.');
    return codes.join(',');
  }
  if (key === 'tracking_click_param_name' && !/^[a-z0-9_]{1,24}$/i.test(value)) {
    throw new AdminError('Click ID parameter name: letters, digits and underscore, up to 24 characters.');
  }
  if (field.kind === 'secretName' && value && !/^[A-Z][A-Z0-9_]{2,60}$/.test(value)) {
    throw new AdminError('API key secret name: use the platform secret NAME (upper-case, e.g. TRACKING_API_KEY) — never the key value.');
  }
  return value.slice(0, 2000);
}

export async function trackingAction(env: TrackingActionEnvironment, identity: AdminIdentity | undefined, form: URLSearchParams): Promise<string> {
  if (!identity) throw new AdminError('Sign in again.', 401);
  if (identity.role !== 'owner') throw new AdminError('Tracking settings and tools are owner-only.', 403);
  const action = form.get('action') || '';

  if (action === 'tracking_settings') {
    const updates: Array<{ key: string; value: string }> = [];
    for (const field of TRACKING_FIELDS) {
      if (!form.has(field.key)) continue;
      updates.push({ key: field.key, value: validateValue(field.key, text(form, field.key, 20000)) });
    }
    if (!updates.length) throw new AdminError('No tracking settings were submitted.');
    for (const update of updates) {
      await env.DB.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=revision+1')
        .bind(update.key, update.value).run();
      try { await env.CONFIG.put(`config:${update.key}`, update.value); } catch { /* D1 remains the source of truth. */ }
    }
    await log(env, identity, 'tracking_settings', { keys: updates.map(update => update.key) });
    return `Tracking settings saved (${updates.length} ${updates.length === 1 ? 'key' : 'keys'}).`;
  }

  if (action === 'tracking_purge_test') {
    const counts = await purgeTestData(env.DB);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    await log(env, identity, 'tracking_purge_test', counts);
    return `Test data purged: ${total} rows removed (clicks ${counts.tr_clicks}, conversions ${counts.tr_conversions}, events ${counts.tr_events}, sessions ${counts.tr_sessions}). Daily aggregates still include the test rows — they are the permanent totals.`;
  }

  if (action === 'tracking_retention') {
    const dryRun = form.get('dry_run') === '1';
    const cfg = await readTrackingConfig(env.DB);
    const result = await runRetention(env.DB, cfg, dryRun);
    await log(env, identity, 'tracking_retention', result);
    const parts = `clicks ${result.clicks}, events ${result.events}, sessions ${result.sessions}, postback log ${result.postbacksRaw}`;
    return dryRun ? `Retention dry run — rows that would be deleted: ${parts}. Nothing was removed.` : `Retention purge done — rows deleted: ${parts}.`;
  }

  if (action === 'tracking_postback_test') {
    const network = text(form, 'network', 40).toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(network)) throw new AdminError('Postback tester: use a valid network name.');
    // A permanent test click carries the tester's conversions so they
    // land as is_test rows and can be purged with the test-data tool.
    await env.DB.prepare("INSERT OR IGNORE INTO tr_clicks(click_id,slug,link_name,is_test) VALUES('test-click-tester','postback-test','Postback tester',1)").run();
    const cfg = await readTrackingConfig(env.DB);
    let secretName = `TRACKING_PB_SECRET_${network.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    try {
      const networks = JSON.parse(cfg.networksJson || '{}') as Record<string, { secret_config_key?: string }>;
      if (networks[network]?.secret_config_key) secretName = networks[network].secret_config_key;
    } catch { /* defaults apply */ }
    const secret = typeof env[secretName] === 'string' ? String(env[secretName]) : '';
    const params = new URLSearchParams({
      click_id: 'test-click-tester',
      event: text(form, 'event', 60) || 'purchase',
      payout: text(form, 'payout', 30) || '1.00',
      status: text(form, 'status', 40) || 'approved',
      txid: `TEST-${Date.now()}`,
    });
    if (secret) params.set('key', secret);
    const result = await ingestPostback(env, network, params);
    await log(env, identity, 'tracking_postback_test', { network, result: result.result });
    return `Postback test for ${network}: HTTP ${result.http} — ${result.result}${result.result === 'matched' ? ' (a test conversion was recorded; purge it any time with the test-data tool)' : ''}. Tracking must be enabled and the network secret (when set) must match for a match.`;
  }

  throw new AdminError('Unknown tracking action.');
}
