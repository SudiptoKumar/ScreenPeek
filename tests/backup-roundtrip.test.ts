import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { decodeBackup } from '../sync/backup.ts';
import { applyLocalSql, localBindings } from '../sync/local.ts';
test('actual Wrangler archive restores into isolated D1 with the derived FTS index rebuilt', async () => {
  const files = (await readdir('.cache/backups')).filter(name => name.endsWith('.json.gz')).sort().reverse(); assert.ok(files.length);
  const value = decodeBackup(await readFile(resolve('.cache/backups',files[0])));
  const state = await mkdtemp(resolve(tmpdir(),'screenpeek-restore-check-')), target = await localBindings(state);
  try {
    await applyLocalSql(target.database,value.sql);
    const titles = Number((await target.db.query('SELECT COUNT(*) n FROM titles'))[0].n);
    assert.ok(titles >= 50); assert.equal(Number((await target.db.query('SELECT COUNT(*) n FROM titles_fts'))[0].n),titles);
    assert.ok((await target.db.query("SELECT title FROM titles_fts WHERE titles_fts MATCH 'Sample' LIMIT 1")).length);
    for (const row of value.config) assert.equal((await target.db.query('SELECT value FROM config WHERE key=?',[String(row.key)]))[0]?.value,row.value);
  } finally { await target.dispose(); await rm(state,{ recursive:true,force:true }); }
});
