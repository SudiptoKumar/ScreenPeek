import type { SqlClient, SqlStatement, SqlValue } from './storage.ts';
import type { TransformedTitle } from './types.ts';
import { slugBase, type transformPerson } from './transform.ts';

const jsonArray = (expression: string) => `CASE WHEN json_valid(${expression}) THEN CASE WHEN json_type(${expression})='array' THEN ${expression} ELSE '[]' END ELSE '[]' END`;
const locked = (alias: string, field: string) => `((CASE WHEN json_valid(${alias}.locked_fields) THEN json_type(${alias}.locked_fields) ELSE 'null' END)<>'array' OR EXISTS(SELECT 1 FROM json_each(${jsonArray(`${alias}.locked_fields`)}) WHERE value='${field}'))`;

/** Sync writes use current database locks, never a stale pre-fetch copy. */
export async function persistTitle(
  db: SqlClient,
  data: TransformedTitle,
  media: { poster: string | null; backdrop: string | null; gallery: string[]; posterColor?: string | null },
  options: { popularityGate?: number } = {},
) {
  const threshold = options.popularityGate ?? 10;
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('Popularity gate must be non-negative');
  const { id, type } = data.title;
  const row: Record<string, SqlValue> = {
    ...data.title, poster_r2: media.poster, backdrop_r2: media.backdrop,
    gallery_r2: JSON.stringify(media.gallery), studio: data.extra.studios.join(', ') || null,
    budget: data.extra.budget, revenue: data.extra.revenue,
    quality_gate: 0, added_at: data.title.updated_at,
  };
  if (media.posterColor !== undefined) row.poster_color = media.posterColor;
  const columns = Object.keys(row);
  const parameters: SqlValue[] = [];
  const values = columns.map(column => {
    if (column === 'slug') {
      parameters.push(id, type, row[column]);
      return 'COALESCE((SELECT slug FROM titles WHERE id=? AND type=?),?)';
    }
    parameters.push(row[column]); return '?';
  });
  const excluded = new Set(['id', 'type', 'slug', 'added_at', 'quality_gate']);
  const updates = columns.filter(column => !excluded.has(column))
    .map(column => `${column}=CASE WHEN ${locked('titles', column)} THEN titles.${column} ELSE excluded.${column} END`);
  const guard = (field?: string) => `EXISTS(SELECT 1 FROM titles t WHERE t.id=? AND t.type=? AND t.deleted=0 AND t.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM blocklist b WHERE b.tmdb_id=t.id AND b.type=t.type)${field ? ` AND NOT ${locked('t', field)}` : ''})`;
  const statements: SqlStatement[] = [{
    sql: `INSERT INTO titles(${columns.join(',')}) SELECT ${values.join(',')} WHERE NOT EXISTS(SELECT 1 FROM blocklist WHERE tmdb_id=? AND type=?) AND NOT EXISTS(SELECT 1 FROM titles WHERE id=? AND type=? AND (deleted<>0 OR deleted_at IS NOT NULL)) ON CONFLICT(id,type) DO UPDATE SET ${updates.join(',')} WHERE titles.deleted=0 AND titles.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM blocklist WHERE tmdb_id=titles.id AND type=titles.type)`,
    params: [...parameters, id, type, id, type],
  }];
  for (const genre of data.genres) {
    statements.push({
      sql: `INSERT OR IGNORE INTO genres(slug,name) SELECT ?,? WHERE ${guard()} AND EXISTS(SELECT 1 FROM titles t,json_each(${jsonArray('t.genres')}) j WHERE t.id=? AND t.type=? AND j.value=?)`,
      params: [genre.slug, genre.name, id, type, id, type, genre.slug],
    });
  }
  statements.push({
    sql: `INSERT OR IGNORE INTO genres(slug,name) SELECT j.value,j.value FROM titles t,json_each(${jsonArray('t.genres')}) j WHERE t.id=? AND t.type=? AND typeof(j.value)='text' AND ${guard()}`,
    params: [id, type, id, type],
  }, {
    sql: `DELETE FROM title_genres WHERE title_id=? AND title_type=? AND ${guard()}`,
    params: [id, type, id, type],
  }, {
    sql: `INSERT INTO title_genres(title_id,title_type,genre_slug) SELECT DISTINCT t.id,t.type,j.value FROM titles t,json_each(${jsonArray('t.genres')}) j WHERE t.id=? AND t.type=? AND typeof(j.value)='text' AND ${guard()}`,
    params: [id, type, id, type],
  });
  let languageName = data.title.original_language;
  try { languageName = new Intl.DisplayNames(['en'], { type: 'language' }).of(languageName) || languageName; } catch { /* retain unknown stored language codes */ }
  statements.push({
    sql: `INSERT OR IGNORE INTO languages(slug,name) SELECT original_language,CASE WHEN original_language=? THEN ? ELSE original_language END FROM titles WHERE id=? AND type=? AND original_language<>'' AND ${guard()}`,
    params: [data.title.original_language, languageName, id, type, id, type],
  });
  // Replace derived source relations only when their current title is writable.
  for (const table of ['credits', 'releases'] as const) {
    statements.push({ sql: `DELETE FROM ${table} WHERE title_id=? AND title_type=? AND ${guard(table)}`, params: [id, type, id, type] });
  }
  statements.push({
    sql: `INSERT INTO credits(title_id,title_type,person_id,role,character,ord) SELECT ?,?,json_extract(j.value,'$.person_id'),json_extract(j.value,'$.role'),json_extract(j.value,'$.character'),json_extract(j.value,'$.ord') FROM json_each(?) j WHERE ${guard('credits')}`,
    params: [id, type, JSON.stringify(data.credits), id, type],
  }, {
    sql: `INSERT INTO releases(title_id,title_type,country,release_date,certification) SELECT ?,?,json_extract(j.value,'$.country'),json_extract(j.value,'$.release_date'),json_extract(j.value,'$.certification') FROM json_each(?) j WHERE ${guard('releases')}`,
    params: [id, type, JSON.stringify(data.releases), id, type],
  });
  // Delete stale offers, but retain matching rows so copied provider logos survive.
  const providers = JSON.stringify(data.providers);
  statements.push({
    sql: `DELETE FROM providers WHERE title_id=? AND title_type=? AND ${guard('providers')} AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.country')=providers.country AND json_extract(j.value,'$.provider_id')=providers.provider_id AND json_extract(j.value,'$.offer_type')=providers.offer_type)`,
    params: [id, type, id, type, providers],
  }, {
    sql: `INSERT INTO providers(title_id,title_type,country,provider_id,provider_name,offer_type,logo_r2) SELECT ?,?,json_extract(j.value,'$.country'),json_extract(j.value,'$.provider_id'),json_extract(j.value,'$.provider_name'),json_extract(j.value,'$.offer_type'),json_extract(j.value,'$.logo_r2') FROM json_each(?) j WHERE ${guard('providers')} ON CONFLICT(title_id,title_type,country,provider_id,offer_type) DO UPDATE SET provider_name=excluded.provider_name,logo_r2=COALESCE(excluded.logo_r2,providers.logo_r2)`,
    params: [id, type, providers, id, type],
  });
  if (type === 'tv') {
    statements.push({
      sql: `DELETE FROM seasons WHERE title_id=? AND ${guard('seasons')} AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.season_number')=seasons.season_number)`,
      params: [id, id, type, JSON.stringify(data.seasons)],
    }, {
      sql: `INSERT INTO seasons(title_id,season_number,name,episode_count,air_date) SELECT ?,json_extract(j.value,'$.season_number'),json_extract(j.value,'$.name'),json_extract(j.value,'$.episode_count'),json_extract(j.value,'$.air_date') FROM json_each(?) j WHERE ${guard('seasons')} ON CONFLICT(title_id,season_number) DO UPDATE SET name=excluded.name,episode_count=excluded.episode_count,air_date=excluded.air_date`,
      params: [id, JSON.stringify(data.seasons), id, type],
    }, {
      sql: `DELETE FROM episodes WHERE title_id=? AND ${guard('seasons')} AND NOT EXISTS(SELECT 1 FROM seasons s WHERE s.title_id=episodes.title_id AND s.season_number=episodes.season_number)`,
      params: [id, id, type],
    });
  }
  statements.push({ sql: `DELETE FROM collection_titles WHERE title_id=? AND title_type=? AND source='tmdb' AND ${guard('collection')}`, params: [id, type, id, type] });
  if (data.collection && Number.isSafeInteger(data.collection.id) && data.collection.id > 0 && data.collection.name.trim()) {
    const slug = slugBase(data.collection.name) || `collection-${data.collection.id}`;
    statements.push({
      sql: `INSERT OR IGNORE INTO collections(slug,name) SELECT ?,? WHERE ${guard('collection')}`,
      params: [slug, data.collection.name, id, type],
    }, {
      sql: `INSERT OR IGNORE INTO collection_titles(collection_slug,title_id,title_type,source) SELECT ?,?,?,'tmdb' WHERE ${guard('collection')}`,
      params: [slug, id, type, id, type],
    });
  }
  statements.push({
    sql: `UPDATE titles SET quality_gate=CASE WHEN poster_r2 IS NOT NULL AND length(trim(poster_r2))>0 AND length(overview)>=80 AND popularity>=? AND ((SELECT count(*) FROM credits c WHERE c.title_id=titles.id AND c.title_type=titles.type AND c.role='cast')>=3 OR EXISTS(SELECT 1 FROM providers p WHERE p.title_id=titles.id AND p.title_type=titles.type)) THEN 1 ELSE 0 END WHERE id=? AND type=? AND ${guard()}`,
    params: [threshold, id, type, id, type],
  }, {
    sql: `DELETE FROM titles_fts WHERE slug=(SELECT slug FROM titles WHERE id=? AND type=?) AND ${guard()}`,
    params: [id, type, id, type],
  }, {
    sql: `INSERT INTO titles_fts(title,slug,year,type) SELECT title,slug,year,type FROM titles WHERE id=? AND type=? AND ${guard()}`,
    params: [id, type, id, type],
  });
  return db.batch(statements);
}

