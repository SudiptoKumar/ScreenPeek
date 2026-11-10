import { undoMetadata } from './metadata.ts';
import { undoBulk } from './universal.ts';
import { AdminError, permitted, requirePermission } from './access.ts';
import type { AdminIdentity, AdminModule } from './access.ts';
import { commitChange, deliverChange, savedMessage } from './changes.ts';
import type { AdminEnvironment, MirrorRef } from './changes.ts';
import { redirectTarget } from '../route-policy.ts';
export type AdminRow = Record<string, string | number | null>;
const definitions = {
  link: { table: 'links', module: 'links', keys: ['slug'], fields: ['slug','name','destination','type','enabled','rules','starts_at','ends_at'] },
  ad_slot: { table: 'ad_slots', module: 'ads', keys: ['page_type','placement'], fields: ['code','enabled','test_mode','starts_at','ends_at'] },
  config: { table: 'config', module: 'settings', keys: ['key'], fields: ['value'] },
  page: { table: 'pages', module: 'pages', keys: ['slug'], fields: ['title','body_md'] },
  content: { table: 'titles', module: 'content', keys: ['id','type'], fields: ['hidden','pinned'] },
  title: { table: 'titles', module: 'content', keys: ['id','type'], fields: ['hidden','pinned'] },
} as const;
export async function undoChange(env: AdminEnvironment, actor: AdminIdentity, id: number, fetcher: typeof fetch = fetch) {
  if (!Number.isSafeInteger(id) || id < 1) throw new AdminError('Choose a valid change record.');
  const log = await env.DB.prepare('SELECT * FROM admin_log WHERE id=?').bind(id).first<AdminRow>();
  if(log && ['title','person'].includes(String(log.entity)) && log.after && String(log.after).includes('locked_fields'))return undoMetadata(env,actor,id,fetcher);
  if (log?.entity && String(log.entity).startsWith('bulk:')) return undoBulk(env,actor,id,fetcher);
  if (!log || !Object.hasOwn(definitions, String(log.entity))) throw new AdminError('This change cannot be undone here.');
  const def = definitions[String(log.entity) as keyof typeof definitions];
  requirePermission(actor, log.entity === 'config' && ['google_site_verification','bing_site_verification'].includes(String(log.entity_id)) ? 'seo' : def.module, true);
  const before = log.before ? JSON.parse(String(log.before)) as AdminRow : null;
  const after = JSON.parse(String(log.after)) as AdminRow;
  const where = def.keys.map(key => `${key}=?`).join(' AND ');
  const keyValues = def.keys.map(key => after[key]);
  if (keyValues.some(value => value === undefined)) throw new AdminError('This historical record has no current key.');
  const current = await env.DB.prepare(`SELECT * FROM ${def.table} WHERE ${where}`).bind(...keyValues).first<AdminRow>();
  if (!current) throw new AdminError('The item no longer exists.', 409);
  for (const key of def.fields) if (Object.hasOwn(after, key) && current[key] !== after[key]) throw new AdminError('The item changed after this record. Undo its latest change first.', 409);
  const restored: AdminRow = { ...current };
  if (before) for (const key of def.fields) restored[key] = before[key] ?? null;
  else if (log.entity === 'link') restored.enabled = 0;
  else if (log.entity === 'ad_slot') { restored.code = ''; restored.enabled = 0; }
  else if (log.entity === 'config') restored.value = '';
  else throw new AdminError('Use Trash to undo this creation.');
  const mirrors: MirrorRef[] = log.entity === 'link' ? [...new Set([String(current.slug), String(restored.slug)])].map(id => ({ kind: 'link' as const, id })) : log.entity === 'ad_slot' ? [{ kind: 'ad', page: String(current.page_type) as 'detail', placement: String(current.placement) as 'native' }] : log.entity === 'config' ? [{ kind: 'config', key: String(current.key) }] : [];
  const related = ['content','title'].includes(String(log.entity)) ? [
    { sql: 'UPDATE genres SET title_count=(SELECT COUNT(*) FROM title_genres g JOIN titles t ON t.id=g.title_id AND t.type=g.title_type WHERE g.genre_slug=genres.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL) WHERE slug IN(SELECT genre_slug FROM title_genres WHERE title_id=? AND title_type=?)', params: [current.id,current.type] },
    { sql: 'UPDATE languages SET title_count=(SELECT COUNT(*) FROM titles t WHERE t.original_language=languages.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL) WHERE slug=(SELECT original_language FROM titles WHERE id=? AND type=?)', params: [current.id,current.type] },
    { sql: 'UPDATE collections SET title_count=(SELECT COUNT(*) FROM collection_titles c JOIN titles t ON t.id=c.title_id AND t.type=c.title_type WHERE c.collection_slug=collections.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL) WHERE slug IN(SELECT collection_slug FROM collection_titles WHERE title_id=? AND title_type=?)', params: [current.id,current.type] },
  ] : [];
  const delivery = await commitChange(env.DB, actor, { entity: String(log.entity), id: String(log.entity_id), before: current, after: restored,
    sql: `UPDATE ${def.table} SET ${def.fields.map(key => `${key}=?`).join(',')},revision=revision+1 WHERE ${where} AND revision=?`, params: [...def.fields.map(key => restored[key]), ...keyValues, Number(current.revision)], mirrors, related });
  return savedMessage(await deliverChange(env, delivery, fetcher));
}
export async function advancedAction(env: AdminEnvironment, actor: AdminIdentity, module: AdminModule, form: URLSearchParams, fetcher: typeof fetch = fetch) {
  requirePermission(actor, module, true);
  const action = form.get('action');
  if (action === 'undo') return undoChange(env, actor, Number(form.get('log_id')), fetcher);
  if (action === 'retry-delivery' && module === 'dashboard') {
    if (actor.role !== 'owner') throw new AdminError('Only the owner can retry site-wide delivery.', 403);
    const rows = (await env.DB.prepare('SELECT id FROM admin_delivery WHERE kv_done=0 OR purge_done=0 ORDER BY id LIMIT 1').all<{ id: number }>()).results;
    let complete = 0; for (const row of rows) { const result = await deliverChange(env, row.id, fetcher); if (result.kv && result.purge) complete++; }
    await env.DB.prepare("INSERT INTO admin_log(actor,entity,entity_id,after) VALUES(?,'delivery','retry',?)").bind(actor.email, JSON.stringify({ attempted: rows.length, completed: complete })).run();
    return `Retried ${rows.length} deliveries; ${complete} completed. Static pages still update on the next build.`;
  }
  if (module !== 'seo') throw new AdminError('Unknown action.');
  let entity = '', id = '', before: AdminRow | null = null, after: AdminRow = {}, sql = '', params: Array<string | number | null> = [], mirrors: MirrorRef[] = [];
  if (action === 'save-redirect') {
    const path = form.get('from_path') || '', target = redirectTarget(form.get('to_target') || '', 'https://screenpeek.local');
    if (!(path === '/' || /^\/[a-zA-Z0-9/_.,~-]*\/$/.test(path)) || path.startsWith('//') || /^\/(?:admin|api|go)(?:\/|$)/.test(path) || path.length > 250 || !target || new URL(target, 'https://screenpeek.local').pathname === path) throw new AdminError('Choose different owned paths without query strings or privileged routes.');
    let cursor = new URL(target, 'https://screenpeek.local').pathname;
    for (let depth = 0; depth < 10; depth++) {
      if (cursor === path) throw new AdminError('This redirect would form a loop.');
      const next = await env.DB.prepare('SELECT to_target FROM redirects WHERE from_path=?').bind(cursor).first<{ to_target: string }>();
      if (!next) break; cursor = new URL(next.to_target, 'https://screenpeek.local').pathname;
      if (depth === 9) throw new AdminError('Redirect chain is too long.');
    }
    before = await env.DB.prepare('SELECT * FROM redirects WHERE from_path=?').bind(path).first<AdminRow>();
    entity = 'redirect'; id = path; after = { from_path: path, to_target: target, type: 301 };
    sql = 'INSERT INTO redirects(from_path,to_target,type) VALUES(?,?,301) ON CONFLICT(from_path) DO UPDATE SET to_target=excluded.to_target,type=301'; params = [path,target];
  } else if (action === 'save-override') {
    const path = form.get('path') || '', title = (form.get('title') || '').trim();
    if (!(path === '/' || /^\/[a-zA-Z0-9/_.,~-]*\/$/.test(path)) || path.startsWith('//') || path.length > 250 || title.length > 200) throw new AdminError('Choose a clean owned path and title of at most 200 characters.');
    before = await env.DB.prepare('SELECT * FROM seo_overrides WHERE path=?').bind(path).first<AdminRow>();
    entity = 'seo_override'; id = path; after = { path, title: title || null, noindex: form.get('noindex') === '1' ? 1 : 0 };
    sql = 'INSERT INTO seo_overrides(path,title,noindex) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET title=excluded.title,noindex=excluded.noindex'; params = [path,after.title,after.noindex];
  } else if (action === 'save-verification') {
    const key = form.get('key') || '', value = (form.get('value') || '').trim();
    if (!['google_site_verification','bing_site_verification'].includes(key) || !/^[a-zA-Z0-9_-]{0,250}$/.test(value)) throw new AdminError('Choose a supported verification key and paste its content value only.');
    before = await env.DB.prepare('SELECT * FROM config WHERE key=?').bind(key).first<AdminRow>();
    entity = 'config'; id = key; after = { key, value }; mirrors = [{ kind: 'config', key }];
    sql = 'INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=revision+1'; params = [key,value];
  } else throw new AdminError('Unknown SEO action.');
  const delivery = await commitChange(env.DB, actor, { entity,id,before,after,sql,params,mirrors });
  return savedMessage(await deliverChange(env, delivery, fetcher));
}
export async function advancedData(env: AdminEnvironment, actor: AdminIdentity, module: AdminModule, url: URL) {
  requirePermission(actor, module);
  const q = (url.searchParams.get('q') || '').slice(0,100), page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get('page') || '1') || 1));
  const actorFilter = (url.searchParams.get('actor') || '').slice(0,254), entity = (url.searchParams.get('entity') || '').slice(0,40);
  const scope=(!permitted(actor,'ads')?" AND entity NOT IN ('ad_slot','bulk:ad_slots')":'')+(!permitted(actor,'settings')?" AND NOT(entity='config' AND entity_id NOT IN ('google_site_verification','bing_site_verification'))":'');
  const history = (await env.DB.prepare(`SELECT * FROM admin_log WHERE (?='' OR actor=?) AND (?='' OR entity=?) ${scope} ORDER BY id DESC LIMIT 50 OFFSET ?`).bind(actorFilter,actorFilter,entity,entity,(page-1)*50).all<AdminRow>()).results;
  const redirects = module === 'seo' ? (await env.DB.prepare("SELECT * FROM redirects WHERE from_path LIKE ? ORDER BY from_path LIMIT 50 OFFSET ?").bind(`%${q}%`,(page-1)*50).all<AdminRow>()).results : [];
  const missing = module === 'seo' ? (await env.DB.prepare('SELECT * FROM notfound_log ORDER BY count DESC LIMIT 50 OFFSET ?').bind((page-1)*50).all<AdminRow>()).results : [];
  const overrides = module === 'seo' ? (await env.DB.prepare('SELECT * FROM seo_overrides ORDER BY path LIMIT 50 OFFSET ?').bind((page-1)*50).all<AdminRow>()).results : [];
  const settings = module === 'seo' ? (await env.DB.prepare("SELECT key,value FROM config WHERE key IN ('google_site_verification','bing_site_verification')").all<AdminRow>()).results : [];
  return { history, redirects, missing, overrides, settings, q, page };
}
