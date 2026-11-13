import { sampleMode } from './catalogue.ts';
import { productionSeo, siteOrigin } from './seo.ts';
import type { SeoEnvironment } from './seo.ts';
export type SitemapKind = 'titles' | 'people' | 'taxonomy' | 'pages';
interface SitemapEnvironment extends SeoEnvironment { DB: D1Database; }
const size = 10_000;
const visible = 't.quality_gate=1 AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL';
const titlePath = "'/'||CASE WHEN t.type='movie' THEN 'movie' ELSE 'tv' END||'/'||t.slug||'/'";
const titleWhere = `${visible} AND NOT EXISTS(SELECT 1 FROM seo_overrides o WHERE o.path=${titlePath} AND o.noindex=1 AND o.deleted_at IS NULL)`;
const personWhere = `p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM seo_overrides o WHERE o.path='/cast/'||p.slug||'/' AND o.noindex=1 AND o.deleted_at IS NULL)
  AND EXISTS(SELECT 1 FROM credits c JOIN titles t ON t.id=c.title_id AND t.type=c.title_type WHERE c.person_id=p.id AND ${visible})`;
const taxonomy = `SELECT x.kind,x.slug FROM (
  SELECT 'genre' AS kind,g.slug FROM genres g WHERE EXISTS(SELECT 1 FROM title_genres r JOIN titles t ON t.id=r.title_id AND t.type=r.title_type WHERE r.genre_slug=g.slug AND ${visible})
  UNION ALL SELECT 'collection',c.slug FROM collections c WHERE c.deleted_at IS NULL AND (c.starts_at IS NULL OR datetime(c.starts_at)<=datetime('now')) AND (c.ends_at IS NULL OR datetime(c.ends_at)>datetime('now')) AND EXISTS(SELECT 1 FROM collection_titles r JOIN titles t ON t.id=r.title_id AND t.type=r.title_type WHERE r.collection_slug=c.slug AND ${visible})
  UNION ALL SELECT 'language',l.slug FROM languages l WHERE EXISTS(SELECT 1 FROM titles t WHERE t.original_language=l.slug AND ${visible})
  ) x WHERE NOT EXISTS(SELECT 1 FROM taxonomy_overrides o WHERE o.kind=x.kind AND o.slug=x.slug AND o.hidden<>0 AND o.deleted_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM seo_overrides s WHERE s.path='/'||x.kind||'/'||x.slug||'/' AND s.noindex=1 AND s.deleted_at IS NULL)`;
const pageQuery = `SELECT path,updated_at FROM (
  WITH core(path,type,upcoming) AS (VALUES('/',NULL,0),('/movies/','movie',0),('/series/','tv',0),('/new/',NULL,0),('/top10/',NULL,0),('/top-rated/',NULL,0),('/genres/',NULL,0),('/upcoming/',NULL,1))
  SELECT core.path,NULL AS updated_at FROM core WHERE core.path='/' OR EXISTS(SELECT 1 FROM titles t WHERE ${visible} AND (core.type IS NULL OR t.type=core.type) AND (core.upcoming=0 OR t.release_date>date('now')))
  UNION ALL SELECT '/'||slug||'/',updated_at FROM pages WHERE slug IN('about','privacy','dmca','contact') AND length(trim(title))>0 AND length(trim(body_md))>0
  ) p WHERE NOT EXISTS(SELECT 1 FROM seo_overrides o WHERE o.path=p.path AND o.noindex=1 AND o.deleted_at IS NULL)`;