export async function persistPerson(db: SqlClient, person: ReturnType<typeof transformPerson>, profileKey: string | null) {
  const fields = ['name', 'bio', 'popularity', 'profile_r2', 'updated_at'];
  return db.batch([{
    sql: `INSERT INTO people(id,slug,name,bio,popularity,profile_r2,updated_at) SELECT ?,COALESCE((SELECT slug FROM people WHERE id=?),?),?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM blocklist WHERE tmdb_id=? AND type='person') AND NOT EXISTS(SELECT 1 FROM people WHERE id=? AND deleted_at IS NOT NULL) ON CONFLICT(id) DO UPDATE SET ${fields.map(field => `${field}=CASE WHEN ${locked('people', field)} THEN people.${field} ELSE excluded.${field} END`).join(',')} WHERE people.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM blocklist WHERE tmdb_id=people.id AND type='person')`,
    params: [person.id, person.id, person.slug, person.name, person.bio, person.popularity, profileKey, person.updated_at, person.id, person.id],
  }]);
}

/** Run once after a sync, rather than rescanning lookups for every imported title. */
export async function refreshCounts(db: SqlClient) {
  // The WHERE guards matter: without them every run rewrites every row
  // of these tables (each one a counted D1 write) even when no count
  // changed. Only rows whose count actually moved are written now.
  const genresCount = `(SELECT count(*) FROM title_genres g JOIN titles t ON t.id=g.title_id AND t.type=g.title_type WHERE g.genre_slug=genres.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL)`;
  const languagesCount = `(SELECT count(*) FROM titles t WHERE t.original_language=languages.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL)`;
  const collectionsCount = `(SELECT count(*) FROM collection_titles c JOIN titles t ON t.id=c.title_id AND t.type=c.title_type WHERE c.collection_slug=collections.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL)`;
  return db.batch([
    { sql: `UPDATE genres SET title_count=${genresCount} WHERE title_count <> ${genresCount}` },
    { sql: `UPDATE languages SET title_count=${languagesCount} WHERE title_count <> ${languagesCount}` },
    { sql: `UPDATE collections SET title_count=${collectionsCount} WHERE title_count <> ${collectionsCount}` },
  ]);
}
