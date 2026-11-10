import { metadataAction } from './metadata.ts';
import { setIssueSnooze } from './health.ts';
import { restoreConfiguration } from './restore.ts';
import { universalAction } from './universal.ts';
import { advancedAction } from './advanced.ts';
import { AdminError, requirePermission } from './access.ts';
import type { AdminIdentity, AdminModule } from './access.ts';
import { commitChange, deliverChange, dispatchJob, dispatchSync, purgeCache, savedMessage } from './changes.ts';
import type { AdminEnvironment, MirrorRef } from './changes.ts';
import { adAllowed, adMap } from '../ads.ts';
import type { AdPage, AdPlacement } from '../ads.ts';
import { httpsDestination } from '../links.ts';
import { trustSlugs } from '../trust.ts';

export const settingsFields = {
  ads_display_enabled: 'Display ads', ads_native_enabled: 'Native ads', ads_sticky_enabled: 'Sticky ads', ads_social_enabled: 'Social Bar', ads_popunder_enabled: 'Popunder', ads_txt: 'ads.txt',
  static_top_n: 'Prebuilt top titles', site_name: 'Site name', site_tagline: 'Tagline', ads_enabled: 'Master ads switch', popunder_cap_hours: 'Popunder cap (hours)',
  cache_ttl_list: 'List cache TTL (seconds)', cache_ttl_detail: 'Detail cache TTL (seconds)',
  maintenance: 'Maintenance mode', ratings_external: 'Show cached external ratings', sync_popularity_gate: 'Sync popularity gate', sync_max_titles: 'Max titles per sync',
  social_links: 'Social link slugs (comma-separated)',
} as const;
export type SettingsKey = keyof typeof settingsFields;
export const dhakaInput = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) + 21_600_000).toISOString().slice(0, 16) : '';
const text = (form: URLSearchParams, key: string, max = 200) => {
  const value = form.get(key) || '';
  if (value.length > max) throw new AdminError(`${key} is too long.`);
  return value;
};
const checked = (form: URLSearchParams, key: string) => form.get(key) === '1' ? 1 : 0;
const revision = (form: URLSearchParams) => { const raw = form.get('revision') || ''; const value = Number(raw); if (!/^(?:-1|0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(value)) throw new AdminError('Reload the editor before saving.'); return value; };
const slugValue = (value: string) => { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 120) throw new AdminError('Use a short lowercase slug with letters, numbers and hyphens.'); return value; };
const destination = (value: string, required = false) => {
  if (!value && !required) return '';
  if (value.length > 2048 || !httpsDestination(value)) throw new AdminError('Destinations must be valid HTTPS URLs without usernames or passwords.');
  return new URL(value).href;
};
const dateValue = (value: string) => {
  if (!value) return null;
  const date = new Date(`${value}:00+06:00`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || dhakaInput(date.toISOString()) !== value) throw new AdminError('Use a valid Bangladesh date and time.');
  return date.toISOString();
};
const schedule = (form: URLSearchParams) => {
  const starts_at = dateValue(text(form, 'starts_at', 30)), ends_at = dateValue(text(form, 'ends_at', 30));
  if (starts_at && ends_at && ends_at <= starts_at) throw new AdminError('The end must be after the start.');
  return { starts_at, ends_at };
};
export async function adminForm(request: Request) {
  if (request.method !== 'POST') throw new AdminError('Method not allowed.', 405);
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new AdminError('Submit this form from the admin site.', 403);
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new AdminError('Use the admin form.', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AdminError('The form is empty.');
  let body = '', bytes = 0;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 256_000) { void reader.cancel(); throw new AdminError('The form is too large.', 413); }
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  const form = new URLSearchParams(body);
  for (const key of form.keys()) if (form.getAll(key).length !== 1 && !(key === 'u_keys' && form.getAll(key).length <= 5)) throw new AdminError('Duplicate form fields are not supported.');
  return form;
}
interface LinkRow extends Record<string, unknown> { slug: string; name: string; destination: string; type: string; enabled: number; rules: string; revision: number; clicks_total: number; }
export async function applyAdminAction(env: AdminEnvironment, identity: AdminIdentity | undefined, module: AdminModule, form: URLSearchParams, fetcher: typeof fetch = fetch) {
  requirePermission(identity, module, true);
  if(form.has('m_action'))return metadataAction(env,identity,form,fetcher);
  if(module==='dashboard' && ['snooze-issue','reopen-issue'].includes(form.get('action')||''))return {message:await setIssueSnooze(env,identity,form.get('issue_key')||'',form.get('action')==='reopen-issue'),jobUrl:undefined};
  if(module==='backup' && form.get('action')==='restore-config')return {message:await restoreConfiguration(env,identity,form,fetcher),jobUrl:undefined};
  if (form.has('u_action')) return { message: await universalAction(env, identity, module, form, fetcher), jobUrl: undefined };
  if (['seo','changes'].includes(module) || form.get('action') === 'retry-delivery') return { message: await advancedAction(env, identity, module, form, fetcher), jobUrl: undefined };
  if (module === 'sync') {
    if (form.get('action') !== 'run-sync') throw new AdminError('Unknown sync action.');
    const url = await dispatchSync(env, identity, fetcher);
    return { message: 'GitHub accepted the sync request. Completion and deployment are not yet verified; the repository sync-enable variable must also be set.', jobUrl: url };
  }
  if (module === 'tools') {
    const action = form.get('action') || '';
    if (action === 'run-job') {
      const url = await dispatchJob(env, identity, form.get('job') || '', fetcher);
      return { message: 'GitHub accepted the job request. Completion is tracked in Actions; the repository enable switches still govern execution.', jobUrl: url };
    }
    if (action === 'purge-cache') return { message: await purgeCache(env, identity, text(form, 'url', 2048), fetcher), jobUrl: undefined };
    throw new AdminError('Unknown tools action.');
  }
  let sql = '', params: Array<string | number | null> = [], entity = '', id = '', before: unknown = null, after: unknown = null, mirrors: MirrorRef[] = [];
  const related: Array<{ sql: string; params: Array<string | number | null> }> = [];
  if (module === 'links') {
    const oldSlug = text(form, 'original_slug', 120);
    const previous = oldSlug ? await env.DB.prepare('SELECT * FROM links WHERE slug=? AND deleted_at IS NULL').bind(oldSlug).first<LinkRow>() : null;
    if (oldSlug && !previous) throw new AdminError('Link not found.', 404);
    const slug = slugValue(text(form, 'slug', 120));
    if (previous && previous.slug !== slug && previous.clicks_total > 0) throw new AdminError('This slug is locked because it has recorded clicks.');
    const name = text(form, 'name').trim(); if (!name) throw new AdminError('A name is required.');
    const type = text(form, 'type'); if (!['affiliate', 'smartlink', 'social', 'other'].includes(type)) throw new AdminError('Choose a valid link type.');
    let existing: Record<string, unknown> = {};
    try { const parsed: unknown = JSON.parse(previous?.rules || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>; } catch { /* Rebuild malformed legacy rules. */ }
    const byCountry: Record<string, string> = {}, byDevice: Record<string, string> = {};
    for (const country of ['US', 'GB', 'CA', 'AU']) { const value = destination(text(form, `country_${country}`, 2048)); if (value) byCountry[country] = value; }
    for (const device of ['mobile', 'desktop']) { const value = destination(text(form, `device_${device}`, 2048)); if (value) byDevice[device] = value; }
    const next = { slug, name, type, destination: destination(text(form, 'destination', 2048), true), enabled: checked(form, 'enabled'), rules: JSON.stringify({ ...existing, byCountry, byDevice }), ...schedule(form) };
    const values = [next.slug, next.name, next.type, next.destination, next.enabled, next.rules, next.starts_at, next.ends_at];
    if (previous) { sql = "UPDATE links SET slug=?,name=?,type=?,destination=?,enabled=?,rules=?,starts_at=?,ends_at=?,updated_at=datetime('now'),revision=revision+1 WHERE slug=? AND revision=?"; params = [...values, oldSlug, revision(form)]; }
    else { if (revision(form) !== -1) throw new AdminError('Reload the new-link form.'); sql = 'INSERT OR IGNORE INTO links(slug,name,type,destination,enabled,rules,starts_at,ends_at) VALUES(?,?,?,?,?,?,?,?)'; params = values; }
    entity = 'link'; id = slug; before = previous; after = next;
    mirrors = [...new Set([oldSlug, slug].filter(Boolean))].map(id => ({ kind: 'link', id }));
  } else if (module === 'ads' && !form.has('key')) {
    const page = text(form, 'page_type') as AdPage, placement = text(form, 'placement') as AdPlacement;
    if (!Object.hasOwn(adMap, page) || !adAllowed(page, placement)) throw new AdminError('Choose a documented page and placement.');
    const previous = await env.DB.prepare('SELECT * FROM ad_slots WHERE page_type=? AND placement=?').bind(page, placement).first<Record<string, unknown>>();
    const next = { page_type: page, placement, code: text(form, 'code', 65_536), enabled: checked(form, 'enabled'), test_mode: checked(form, 'test_mode'), ...schedule(form) };
    if (previous) { sql = 'UPDATE ad_slots SET code=?,enabled=?,test_mode=?,starts_at=?,ends_at=?,revision=revision+1 WHERE page_type=? AND placement=? AND revision=?'; params = [next.code, next.enabled, next.test_mode, next.starts_at, next.ends_at, page, placement, revision(form)]; }
    else { if (revision(form) !== -1) throw new AdminError('Reload the new-slot form.'); sql = 'INSERT OR IGNORE INTO ad_slots(page_type,placement,code,enabled,test_mode,starts_at,ends_at) VALUES(?,?,?,?,?,?,?)'; params = [page, placement, next.code, next.enabled, next.test_mode, next.starts_at, next.ends_at]; }
    entity = 'ad_slot'; id = `${page}/${placement}`; before = previous; after = next; mirrors = [{ kind: 'ad', page, placement }];
  } else if (module === 'settings' || module === 'ads') {
    const key = text(form, 'key') as SettingsKey;
    if (!Object.hasOwn(settingsFields, key)) throw new AdminError('Unknown setting.');
    if (module === 'ads' && !['ads_enabled', 'popunder_cap_hours', 'ads_display_enabled','ads_native_enabled','ads_sticky_enabled','ads_social_enabled','ads_popunder_enabled','ads_txt'].includes(key)) throw new AdminError('This setting requires the owner’s Settings permission.', 403);
    const value = text(form, 'value', key === 'ads_txt' ? 20000 : 250).trim();
    if (['ads_enabled', 'maintenance', 'ratings_external','ads_display_enabled','ads_native_enabled','ads_sticky_enabled','ads_social_enabled','ads_popunder_enabled'].includes(key) && !['0', '1'].includes(value)) throw new AdminError('Use 0 for off or 1 for on.');
    if (key === 'popunder_cap_hours' && (!Number.isFinite(Number(value)) || Number(value) < 1 || Number(value) > 168)) throw new AdminError('Use 1–168 hours.');
    if (key === 'sync_popularity_gate' && (!value || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100_000)) throw new AdminError('Use a popularity gate from 0 to 100000.');
    if (key === 'static_top_n' && (!/^\d+$/.test(value) || Number(value) > 15000)) throw new AdminError('Use 0–15000; the total asset cap still applies.');
    if (key === 'cache_ttl_list' && (!/^\d+$/.test(value) || Number(value) < 60 || Number(value) > 86400)) throw new AdminError('Use 60–86400 seconds.');
    if (key === 'cache_ttl_detail' && (!/^\d+$/.test(value) || Number(value) < 300 || Number(value) > 604800)) throw new AdminError('Use 300–604800 seconds.');
    if (key === 'sync_max_titles' && (!/^[1-9]\d*$/.test(value) || Number(value) > 2000)) throw new AdminError('Use 1–2000 titles per run.');
    if (key === 'site_name' && !value) throw new AdminError('A site name is required.');
    if (key === 'social_links') {
      const slugs = value.split(',').map(value => value.trim()).filter(Boolean);
      if (slugs.length > 5) throw new AdminError('Choose up to five social links.');
      for (const slug of slugs) {
        slugValue(slug);
        const link = await env.DB.prepare("SELECT slug FROM links WHERE slug=? AND deleted_at IS NULL AND type='social'").bind(slug).first();
        if (!link) throw new AdminError('Create each social link in Link Manager first, with the social type.');
      }
    }
    const previous = await env.DB.prepare('SELECT * FROM config WHERE key=?').bind(key).first();
    if (previous) { sql = 'UPDATE config SET value=?,revision=revision+1 WHERE key=? AND revision=?'; params = [value, key, revision(form)]; }
    else { if (revision(form) !== -1) throw new AdminError('Reload this setting.'); sql = 'INSERT OR IGNORE INTO config(key,value) VALUES(?,?)'; params = [key, value]; }
    entity = 'config'; id = key; before = previous; after = { key, value }; mirrors = [{ kind: 'config', key }];
  } else if (module === 'pages') {
    const slug = text(form, 'slug', 20);
    if (!(trustSlugs as readonly string[]).includes(slug)) throw new AdminError('Choose a supported information page.');
    const title = text(form, 'title', 120).trim(), body_md = text(form, 'body_md', 20_000);
    if (!title || !body_md.trim()) throw new AdminError('A title and page content are required.');
    const previous = await env.DB.prepare('SELECT * FROM pages WHERE slug=?').bind(slug).first();
    if (previous) { sql = "UPDATE pages SET title=?,body_md=?,revision=revision+1,updated_at=datetime('now') WHERE slug=? AND revision=?"; params = [title, body_md, slug, revision(form)]; }
    else { if (revision(form) !== -1) throw new AdminError('Reload this page before saving.'); sql = 'INSERT OR IGNORE INTO pages(slug,title,body_md) VALUES(?,?,?)'; params = [slug, title, body_md]; }
    entity = 'page'; id = slug; before = previous; after = { slug, title, body_md };
  } else if (module === 'content') {
    const titleId = Number(text(form, 'id')), type = text(form, 'type');
    if (!Number.isSafeInteger(titleId) || !titleId || !['movie', 'tv'].includes(type)) throw new AdminError('Choose a valid title.');
    const previous = await env.DB.prepare('SELECT id,type,slug,hidden,pinned,revision FROM titles WHERE id=? AND type=? AND deleted=0 AND deleted_at IS NULL').bind(titleId, type).first();
    if (!previous) throw new AdminError('Title not found.', 404);
    const next = { ...previous, hidden: checked(form, 'hidden'), pinned: checked(form, 'pinned') };
    sql = 'UPDATE titles SET hidden=?,pinned=?,revision=revision+1 WHERE id=? AND type=? AND revision=? AND deleted=0 AND deleted_at IS NULL';
    params = [next.hidden, next.pinned, titleId, type, revision(form)]; entity = 'content'; id = `${type}:${titleId}`; before = previous; after = next;
    related.push(
      { sql: 'UPDATE genres SET title_count=(SELECT COUNT(*) FROM title_genres g JOIN titles t ON t.id=g.title_id AND t.type=g.title_type WHERE g.genre_slug=genres.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL) WHERE slug IN(SELECT genre_slug FROM title_genres WHERE title_id=? AND title_type=?)', params: [titleId, type] },
      { sql: 'UPDATE languages SET title_count=(SELECT COUNT(*) FROM titles t WHERE t.original_language=languages.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL) WHERE slug=(SELECT original_language FROM titles WHERE id=? AND type=?)', params: [titleId, type] },
      { sql: 'UPDATE collections SET title_count=(SELECT COUNT(*) FROM collection_titles c JOIN titles t ON t.id=c.title_id AND t.type=c.title_type WHERE c.collection_slug=collections.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL) WHERE slug IN(SELECT collection_slug FROM collection_titles WHERE title_id=? AND title_type=?)', params: [titleId, type] },
    );
  } else throw new AdminError('This module has no supported save action.', 405);
  const deliveryId = await commitChange(env.DB, identity, { sql, params, entity, id, before, after, mirrors, related });
  let delivery = { kv: false, purge: false };
  try { delivery = await deliverChange(env, deliveryId, fetcher); } catch { /* D1 commit remains saved; the outbox remains pending. */ }
  return { message: savedMessage(delivery), jobUrl: undefined };
}
