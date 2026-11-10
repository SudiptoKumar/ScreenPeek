import { AdminError } from './access.ts';
import type { AdminIdentity } from './access.ts';
import type { AdPage, AdPlacement } from '../ads.ts';
import { adKey } from '../ads.ts';

export type MirrorRef = { kind: 'link'; id: string } | { kind: 'ad'; page: AdPage; placement: AdPlacement } | { kind: 'config'; key: string };
export interface AdminEnvironment {
  DB: D1Database; CONFIG: KVNamespace; BACKUPS?: R2Bucket; POSTERS?: R2Bucket; CLOUDFLARE_ZONE_ID?: string; CLOUDFLARE_API_TOKEN?: string;
  GITHUB_REPO?: string; GITHUB_ACTIONS_TOKEN?: string; SITE_URL?: string;
}
interface Change {
  entity: string; id: string; before: unknown; after: unknown;
  sql: string; params: Array<string | number | null>; mirrors: MirrorRef[];
  related?: Array<{ sql: string; params: Array<string | number | null> }>;
}
export async function commitChange(db: D1Database, actor: AdminIdentity, change: Change) {
  let results;
  try { results = await db.batch([
    db.prepare(change.sql).bind(...change.params),
    db.prepare('INSERT INTO admin_revision_guard(id) SELECT 1 WHERE changes()=0'),
    db.prepare('INSERT INTO admin_log(actor,entity,entity_id,before,after) VALUES(?,?,?,?,?)')
      .bind(actor.email, change.entity, change.id, JSON.stringify(change.before), JSON.stringify(change.after)),
    db.prepare('INSERT INTO admin_delivery(log_id,entity,entity_id,payload) VALUES(last_insert_rowid(),?,?,?)')
      .bind(change.entity, change.id, JSON.stringify(change.mirrors)),
    ...(change.related || []).map(statement => db.prepare(statement.sql).bind(...statement.params)),
    db.prepare('DELETE FROM admin_log WHERE id NOT IN(SELECT id FROM admin_log ORDER BY id DESC LIMIT 500)'),
  ]); } catch { throw new AdminError('The item changed, already exists, or could not commit. Reload before saving.',409); }
  if (!results[0].meta.changes) throw new AdminError('This item changed or already exists. Reload it before saving again.', 409);
  return Number(results[3].meta.last_row_id);
}
/** Replay uses current authoritative D1 values rather than historical payloads. */
export async function deliverChange(env: AdminEnvironment, deliveryId: number, fetcher: typeof fetch = fetch, maxMirrors = 24) {
  const row = await env.DB.prepare('SELECT payload,kv_done,purge_done,kv_cursor FROM admin_delivery WHERE id=?').bind(deliveryId).first<{ payload: string; kv_done: number; purge_done: number; kv_cursor: number }>();
  if (!row) return { kv: false, purge: false };
  let kv = !!row.kv_done, purge = !!row.purge_done;
  let cursor = row.kv_cursor || 0;
  const errors: string[] = [];
  if (!kv) try {
    const refs = JSON.parse(row.payload) as MirrorRef[];
    for (const ref of refs.slice(cursor,cursor+Math.max(1,Math.min(24,maxMirrors)))) {
      if (ref.kind === 'link') {
        const record = await env.DB.prepare('SELECT * FROM links WHERE slug=?').bind(ref.id).first();
        await env.CONFIG.put(`link:${ref.id}`, JSON.stringify(record || { slug: ref.id, enabled: 0, destination: '', rules: '{}' }));
      } else if (ref.kind === 'ad') {
        const record = await env.DB.prepare('SELECT * FROM ad_slots WHERE page_type=? AND placement=?').bind(ref.page, ref.placement).first();
        await env.CONFIG.put(adKey(ref.page, ref.placement), JSON.stringify(record || { page_type: ref.page, placement: ref.placement, enabled: 0, code: '' }));
      } else if (ref.kind === 'config') {
        const record = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind(ref.key).first<{ value: string }>();
        await env.CONFIG.put(`config:${ref.key}`, record?.value || '');
      }
      cursor++;
    }
    kv = cursor >= refs.length;
    if (!kv) errors.push('KV propagation is pending; retry delivery to continue the bounded batch.');
  } catch { errors.push('KV propagation failed'); }
  if (kv && !purge) {
    if (!env.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ZONE_ID || '')) errors.push('Cache purge is not configured');
    else try {
      const response = await fetcher(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/purge_cache`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ purge_everything: true }),
      });
      const data: unknown = response.ok ? await response.json() : null;
      purge = !!data && typeof data === 'object' && 'success' in data && data.success === true;
      if (!purge) errors.push('Cache purge failed');
    } catch { errors.push('Cache purge failed'); }
  }
  await env.DB.prepare('UPDATE admin_delivery SET kv_done=?,purge_done=?,kv_cursor=?,attempts=attempts+1,last_error=? WHERE id=?')
    .bind(Number(kv), Number(purge), cursor, errors.join('; ') || null, deliveryId).run();
  return { kv, purge };
}
export const savedMessage = (delivery: { kv: boolean; purge: boolean }) => delivery.kv && delivery.purge ?
  'Saved. KV propagation and cache purge succeeded; SSR pages can pick up this change. Static pages update on the next build.' :
  'Saved in D1. Propagation or cache purge is pending; live visibility is not verified. Static pages update on the next build.';

export async function dispatchSync(env: AdminEnvironment, actor: AdminIdentity, fetcher: typeof fetch = fetch, ids = '') {
  if(ids.length>4000 || ids && (ids.split(',').length>50 || ids.split(',').some(value=>! /^(movie|tv|person):[1-9]\d*$/.test(value))))throw new AdminError('Use up to 50 movie:ID, tv:ID or person:ID values.');
  if (!env.GITHUB_ACTIONS_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPO || '')) throw new AdminError('Add the repository name and GitHub Actions token in secure settings before running a sync.', 503);
  // Log the actor and intent before the external action; no token is recorded.
  const log = await env.DB.prepare("INSERT INTO admin_log(actor,entity,entity_id,before,after) VALUES(?,'job','nightly.yml',NULL,?)")
    .bind(actor.email, JSON.stringify({ status: 'dispatch requested', ref: 'main', deploy: false, ids })).run();
  let accepted = false;
  try {
    const response = await fetcher(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/nightly.yml/dispatches`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ScreenPeek-admin' },
      body: JSON.stringify({ ref: 'main', inputs: { ids, deploy: false } }),
    });
    accepted = response.status === 204;
  } catch { /* Retain the intent log without leaking transport/credential data. */ }
  await env.DB.prepare('UPDATE admin_log SET after=? WHERE id=?').bind(JSON.stringify({ status: accepted ? 'dispatch accepted' : 'dispatch unconfirmed', ref: 'main', deploy: false, ids }), log.meta.last_row_id).run();
  if (!accepted) throw new AdminError('GitHub did not confirm the dispatch. Check Actions before retrying to avoid duplicate runs.', 502);
  return `https://github.com/${env.GITHUB_REPO}/actions/workflows/nightly.yml`;
}

