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

  if (action === 'tracking_testfire_outgoing') {
    const template = text(form, 'template', 2000).trim();
    if (!/^https:\/\//.test(template)) throw new AdminError('Outgoing test-fire: enter an https fire-URL template.');
    const { testFireOutgoing } = await import('../tracking/outgoing.ts');
    const result = await testFireOutgoing(template);
    await log(env, identity, 'tracking_testfire_outgoing', { hostPath: template.replace(/^https:\/\//, '').split('?')[0], httpStatus: result.httpStatus });
    return result.httpStatus
      ? `Test-fire sent — the endpoint answered HTTP ${result.httpStatus}${result.ok ? ' (success)' : ''}. The payload was marked TEST throughout; no conversion or queue row was created.`
      : 'Test-fire sent — the endpoint did not answer (network error or 5-second timeout). The payload was marked TEST throughout; no conversion or queue row was created.';
  }

  if (action === 'tracking_cost_import') {
    // F25: CSV cost import. One header row (day,link_slug,source,cost,
    // currency), cost as a decimal amount in the row's currency. Bad
    // rows are rejected with their line numbers; good rows still land.
    const lines = text(form, 'csv', 100_000).split(/\r?\n/);
    let imported = 0;
    const rejected: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const lineNo = index + 1;
      const raw = lines[index].trim();
      if (!raw) continue;
      if (lineNo === 1 && /^day\s*,/i.test(raw)) continue; // header
      const fields = raw.split(',').map(part => part.trim().replace(/^"|"$/g, ''));
      if (fields.length !== 5) { rejected.push(`line ${lineNo} (expected 5 columns)`); continue; }
      const [day, slug, source, costRaw, currencyRaw] = fields;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) { rejected.push(`line ${lineNo} (bad day)`); continue; }
      if (!slug || slug.length > 120) { rejected.push(`line ${lineNo} (bad link slug)`); continue; }
      const cost = Number(costRaw);
      if (!Number.isFinite(cost) || cost < 0) { rejected.push(`line ${lineNo} (bad cost)`); continue; }
      if (!/^[A-Za-z]{3}$/.test(currencyRaw)) { rejected.push(`line ${lineNo} (bad currency)`); continue; }
      await env.DB.prepare('INSERT OR REPLACE INTO tr_cost_daily(day,link_slug,source,cost_minor,currency) VALUES(?,?,?,?,?)')
        .bind(day, slug, source.slice(0, 120), Math.round(cost * 100), currencyRaw.toUpperCase()).run();
      imported++;
    }
    await log(env, identity, 'tracking_cost_import', { imported, rejected: rejected.length });
    if (!imported && !rejected.length) throw new AdminError('Cost import: the CSV was empty.');
    return `Cost import done: ${imported} ${imported === 1 ? 'row' : 'rows'} imported${rejected.length ? `; ${rejected.length} rejected — ${rejected.slice(0, 8).join('; ')}${rejected.length > 8 ? '; …' : ''}` : ''}.`;
  }

  if (action === 'tracking_refire_outgoing') {
    const id = Number(text(form, 'id', 12));
    if (!Number.isFinite(id) || id <= 0) throw new AdminError('Re-fire: missing queue row.');
    const row = await env.DB.prepare('SELECT id, status FROM tr_postbacks_out WHERE id=?').bind(id).first<{ id: number; status: string }>();
    if (!row) throw new AdminError('Re-fire: queue row not found.', 404);
    await env.DB.prepare("UPDATE tr_postbacks_out SET status='queued', attempts=0 WHERE id=?").bind(id).run();
    const { fireOutgoingRow } = await import('../tracking/outgoing.ts');
    const result = await fireOutgoingRow(env, id);
    const after = await env.DB.prepare('SELECT status FROM tr_postbacks_out WHERE id=?').bind(id).first<{ status: string }>();
    await log(env, identity, 'tracking_refire_outgoing', { id, httpStatus: result.httpStatus, status: after?.status });
    return result.ok
      ? `Outgoing postback ${id} re-fired — HTTP ${result.httpStatus}, marked sent.`
      : `Outgoing postback ${id} re-fired — HTTP ${result.httpStatus || 'no answer'}; it is ${after?.status || 'queued'} and the retry schedule continues.`;
  }

  if (action === 'tracking_variant_save' || action === 'tracking_variant_delete' || action === 'tracking_link_settings') {
    const { mirrorVariants } = await import('../tracking/routing.ts');
    const slug = text(form, 'slug', 120);
    if (!slug) throw new AdminError('Choose a link first.');
    const link = await env.DB.prepare('SELECT slug FROM links WHERE slug=? AND deleted_at IS NULL').bind(slug).first();
    if (!link) throw new AdminError('Link not found.', 404);
    if (action === 'tracking_link_settings') {
      const safeUrl = text(form, 'safe_url', 2048).trim();
      if (safeUrl && !/^https:\/\//.test(safeUrl)) throw new AdminError('Safe page URL must be an https URL (or blank for none).');
      await env.DB.prepare('INSERT INTO tr_link_settings(slug,autoopt,safe_url) VALUES(?,?,?) ON CONFLICT(slug) DO UPDATE SET autoopt=excluded.autoopt, safe_url=excluded.safe_url')
        .bind(slug, form.get('autoopt') === '1' ? 1 : 0, safeUrl).run();
      await log(env, identity, 'tracking_link_settings', { slug });
      return `Link settings saved for ${slug}.`;
    }
    if (action === 'tracking_variant_delete') {
      const id = Number(text(form, 'id', 12));
      await env.DB.prepare('DELETE FROM tr_link_variants WHERE id=? AND link_slug=?').bind(id, slug).run();
      await mirrorVariants(env, slug);
      await log(env, identity, 'tracking_variant_delete', { slug, id });
      return `Variant ${id} deleted from ${slug}.`;
    }
    const destUrl = text(form, 'dest_url', 2048).trim();
    if (!/^https:\/\//.test(destUrl)) throw new AdminError('Variant destination must be an https URL.');
    const weight = Number(text(form, 'weight', 6));
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) throw new AdminError('Weight: use 0–100.');
    const capClicks = Math.max(0, Math.trunc(Number(text(form, 'cap_clicks_day', 10)) || 0));
    const capConv = Math.max(0, Math.trunc(Number(text(form, 'cap_conv_day', 10)) || 0));
    const chainOrder = Math.trunc(Number(text(form, 'chain_order', 6)) || 0);
    const schedule = text(form, 'schedule', 500).trim();
    if (schedule) {
      try {
        const parsed: unknown = JSON.parse(schedule);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected');
      } catch { throw new AdminError('Schedule: enter valid JSON like {"days":[1,2,3,4,5],"start":"09:00","end":"17:00","tz":"UTC"} (or leave blank for always on).'); }
    }
    const note = text(form, 'note', 200);
    const active = form.get('active') === '1' ? 1 : 0;
    const locked = form.get('locked') === '1' ? 1 : 0;
    const id = Number(text(form, 'id', 12));
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (id > 0) {
      await env.DB.prepare('UPDATE tr_link_variants SET dest_url=?, weight=?, chain_order=?, active=?, cap_clicks_day=?, cap_conv_day=?, schedule=?, note=?, locked=?, updated_at=? WHERE id=? AND link_slug=?')
        .bind(destUrl, Math.trunc(weight), chainOrder, active, capClicks, capConv, schedule, note, locked, now, id, slug).run();
    } else {
      await env.DB.prepare('INSERT INTO tr_link_variants(link_slug,dest_url,weight,chain_order,active,cap_clicks_day,cap_conv_day,schedule,note,locked,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(slug, destUrl, Math.trunc(weight), chainOrder, active, capClicks, capConv, schedule, note, locked, now, now).run();
    }
    await mirrorVariants(env, slug);
    await log(env, identity, 'tracking_variant_save', { slug, id: id || 'new', destUrl });
    return `Variant saved for ${slug}.`;
  }

  throw new AdminError('Unknown tracking action.');
}
