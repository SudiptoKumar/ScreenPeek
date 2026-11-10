import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const manifest = JSON.parse(readFileSync(new URL('./seed-manifest.json', import.meta.url), 'utf8'));
const timestamp = '2026-11-09T00:00:00.000Z';
const marker = JSON.stringify(manifest);
const sql = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const pairs = manifest.titles.map(({ id, type }) => `(${id},${sql(type)})`).join(',');
const titleIds = manifest.titles.map(({ id }) => id).join(',');
const tvIds = manifest.titles.filter(({ type }) => type === 'tv').map(({ id }) => id).join(',');
const peopleIds = manifest.peopleIds.join(',');
const owns = `EXISTS (SELECT 1 FROM config WHERE key=${sql(manifest.configKey)} AND value=${sql(marker)})`;
const insert = (table, row) => `INSERT OR IGNORE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(sql).join(',')});`;
const countLookups = [
  `UPDATE genres SET title_count=(SELECT count(*) FROM titles t WHERE t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL AND EXISTS (SELECT 1 FROM json_each(t.genres) WHERE value=genres.slug));`,
  `UPDATE languages SET title_count=(SELECT count(*) FROM titles t WHERE t.original_language=languages.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL);`,
];

export function createSeedSql() {
  const statements = [
    '-- SYNTHETIC DEVELOPMENT DATA: ScreenPeek sample catalogue v1; local use only.',
    '-- A deliberate NOT NULL violation refuses a reserved-ID collision before any fixture is changed.',
    `INSERT INTO config(key,value) SELECT 'dev:sample-seed-conflict',NULL WHERE EXISTS(SELECT 1 FROM config WHERE key=${sql(manifest.configKey)} AND value<>${sql(marker)}) OR (NOT ${owns} AND (EXISTS(SELECT 1 FROM titles WHERE id IN (${titleIds})) OR EXISTS(SELECT 1 FROM people WHERE id IN (${peopleIds}))));`,
    insert('config', { key: manifest.configKey, value: marker }),
  ];
  for (const [slug, name] of [['adventure', 'Adventure'], ['drama', 'Drama'], ['science-fiction', 'Science Fiction']]) {
    statements.push(insert('genres', { slug, name }));
  }
  statements.push(insert('languages', { slug: 'en', name: 'English' }));
  statements.push("INSERT OR IGNORE INTO config(key,value) SELECT 'dev:sample_collection','sample-collection' WHERE NOT EXISTS(SELECT 1 FROM collections WHERE slug='sample-collection');");
  statements.push(insert('collections', { slug: 'sample-collection', name: 'Sample Collection' }));
  for (const [index, id] of manifest.peopleIds.entries()) {
    statements.push(insert('people', {
      id, slug: `sample-person-${index + 1}`, name: `Sample Person ${index + 1}`,
      bio: 'Synthetic ScreenPeek sample data. This fictional person exists only for local development and is not a real performer.',
      popularity: 20 + index, profile_r2: null, updated_at: timestamp,
    }));
  }
  const names = ['The Quiet Atlas', 'Beyond the Lantern', 'A River of Stars', 'The Last Orchard', 'Letters from Tomorrow', 'The Amber Horizon', 'The Hidden Station', 'An Ordinary Wonder', 'The Glass Mountain', 'The Midnight Garden'];
  for (const [index, { id, type }] of manifest.titles.entries()) {
    const year = 2022 + index % 6;
    const genres = index % 3 === 0 ? ['science-fiction', 'adventure'] : index % 3 === 1 ? ['drama'] : ['adventure'];
    const title = `Sample: ${names[index % names.length]} ${Math.floor(index / names.length) + 1}`;
    const slug = `${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/-$/, '')}-${year}`;
    statements.push(insert('titles', {
      id, type, slug, title, original_title: title,
      overview: 'Synthetic ScreenPeek sample data, not a real movie or television programme. A curious traveller follows a mysterious invitation and discovers how friendship, courage and everyday choices can reshape a community.',
      release_date: `${year}-${String(index % 12 + 1).padStart(2, '0')}-15`, year,
      runtime_min: type === 'tv' ? 42 : 90 + index % 35,
      status: year > 2026 ? 'Planned' : type === 'tv' ? 'Returning Series' : 'Released',
      original_language: 'en', popularity: 35 + index, vote_average: null, vote_count: 0,
      poster_r2: null, backdrop_r2: null, og_r2: null, poster_color: null,
      genres: JSON.stringify(genres),
      similar_ids: JSON.stringify(manifest.titles.filter(item => item.type === type && item.id !== id).slice(0, 12).map(item => item.id)),
      quality_gate: 0, added_at: timestamp, updated_at: timestamp,
    }));
    for (let order = 0; order < 4; order++) {
      statements.push(insert('credits', {
        title_id: id, title_type: type, person_id: manifest.peopleIds[(index + order) % manifest.peopleIds.length],
        role: order === 3 ? (type === 'tv' ? 'creator' : 'director') : 'cast',
        character: order === 3 ? null : `Sample Character ${order + 1}`, ord: order,
      }));
    }
    // Every fifth title intentionally has no providers, to exercise the empty state.
    if (index % 5 !== 0) {
      for (const [countryIndex, country] of ['US', 'GB', 'CA', 'AU'].entries()) {
        if (index % 7 === 0 && countryIndex > 0) continue;
        statements.push(insert('providers', {
          title_id: id, title_type: type, country,
          provider_id: -30001 - countryIndex % 2,
          provider_name: countryIndex % 2 ? 'Sample Rental Service' : 'Sample Streaming Service',
          logo_r2: null, offer_type: countryIndex % 2 ? 'rent' : 'stream',
        }));
      }
    }
    if (type === 'tv') {
      for (let season = 1; season <= 2; season++) {
        statements.push(insert('seasons', { title_id: id, season_number: season, name: `Sample Season ${season}`, episode_count: 3, air_date: `${year}-01-01` }));
        for (let episode = 1; episode <= 3; episode++) {
          statements.push(insert('episodes', {
            title_id: id, season_number: season, episode_number: episode, name: `Sample Episode ${episode}`,
            overview: 'Synthetic episode summary for testing the local season and episode pages.',
            air_date: `${year}-01-${String(episode * 7).padStart(2, '0')}`, still_r2: null,
          }));
        }
      }
    }
  }
  // Manual FTS upkeep: reruns reflect existing rows without overwriting edits.
  statements.push(`DELETE FROM titles_fts WHERE slug IN (SELECT slug FROM titles WHERE (id,type) IN (${pairs}));`);
  statements.push(`INSERT INTO titles_fts(title,slug,year,type) SELECT title,slug,year,type FROM titles WHERE (id,type) IN (${pairs});`);
  statements.push(...countLookups);
  return `${statements.join('\n')}\n`;
}

export function createRemovalSql() {
  return [
    '-- Removes only the synthetic fixture manifest owned by ScreenPeek sample v1.',
    '-- Missing or changed ownership marker => no fixture deletions. Shared lookups remain.',
    `DELETE FROM titles_fts WHERE ${owns} AND slug IN (SELECT slug FROM titles WHERE (id,type) IN (${pairs}));`,
    ...['credits', 'providers', 'releases', 'votes'].map(table => `DELETE FROM ${table} WHERE ${owns} AND (title_id,title_type) IN (${pairs});`),
    ...['episodes', 'seasons'].map(table => `DELETE FROM ${table} WHERE ${owns} AND title_id IN (${tvIds});`),
    `DELETE FROM titles WHERE ${owns} AND (id,type) IN (${pairs});`,
    `DELETE FROM people WHERE ${owns} AND id IN (${peopleIds}) AND NOT EXISTS(SELECT 1 FROM credits WHERE person_id=people.id);`,
    ...countLookups,
    `DELETE FROM config WHERE key=${sql(manifest.configKey)} AND value=${sql(marker)};`,
  ].join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(process.argv.includes('--remove') ? createRemovalSql() : createSeedSql());
}
