import { searchText, searchTitles } from '../../src/lib/search.ts';
import { sampleMode, titleUrl } from '../../src/lib/catalogue.ts';
import { mediaUrl } from '../../src/lib/media.ts';

export interface SearchEnvironment { DB: D1Database; R2_PUBLIC_BASE?: string; }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export async function handleSearch(request: Request, env: SearchEnvironment) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
  let query: string;
  try { query = searchText(new URL(request.url).searchParams.get('q') || ''); }
  catch { return json({ error: 'Search query must be at most 100 characters', results: [] }, 400); }
  if (query.length < 2) return json({ results: [] });
  try {
    const data = await searchTitles(env.DB, query, { suggestions: true, includeUngated: await sampleMode(env.DB) });
    return json({ results: data.titles.map(title => ({ id: title.id, type: title.type, slug: title.slug, title: title.title, year: title.year,
      href: titleUrl(title), poster: mediaUrl(title.poster_r2, env.R2_PUBLIC_BASE, 185) })) });
  } catch { return json({ error: 'Search is temporarily unavailable', results: [] }, 503); }
}
