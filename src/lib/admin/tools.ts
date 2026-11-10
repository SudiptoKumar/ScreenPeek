export interface ToolTitle { id: number; type: 'movie' | 'tv'; title: string; slug: string; hidden: number; deleted: number; }
export interface ToolPerson { name: string; slug: string; }
export interface ToolLink { slug: string; name: string; type: string; enabled: number; }
export interface ToolPage { slug: string; title: string; }
export interface ToolRedirect { from_path: string; to_target: string; type: number; }
export interface ToolResults { query: string; titles: ToolTitle[]; people: ToolPerson[]; links: ToolLink[]; pages: ToolPage[]; redirects: ToolRedirect[]; }
const like = (value: string) => `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

/** One-box admin search across the entities an owner looks for daily. Bounded and escaped; trashed rows stay out. */
export async function globalSearch(db: D1Database, rawQuery: string): Promise<ToolResults> {
  const query = rawQuery.trim().slice(0, 100);
  const empty: ToolResults = { query, titles: [], people: [], links: [], pages: [], redirects: [] };
  if (query.length < 2) return empty;
  const pattern = like(query);
  const [titles, people, links, pages, redirects] = await Promise.all([
    db.prepare("SELECT id,type,title,slug,hidden,deleted FROM titles WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\') ORDER BY popularity DESC,id,type LIMIT 8").bind(pattern, pattern).all<ToolTitle>(),
    db.prepare("SELECT name,slug FROM people WHERE deleted_at IS NULL AND (name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\') ORDER BY popularity DESC LIMIT 8").bind(pattern, pattern).all<ToolPerson>(),
    db.prepare("SELECT slug,name,type,enabled FROM links WHERE deleted_at IS NULL AND (name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\') ORDER BY name,slug LIMIT 8").bind(pattern, pattern).all<ToolLink>(),
    db.prepare("SELECT slug,title FROM pages WHERE slug LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' ORDER BY slug LIMIT 8").bind(pattern, pattern).all<ToolPage>(),
    db.prepare("SELECT from_path,to_target,type FROM redirects WHERE from_path LIKE ? ESCAPE '\\' OR to_target LIKE ? ESCAPE '\\' ORDER BY from_path LIMIT 8").bind(pattern, pattern).all<ToolRedirect>(),
  ]);
  return { query, titles: titles.results, people: people.results, links: links.results, pages: pages.results, redirects: redirects.results };
}
