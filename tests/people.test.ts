import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyLocalSql, localBindings, applyLocalMigrations } from '../sync/local.ts';
import { createSeedSql } from '../db/seed.mjs';
import { creditLabel, loadPersonPage } from '../src/lib/people.ts';

test('people and filmography queries use actual D1 with role grouping, type-safe joins and public visibility', { timeout: 15_000 }, async context => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-people-'));
  const local = await localBindings(state);
  const db = local.database as unknown as D1Database;
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalSql(local.database, createSeedSql());
    await applyLocalMigrations(local.database);
    await local.db.batch([
      { sql: "INSERT INTO people(id,slug,name,bio,profile_r2,updated_at) VALUES(-29001,'sample-filmography-person','Sample Filmography Person','Synthetic biography for local filmography testing.','profile/sample-person.webp','2026-11-09T00:00:00Z'),(-29002,'sample-shared-id-person','Sample Shared ID Person','Synthetic shared-ID fixture.',NULL,'2026-11-09T00:00:00Z'),(-29003,'sample-empty-person','Sample Empty Person',NULL,NULL,'2026-11-09T00:00:00Z')" },
      { sql: "INSERT INTO credits(title_id,title_type,person_id,role,character,ord) SELECT id,type,-29001,'cast','Sample Lead',0 FROM titles WHERE type='movie'" },
      { sql: "INSERT INTO credits(title_id,title_type,person_id,role,ord) VALUES(-10030,'movie',-29001,'director',1),(-10030,'movie',-29001,'creator',2)" },
      { sql: "INSERT INTO titles(id,type,slug,title,popularity) VALUES(500,'movie','sample-shared-id-movie','Sample Shared ID Movie',40),(500,'tv','sample-shared-id-series','Sample Shared ID Series',60)" },
      { sql: "INSERT INTO credits(title_id,title_type,person_id,role,character,ord) VALUES(500,'movie',-29002,'cast','Sample Character',0)" },
    ]);

    await context.test('biography/profile load and multiple credit roles produce one card per title across 24+6 pages', async () => {
      const first = await loadPersonPage(db, 'sample-filmography-person');
      const second = await loadPersonPage(db, 'sample-filmography-person', '2');
      assert.equal(first.status, 200); assert.equal(first.failed, false);
      assert.equal(first.person?.name, 'Sample Filmography Person');
      assert.equal(first.person?.bio, 'Synthetic biography for local filmography testing.');
      assert.equal(first.person?.profile_r2, 'profile/sample-person.webp');
      assert.equal(first.total, 30); assert.equal(first.pages, 2); assert.equal(first.titles.length, 24);
      assert.equal(second.status, 200); assert.equal(second.page, 2); assert.equal(second.titles.length, 6);
      const combined = [...first.titles, ...second.titles];
      assert.equal(new Set(combined.map(title => `${title.type}:${title.id}`)).size, 30);
      assert.ok(combined.every(title => title.type === 'movie'));
      const multipleRoles = first.titles.find(title => title.id === -10030);
      assert.ok(multipleRoles);
      assert.equal(creditLabel(multipleRoles), 'Director · Creator · as Sample Lead');
      assert.equal(first.sample, true); assert.equal(first.noindex, true); assert.equal(first.cacheControl, 'no-store');
      const outside = await loadPersonPage(db, 'sample-filmography-person', '3');
      assert.equal(outside.status, 404); assert.deepEqual(outside.titles, []);
      assert.equal(outside.noindex, true); assert.equal(outside.cacheControl, 'no-store');
      for (const value of ['not-a-page', '0', '-1', '1.5', 'Infinity', '9007199254740992']) {
        const page = await loadPersonPage(db, 'sample-filmography-person', value);
        assert.equal(page.page, 1); assert.equal(page.status, 200);
      }
    });

    await context.test('source IDs shared by movie and TV remain distinct and join only the matching credit type', async () => {
      const movieOnly = await loadPersonPage(db, 'sample-shared-id-person');
      assert.equal(movieOnly.total, 1);
      assert.deepEqual(movieOnly.titles.map(title => `${title.type}:${title.id}`), ['movie:500']);
      await local.db.query("INSERT INTO credits(title_id,title_type,person_id,role,ord) VALUES(500,'tv',-29002,'creator',0)");
      const both = await loadPersonPage(db, 'sample-shared-id-person');
      assert.equal(both.total, 2);
      assert.deepEqual(both.titles.map(title => `${title.type}:${title.id}`), ['tv:500', 'movie:500']);
      assert.equal(creditLabel(both.titles[0]), 'Creator');
      assert.equal(creditLabel(both.titles[1]), 'as Sample Character');
    });

    await context.test('hidden, permanently deleted and trashed titles are excluded before pagination', async () => {
      await local.db.batch([
        { sql: 'UPDATE titles SET hidden=1 WHERE id=-10028' },
        { sql: 'UPDATE titles SET deleted=1 WHERE id=-10029' },
        { sql: "UPDATE titles SET deleted_at='2026-11-09T00:00:00Z' WHERE id=-10030" },
      ]);
      const first = await loadPersonPage(db, 'sample-filmography-person');
      const second = await loadPersonPage(db, 'sample-filmography-person', '2');
      assert.equal(first.total, 27); assert.equal(first.titles.length, 24); assert.equal(second.titles.length, 3);
      assert.ok([...first.titles, ...second.titles].every(title => ![-10028, -10029, -10030].includes(title.id)));
    });

    await context.test('missing and deleted people return uncached noindex 404 without a filmography', async () => {
      await local.db.query("UPDATE people SET deleted_at='2026-11-09T00:00:00Z' WHERE id=-29002");
      for (const slug of ['missing-person', "' OR 1=1 --", 'sample-shared-id-person']) {
        const page = await loadPersonPage(db, slug);
        assert.equal(page.status, 404); assert.equal(page.noindex, true); assert.equal(page.cacheControl, 'no-store');
        assert.deepEqual(page.titles, []); assert.equal(page.total, 0);
      }
    });

    await context.test('live mode includes only gated visible titles and keeps an empty filmography noindex', async () => {
      await local.db.batch([
        { sql: "DELETE FROM config WHERE key IN ('dev:sample_data','dev:fixture_import')" },
        { sql: 'UPDATE titles SET quality_gate=1 WHERE id IN (-10001,-10002,-10028,-10029,-10030)' },
      ]);
      const live = await loadPersonPage(db, 'sample-filmography-person');
      assert.equal(live.status, 200); assert.equal(live.sample, false); assert.equal(live.noindex, false);
      assert.equal(live.total, 2);
      assert.deepEqual(live.titles.map(title => title.id), [-10002, -10001]);
      assert.equal(live.cacheControl, 'public, s-maxage=86400, stale-while-revalidate=604800');
      const empty = await loadPersonPage(db, 'sample-empty-person');
      assert.equal(empty.status, 200); assert.equal(empty.total, 0); assert.deepEqual(empty.titles, []);
      assert.equal(empty.person?.bio, null); assert.equal(empty.person?.profile_r2, null);
      assert.equal(empty.noindex, true);
      assert.equal(empty.cacheControl, 'public, s-maxage=86400, stale-while-revalidate=604800');
    });

    await context.test('filmography query failure is an explicit uncached noindex 503', async () => {
      const failing = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare') return (sql: string) => {
            if (sql.includes('GROUP_CONCAT')) throw new Error('Simulated filmography query failure');
            return target.prepare(sql);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const page = await loadPersonPage(failing, 'sample-filmography-person');
      assert.equal(page.status, 503); assert.equal(page.failed, true);
      assert.equal(page.noindex, true); assert.equal(page.cacheControl, 'no-store');
      assert.deepEqual(page.titles, []);
    });
  } finally {
    await local.dispose();
    await rm(state, { recursive: true, force: true });
  }
});

test('credit labels distinguish cast, characters, directors and creators without inventing roles', () => {
  assert.equal(creditLabel({ credit_roles: null, characters: null }), '');
  assert.equal(creditLabel({ credit_roles: 'cast', characters: null }), 'Cast');
  assert.equal(creditLabel({ credit_roles: 'director', characters: 'Unused Character' }), 'Director');
  assert.equal(creditLabel({ credit_roles: 'creator,cast,director', characters: 'Sample Hero' }), 'Director · Creator · as Sample Hero');
});
