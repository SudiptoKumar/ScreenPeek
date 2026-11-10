import { micromark } from 'micromark';
export const trustSlugs = ['about', 'privacy', 'dmca', 'contact', '404'] as const;
export type TrustSlug = typeof trustSlugs[number];
export interface TrustDocument { slug: TrustSlug; title: string; body_md: string; updated_at: string; revision: number; }
export function trustMarkdown(markdown: string) {
  return micromark(markdown.slice(0, 20_000), {
    allowDangerousHtml: false, allowDangerousProtocol: false,
    extensions: [{ disable: { null: ['labelStartImage'] } }],
  });
}
export async function loadTrustPage(db: D1Database, slug: string) {
  if (!(trustSlugs as readonly string[]).includes(slug)) return { document: null, html: '', status: 404, cacheControl: 'no-store' };
  try {
    const document = await db.prepare('SELECT slug,title,body_md,updated_at,revision FROM pages WHERE slug=? AND deleted_at IS NULL').bind(slug).first<TrustDocument>();
    if (!document) return { document: null, html: '', status: slug === '404' ? 404 : 503, cacheControl: 'no-store' };
    return { document, html: trustMarkdown(document.body_md), status: slug === '404' ? 404 : 200,
      cacheControl: slug === '404' ? 'no-store' : 'public, s-maxage=86400, stale-while-revalidate=604800' };
  } catch { return { document: null, html: '', status: slug === '404' ? 404 : 503, cacheControl: 'no-store' }; }
}
export type TrustPageData = Awaited<ReturnType<typeof loadTrustPage>>;
