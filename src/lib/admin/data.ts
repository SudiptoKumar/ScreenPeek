import { requirePermission } from './access.ts';
import type { AdminIdentity, AdminModule } from './access.ts';
import type { AdminEnvironment } from './changes.ts';
import type { AdPage, AdPlacement } from '../ads.ts';
import type { TrustDocument } from '../trust.ts';
import { globalSearch } from './tools.ts';
import type { ToolResults } from './tools.ts';

export interface AdminLink { slug: string; name: string; destination: string; type: string; enabled: number; rules: string; clicks_total: number; clicks_today: number; clicks_day: string | null; starts_at: string | null; ends_at: string | null; revision: number; }
export interface AdminAd { page_type: AdPage; placement: AdPlacement; code: string; enabled: number; test_mode: number; starts_at: string | null; ends_at: string | null; revision: number; }
export interface AdminTitle { id: number; type: 'movie' | 'tv'; slug: string; title: string; pinned: number; hidden: number; revision: number; }
export interface SyncRow { id: number; started_at: string; finished_at: string | null; status: string; added: number; updated: number; errors: string; }
export interface HistoryRow { id: number; ts: string; actor: string | null; entity: string; entity_id: string; }
export interface SettingRow { key: string; value: string; revision: number; }
interface CatalogueMeters { titles: number; gated: number; people: number; clicks: number; }
export interface RevenueDay { date: string; impressions: number; clicks: number; cpm: number; revenue: number; }
export interface RevenueMeters { yesterday: RevenueDay | null; monthRevenue: number; monthImpressions: number; allTime: number; balanceEstimate: number; updatedAt: string | null; formats: Array<{ placement_id: number; revenue: number; impressions: number }>; trend: RevenueDay[]; payoutMin: number; }
const like = (value: string) => `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
export async function adminData(env: AdminEnvironment, actor: AdminIdentity, module: AdminModule, url: URL) {
  requirePermission(actor, module);
  const db = env.DB, query = (url.searchParams.get('q') || '').slice(0, 100), page = Math.min(100_000, Math.max(1, Number.parseInt(url.searchParams.get('page') || '1') || 1));
  let links: AdminLink[] = [], selectedLink: AdminLink | null = null, slots: AdminAd[] = [], titles: AdminTitle[] = [], sync: SyncRow[] = [], changes: HistoryRow[] = [], settings: SettingRow[] = [];
  let total = 0, pending = 0, catalogue: CatalogueMeters | null = null, tools: ToolResults | null = null, revenue: RevenueMeters | null = null;
  let documents: TrustDocument[] = [];
  if (module === 'links') {
    const where = '(name LIKE ? ESCAPE \'\\\' OR slug LIKE ? ESCAPE \'\\\') AND deleted_at IS NULL';
    const values = [like(query), like(query)];
    total = (await db.prepare(`SELECT COUNT(*) AS count FROM links WHERE ${where}`).bind(...values).first<{ count: number }>())?.count || 0;
    links = (await db.prepare(`SELECT * FROM links WHERE ${where} ORDER BY name,slug LIMIT 50 OFFSET ?`).bind(...values, (page - 1) * 50).all<AdminLink>()).results;
    if (url.searchParams.has('edit')) selectedLink = await db.prepare('SELECT * FROM links WHERE slug=? AND deleted_at IS NULL').bind((url.searchParams.get('edit') || '').slice(0, 120)).first<AdminLink>();
  } else if (module === 'ads') {
    slots = (await db.prepare('SELECT * FROM ad_slots WHERE deleted_at IS NULL ORDER BY page_type,placement').all<AdminAd>()).results;
    settings = (await db.prepare("SELECT key,value,revision FROM config WHERE key IN ('ads_enabled','popunder_cap_hours','ads_display_enabled','ads_native_enabled','ads_sticky_enabled','ads_social_enabled','ads_popunder_enabled','ads_txt')").all<SettingRow>()).results;
  }
  else if (module === 'content') {
    const where = "deleted=0 AND deleted_at IS NULL AND title LIKE ? ESCAPE '\\'";
    total = (await db.prepare(`SELECT COUNT(*) AS count FROM titles WHERE ${where}`).bind(like(query)).first<{ count: number }>())?.count || 0;
    titles = (await db.prepare(`SELECT id,type,slug,title,pinned,hidden,revision FROM titles WHERE ${where} ORDER BY pinned DESC,popularity DESC,id,type LIMIT 50 OFFSET ?`).bind(like(query), (page - 1) * 50).all<AdminTitle>()).results;
  } else if (module === 'sync') sync = (await db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 20').all<SyncRow>()).results;
  else if (module === 'settings') settings = (await db.prepare('SELECT key,value,revision FROM config ORDER BY key').all<SettingRow>()).results;
  else if (module === 'pages') documents = (await db.prepare("SELECT * FROM pages WHERE slug IN('about','privacy','dmca','contact','404') ORDER BY slug").all<TrustDocument>()).results;
  else if (module === 'dashboard') {
    const day = new Date().toISOString().slice(0, 10);
    const [counts, history, logs, queued] = await Promise.all([
      db.prepare('SELECT (SELECT COUNT(*) FROM titles WHERE deleted=0 AND deleted_at IS NULL) AS titles,(SELECT COUNT(*) FROM titles WHERE quality_gate=1 AND hidden=0 AND deleted=0 AND deleted_at IS NULL) AS gated,(SELECT COUNT(*) FROM people WHERE deleted_at IS NULL) AS people,(SELECT COALESCE(SUM(count),0) FROM click_log WHERE day=?) AS clicks').bind(day).first<CatalogueMeters>(),
      db.prepare('SELECT id,ts,actor,entity,entity_id FROM admin_log ORDER BY id DESC LIMIT 20').all<HistoryRow>(),
      db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').all<SyncRow>(),
      db.prepare('SELECT COUNT(*) AS count FROM admin_delivery WHERE kv_done=0 OR purge_done=0').first<{ count: number }>(),
    ]);
    catalogue = counts; changes = history.results; sync = logs.results; pending = queued?.count || 0;
    try {
      const now = new Date();
      const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)).toISOString().slice(0, 10);
      const [yRow, mRow, tRow, paidRow, fRows, uRow, dRows, pMinRow] = await Promise.all([
        db.prepare('SELECT date,impressions,clicks,cpm,revenue FROM adsterra_days WHERE date=?').bind(yesterday).first<RevenueDay>(),
        db.prepare('SELECT COALESCE(SUM(revenue),0) AS revenue,COALESCE(SUM(impressions),0) AS impressions FROM adsterra_days WHERE date>=?').bind(monthStart).first<{ revenue: number; impressions: number }>(),
        db.prepare('SELECT COALESCE(SUM(revenue),0) AS total FROM adsterra_days').first<{ total: number }>(),
        db.prepare("SELECT value FROM config WHERE key='money_paid_modeled'").first<{ value: string }>(),
        db.prepare('SELECT placement_id,SUM(revenue) AS revenue,SUM(impressions) AS impressions FROM adsterra_formats GROUP BY placement_id ORDER BY revenue DESC LIMIT 6').all<{ placement_id: number; revenue: number; impressions: number }>(),
        db.prepare('SELECT MAX(updated_at) AS at FROM adsterra_days').first<{ at: string | null }>(),
        db.prepare('SELECT date,impressions,clicks,cpm,revenue FROM adsterra_days WHERE date>=? ORDER BY date ASC').bind(trendStart).all<RevenueDay>(),
        db.prepare("SELECT value FROM config WHERE key='payout_min_usd'").first<{ value: string }>(),
      ]);
      const allTime = tRow?.total || 0;
      const payoutMinRaw = Number.parseFloat(pMinRow?.value || '0') || 0;
      if (allTime > 0 || yRow || (fRows.results || []).length) revenue = { yesterday: yRow || null, monthRevenue: mRow?.revenue || 0, monthImpressions: mRow?.impressions || 0, allTime, balanceEstimate: allTime - (Number.parseFloat(paidRow?.value || '0') || 0), updatedAt: uRow?.at || null, formats: fRows.results || [], trend: dRows.results || [], payoutMin: payoutMinRaw > 0 ? payoutMinRaw : 100 };
    } catch { revenue = null; }
  }
  else if (module === 'tools') tools = await globalSearch(db, query);
  return { links, selectedLink, slots, titles, sync, changes, settings, documents, total, page, pages: Math.max(1, Math.ceil(total / 50)), query, pending, catalogue, tools, revenue };
}
export type AdminData = Awaited<ReturnType<typeof adminData>>;
export async function exportAdminBackup(env: AdminEnvironment, actor: AdminIdentity) {
  requirePermission(actor, 'backup');
  if (actor.role !== 'owner') throw new Error('Owner permission is required.');
  const tables = ['links', 'ad_slots', 'config', 'redirects', 'pages', 'taxonomy_overrides', 'collections', 'collection_titles', 'homepage_sections'] as const;
  const data: Record<string, unknown[]> = {};
  for (const table of tables) {
    data[table] = (await env.DB.prepare(`SELECT * FROM ${table} LIMIT 10001`).all()).results;
    if (data[table].length > 10_000) throw new Error('Configuration grew during export; retry the export.');
  }
  const pins = (await env.DB.prepare('SELECT id,type,pinned,hidden,pin_starts_at,pin_ends_at FROM titles WHERE pinned<>0 OR hidden<>0 LIMIT 10001').all()).results;
  if (pins.length > 10_000) throw new Error('Too many content overrides for a manual export.');
  data.content = pins;
  return { format: 'screenpeek-config', version: 1, exported_at: new Date().toISOString(), data };
}