const jobWorkflows = {
  nightly: { file: 'nightly.yml', label: 'Daily sync' },
  backup: { file: 'backup.yml', label: 'Private backup' },
} as const;
export type AdminJob = keyof typeof jobWorkflows;

/** Tools "run any job": nightly reuses the exact sync dispatch; other workflows share its log-then-confirm shape. */
export async function dispatchJob(env: AdminEnvironment, actor: AdminIdentity, job: string, fetcher: typeof fetch = fetch) {
  if (!Object.hasOwn(jobWorkflows, job)) throw new AdminError('Choose a supported job.');
  if (job === 'nightly') return dispatchSync(env, actor, fetcher);
  const spec = jobWorkflows[job as AdminJob];
  if (!env.GITHUB_ACTIONS_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPO || '')) throw new AdminError('Add the repository name and GitHub Actions token in secure settings before running a job.', 503);
  // Log the actor and intent before the external action; no token is recorded.
  const log = await env.DB.prepare("INSERT INTO admin_log(actor,entity,entity_id,before,after) VALUES(?,'job',?,NULL,?)")
    .bind(actor.email, spec.file, JSON.stringify({ status: 'dispatch requested', ref: 'main' })).run();
  let accepted = false;
  try {
    const response = await fetcher(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${spec.file}/dispatches`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ScreenPeek-admin' },
      body: JSON.stringify({ ref: 'main', inputs: {} }),
    });
    accepted = response.status === 204;
  } catch { /* Retain the intent log without leaking transport/credential data. */ }
  await env.DB.prepare('UPDATE admin_log SET after=? WHERE id=?').bind(JSON.stringify({ status: accepted ? 'dispatch accepted' : 'dispatch unconfirmed', ref: 'main' }), log.meta.last_row_id).run();
  if (!accepted) throw new AdminError('GitHub did not confirm the dispatch. Check Actions before retrying to avoid duplicate runs.', 502);
  return `https://github.com/${env.GITHUB_REPO}/actions/workflows/${spec.file}`;
}

/** Tools cache purge: one URL, or the whole zone when the field is empty. Mirrors the delivery purge's success check. */
export async function purgeCache(env: AdminEnvironment, actor: AdminIdentity, rawUrl: string, fetcher: typeof fetch = fetch) {
  const value = rawUrl.trim();
  if (value.length > 2048) throw new AdminError('The URL is too long.');
  let files: string[] | undefined;
  if (value) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new AdminError('Enter a full URL to purge, or leave the field empty to purge everything.'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new AdminError('Enter a full URL to purge, or leave the field empty to purge everything.');
    files = [parsed.href];
  }
  if (!env.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ZONE_ID || '')) throw new AdminError('Cache purge is not configured. Add the Cloudflare zone ID and API token in secure settings.', 503);
  let ok = false;
  try {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/purge_cache`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(files ? { files } : { purge_everything: true }),
    });
    const data: unknown = await response.json().catch(() => null);
    ok = !!data && typeof data === 'object' && 'success' in data && (data as { success: unknown }).success === true;
  } catch { /* Fall through to the failure result. */ }
  await env.DB.prepare("INSERT INTO admin_log(actor,entity,entity_id,before,after) VALUES(?,'cache',?,NULL,?)")
    .bind(actor.email, files ? files[0] : 'all', JSON.stringify({ status: ok ? 'purge accepted' : 'purge failed' })).run();
  if (!ok) throw new AdminError('Cloudflare did not confirm the cache purge.', 502);
  return files ? 'Cache purge accepted for that URL. Static pages still refresh on the next build.' : 'Full cache purge accepted. Static pages still refresh on the next build.';
}