export const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const xml = (body: string, status = 200, cache = 'public, s-maxage=86400, stale-while-revalidate=604800') => new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
  status, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
});
const empty = () => xml('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', 200, 'no-store');
const error = (status = 503) => xml(`<error>${status === 404 ? 'Sitemap not found.' : 'Sitemap temporarily unavailable.'}</error>`, status, 'no-store');
function lastmod(value: string | null) {
  if (!value) return '';
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
  return Number.isFinite(parsed) ? `<lastmod>${new Date(parsed).toISOString().slice(0, 10)}</lastmod>` : '';
}
export async function sitemapCount(db: D1Database, kind: SitemapKind) {
  const sql = kind === 'titles' ? `SELECT COUNT(*) AS count FROM titles t WHERE ${titleWhere}` : kind === 'people' ? `SELECT COUNT(*) AS count FROM people p WHERE ${personWhere}` : kind === 'taxonomy' ? `SELECT COUNT(*) AS count FROM (${taxonomy})` : `SELECT COUNT(*) AS count FROM (${pageQuery})`;
  return (await db.prepare(sql).first<{ count: number }>())?.count || 0;
}
const mapPath = (kind: SitemapKind, page: number) => kind === 'titles' || page > 1 ? `/sitemap-${kind}-${page}.xml` : `/sitemap-${kind}.xml`;
export async function sitemapIndex(env: SitemapEnvironment) {
  if (!productionSeo(env)) return xml('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>', 200, 'no-store');
  try {
    if (await sampleMode(env.DB)) return xml('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>', 200, 'no-store');
    const origin = siteOrigin(env.SITE_URL), entries: string[] = [];
    for (const kind of ['titles', 'people', 'taxonomy', 'pages'] as const) {
      const pages = Math.max(1, Math.ceil(await sitemapCount(env.DB, kind) / size));
      for (let page = 1; page <= pages; page++) entries.push(`<sitemap><loc>${xmlEscape(origin + mapPath(kind, page))}</loc></sitemap>`);
    }
    return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</sitemapindex>`);
  } catch { return error(); }
}
export async function sitemapPart(env: SitemapEnvironment, kind: SitemapKind, pageInput = '1') {
  if (!/^[1-9]\d{0,5}$/.test(pageInput)) return error(404);
  if (!productionSeo(env)) return empty();
  const page = Number(pageInput), offset = (page - 1) * size;
  try {
    if (await sampleMode(env.DB)) return empty();
    const total = await sitemapCount(env.DB, kind);
    if (page > Math.max(1, Math.ceil(total / size))) return error(404);
    let rows: Array<{ path: string; updated_at: string | null }>;
    if (kind === 'titles') rows = (await env.DB.prepare(`SELECT ${titlePath} AS path,t.updated_at FROM titles t WHERE ${titleWhere} ORDER BY t.id,t.type LIMIT ? OFFSET ?`).bind(size, offset).all<typeof rows[number]>()).results;
    else if (kind === 'people') rows = (await env.DB.prepare(`SELECT '/cast/'||p.slug||'/' AS path,p.updated_at FROM people p WHERE ${personWhere} ORDER BY p.id LIMIT ? OFFSET ?`).bind(size, offset).all<typeof rows[number]>()).results;
    else if (kind === 'taxonomy') rows = (await env.DB.prepare(`SELECT '/'||kind||'/'||slug||'/' AS path,NULL AS updated_at FROM (${taxonomy}) ORDER BY kind,slug LIMIT ? OFFSET ?`).bind(size, offset).all<typeof rows[number]>()).results;
    else rows = (await env.DB.prepare(`${pageQuery} ORDER BY path LIMIT ? OFFSET ?`).bind(size, offset).all<typeof rows[number]>()).results;
    const origin = siteOrigin(env.SITE_URL);
    return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.map(row => `<url><loc>${xmlEscape(new URL(row.path, origin).href)}</loc>${lastmod(row.updated_at)}</url>`).join('')}</urlset>`);
  } catch { return error(); }
}
export function robots(env: SeoEnvironment) {
  const body = productionSeo(env) ? `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /go/\nDisallow: /api/\nDisallow: /search/\nSitemap: ${siteOrigin(env.SITE_URL)}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, s-maxage=3600', 'X-Content-Type-Options': 'nosniff' } });
}
