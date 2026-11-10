import { sampleMode } from './catalogue.ts';
import type { TitleCard } from './catalogue.ts';
export interface PersonDetail {
  id: number; slug: string; name: string; bio: string | null; profile_r2: string | null;
  updated_at: string; deleted_at: string | null;
}
export interface FilmographyCard extends TitleCard { credit_roles: string | null; characters: string | null; }
export function creditLabel(card: Pick<FilmographyCard, 'credit_roles' | 'characters'>) {
  const roles = (card.credit_roles || '').split(',');
  const labels = [roles.includes('director') ? 'Director' : '', roles.includes('creator') ? 'Creator' : '',
    roles.includes('cast') ? card.characters ? `as ${card.characters}` : 'Cast' : ''].filter(Boolean);
  return labels.join(' · ');
}

export async function loadPersonPage(db: D1Database, slug: string, pageInput = '1') {
  const requested = Number(pageInput);
  const page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
  let person: PersonDetail | null = null, sample = false, failed = false, total = 0;
  let titles: FilmographyCard[] = [];
  try {
    sample = await sampleMode(db);
    person = await db.prepare('SELECT id,slug,name,bio,profile_r2,updated_at,deleted_at FROM people WHERE slug=?').bind(slug).first<PersonDetail>();
    if (person && !person.deleted_at) {
      const where = `c.person_id=? AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL ${sample ? '' : 'AND t.quality_gate=1'}`;
      const join = 'FROM credits c JOIN titles t ON t.id=c.title_id AND t.type=c.title_type';
      total = (await db.prepare(`SELECT COUNT(*) AS total FROM (SELECT t.id,t.type ${join} WHERE ${where} GROUP BY t.id,t.type)`).bind(person.id).first<{ total: number }>())?.total || 0;
      if (page <= Math.max(1, Math.ceil(total / 24))) titles = (await db.prepare(`SELECT t.id,t.type,t.slug,t.title,t.year,t.poster_r2,t.poster_color,t.vote_average,t.views,t.updated_at,t.release_date,
        GROUP_CONCAT(DISTINCT c.role) AS credit_roles,
        GROUP_CONCAT(DISTINCT CASE WHEN c.role='cast' THEN NULLIF(c.character,'') END) AS characters
        ${join} WHERE ${where} GROUP BY t.id,t.type ORDER BY t.popularity DESC,t.id DESC,t.type LIMIT 24 OFFSET ?`).bind(person.id, (page - 1) * 24).all<FilmographyCard>()).results;
    }
  } catch { failed = true; }
  const pages = Math.max(1, Math.ceil(total / 24));
  const status = failed ? 503 : !person || person.deleted_at || page > pages ? 404 : 200;
  return { person, titles, total, page, pages, sample, failed, status,
    noindex: sample || status !== 200 || total === 0,
    cacheControl: sample || status !== 200 ? 'no-store' : 'public, s-maxage=86400, stale-while-revalidate=604800' };
}
export type PersonPageData = Awaited<ReturnType<typeof loadPersonPage>>;
