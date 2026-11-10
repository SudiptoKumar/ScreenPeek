import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { canonicalUrl, episodeSchema, personSchema, productionSeo, schemaJson, seasonSchema, siteOrigin, titleSchema, trailerSchema } from '../src/lib/seo.ts';
import { robots, sitemapCount, sitemapIndex, sitemapPart } from '../src/lib/sitemaps.ts';
import { loadTitlePage } from '../src/lib/detail.ts';
import { loadPersonPage } from '../src/lib/people.ts';
import { loadEpisodePage, loadSeasonPage } from '../src/lib/seasons.ts';
import { loadTrailerPage } from '../src/lib/trailer.ts';

test('canonical URLs use the configured origin, clean filters/country, and retain only clean pagination', () => {
  const origin = 'https://screenpeek.example.test';
  assert.equal(siteOrigin('https://user:password@example.test'), 'https://example.workers.dev');
  assert.equal(productionSeo({ SITE_URL: origin, DEPLOYMENT_ENV: 'preview' }), false);
  assert.equal(canonicalUrl(new URL('https://untrusted.test/movies/?page=2'), origin, 2), `${origin}/movies/page/2/`);
  assert.equal(canonicalUrl(new URL('https://untrusted.test/movies/?page=2&genre=drama'), origin, 2), `${origin}/movies/`);
  assert.equal(canonicalUrl(new URL('https://untrusted.test/watch/title/?country=GB'), origin), `${origin}/watch/title/`);
  assert.equal(new URL(canonicalUrl(new URL('https://untrusted.test//evil.test/'), origin)).origin, origin);
  assert.equal(schemaJson([{ name: '</script><script>alert(1)</script>' }]).includes('</script>'), false);
  assert.match(robots({ SITE_URL: origin, DEPLOYMENT_ENV: 'production' }).headers.get('content-type') || '', /text\/plain/);
});

test('actual D1 sitemaps exclude ungated/hidden/deleted/trashed/overridden data and paginate after 10000 URLs', async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-seo-'));
  const local = await localBindings(state), db = local.database as unknown as D1Database;
  const env = { DB: db, SITE_URL: 'https://screenpeek.example.test', DEPLOYMENT_ENV: 'production' };
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    for (const file of (await readdir('db/migrations')).filter(file => file.endsWith('.sql')).sort()) await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
    await local.db.batch([
      { sql: `INSERT INTO titles(id,type,slug,title,quality_gate,hidden,deleted,deleted_at,original_language,release_date,overview,runtime_min,updated_at) VALUES
        (1,'movie','allowed-title','Allowed </script> title',1,0,0,NULL,'en','2025-01-01','A stored overview.',108,'2026-11-09T00:00:00Z'),
        (1,'tv','allowed-series','Allowed series',1,0,0,NULL,'en','2025-01-01','A series overview.',45,'2026-11-09T00:00:00Z'),
        (2,'movie','ungated-title','Ungated',0,0,0,NULL,'zz',NULL,NULL,NULL,'invalid'),
        (3,'movie','hidden-title','Hidden',1,1,0,NULL,'en',NULL,NULL,NULL,'invalid'),
        (4,'movie','deleted-title','Deleted',1,0,1,NULL,'en',NULL,NULL,NULL,'invalid'),
        (5,'movie','trashed-title','Trashed',1,0,0,'2026-11-09','en',NULL,NULL,NULL,'invalid'),
        (6,'movie','overridden-title','Override',1,0,0,NULL,'en',NULL,NULL,NULL,'invalid')` },
      { sql: "INSERT INTO seo_overrides(path,noindex) VALUES('/movie/overridden-title/',1),('/cast/private-profile/',1),('/genre/private-genre/',1)" },
      { sql: "INSERT INTO people(id,slug,name) VALUES(101,'allowed-profile','Allowed actor'),(102,'ungated-profile','Ungated actor'),(103,'private-profile','Private actor')" },
      { sql: "INSERT INTO credits(title_id,title_type,person_id,role) VALUES(1,'movie',101,'cast'),(2,'movie',102,'cast'),(1,'movie',103,'cast')" },
      { sql: "INSERT INTO genres(slug,name) VALUES('allowed-genre','Allowed'),('private-genre','Private'),('hidden-genre','Hidden')" },
      { sql: "INSERT INTO title_genres(title_id,title_type,genre_slug) VALUES(1,'movie','allowed-genre'),(1,'movie','private-genre'),(1,'movie','hidden-genre')" },
      { sql: "INSERT INTO taxonomy_overrides(kind,slug,hidden) VALUES('genre','hidden-genre',1)" },
      { sql: "INSERT INTO languages(slug,name) VALUES('en','English'),('zz','Unknown')" },
      { sql: "INSERT INTO seasons(title_id,season_number,name,episode_count) VALUES(1,1,'Season 1',1)" },
      { sql: "INSERT INTO episodes(title_id,season_number,episode_number,name,air_date) VALUES(1,1,1,'Pilot','2025-01-01')" },
      { sql: "UPDATE titles SET trailer_key='sampleKey01' WHERE id=1 AND type='movie'" },
    ]);
    assert.equal(await sitemapCount(db, 'titles'), 2);
    const titles = await (await sitemapPart(env, 'titles')).text();
    assert.match(titles, /allowed-title/); assert.match(titles, /allowed-series/);
    assert.doesNotMatch(titles, /ungated-title|hidden-title|deleted-title|trashed-title|overridden-title/);
    assert.match(titles, /<lastmod>2026-11-09<\/lastmod>/);
    const people = await (await sitemapPart(env, 'people')).text();
    assert.match(people, /allowed-profile/); assert.doesNotMatch(people, /ungated-profile|private-profile/);
    const taxonomy = await (await sitemapPart(env, 'taxonomy')).text();
    assert.match(taxonomy, /allowed-genre/); assert.doesNotMatch(taxonomy, /private-genre|hidden-genre|language\/zz/);
    assert.ok(await sitemapCount(db, 'pages') > 0);
    assert.match(await (await sitemapPart(env, 'pages')).text(), /\/about\//);
    const schema = titleSchema(await loadTitlePage(db, 'allowed-title', 'movie'), env.SITE_URL);
    assert.equal(schema[0]['@type'], 'Movie'); assert.equal(schema[0].duration, 'PT108M');
    assert.doesNotMatch(schemaJson(schema), /aggregateRating|"Review"|<\/script>/);
    assert.equal('duration' in titleSchema(await loadTitlePage(db, 'allowed-series', 'tv'), env.SITE_URL)[0], false);
    assert.equal(personSchema(await loadPersonPage(db, 'allowed-profile'), env.SITE_URL)[0]['@type'], 'Person');
    assert.equal(seasonSchema(await loadSeasonPage(db, 'allowed-series', '1'), env.SITE_URL)[0]['@type'], 'TVSeason');
    assert.equal(episodeSchema(await loadEpisodePage(db, 'allowed-series', '1', '1'), env.SITE_URL)[0]['@type'], 'TVEpisode');
    const trailer = trailerSchema(await loadTrailerPage(db, 'allowed-title'), env.SITE_URL)[0];
    assert.equal(trailer['@type'], 'VideoObject'); assert.equal('uploadDate' in trailer, false);
    await local.db.batch([{ sql: "WITH RECURSIVE n(x) AS(SELECT 100 UNION ALL SELECT x+1 FROM n WHERE x<10100) INSERT INTO titles(id,type,slug,title,quality_gate) SELECT x,'movie','bulk-'||x,'Bulk '||x,1 FROM n" }]);
    assert.equal(await sitemapCount(db, 'titles'), 10003);
    const first = await (await sitemapPart(env, 'titles', '1')).text(), second = await (await sitemapPart(env, 'titles', '2')).text();
    assert.equal((first.match(/<url>/g) || []).length, 10000); assert.equal((second.match(/<url>/g) || []).length, 3);
    assert.match(await (await sitemapIndex(env)).text(), /sitemap-titles-2\.xml/);
    assert.equal((await sitemapPart(env, 'titles', '3')).status, 404);
    assert.equal((await sitemapPart(env, 'titles', '01')).status, 404);
    await local.db.batch([{ sql: "INSERT INTO config(key,value) VALUES('dev:fixture_import','1')" }]);
    assert.doesNotMatch(await (await sitemapPart(env, 'titles')).text(), /<url>/);
    assert.doesNotMatch(await (await sitemapIndex(env)).text(), /<loc>/);
    assert.doesNotMatch(await (await sitemapPart({ ...env, DEPLOYMENT_ENV: 'preview' }, 'titles')).text(), /<url>/);
    const unavailable = { prepare() { throw new Error('private database failure'); } } as unknown as D1Database;
    assert.equal((await sitemapIndex({ ...env, DB: unavailable })).status, 503);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
