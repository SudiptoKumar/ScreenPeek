import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBackup, decodeBackup, saveBackup, PrivateBackupStore } from '../sync/backup.ts';
test('full backup preserves D1/config in gzip and retention deletes only after upload, keeping 14', async () => {
  const sql = 'CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1);'; const config = [{ key: 'ads_enabled', value: '0' }];
  const decoded = decodeBackup(encodeBackup(sql,config)); assert.equal(decoded.sql,sql); assert.deepEqual(decoded.config,config);
  const keys = Array.from({ length: 17 }, (_, index) => `backups/2026-11-${String(index+1).padStart(2,'0')}T00-00-00.000Z-old.json.gz`); const events: string[] = [];
  const result = await saveBackup({ async put(key,bytes) { events.push('put'); keys.push(key); assert.equal(decodeBackup(bytes).sql,sql); }, async list() { events.push('list'); return keys; }, async delete(key) { events.push('delete'); keys.splice(keys.indexOf(key),1); } },sql,config,new Date('2026-11-20T00:00:00Z'));
  assert.equal(keys.length,14); assert.equal(result.retained,14); assert.deepEqual(events.slice(0,2),['put','list']);
  let listed = false;
  await assert.rejects(saveBackup({ async put() { throw new Error('storage failed'); }, async list() { listed=true; return []; }, async delete() {} },sql,config), /storage failed/); assert.equal(listed,false);
});
test('private backup transport rejects public poster bucket and signs only a fixed private S3 host', async () => {
  const input = { account: 'a'.repeat(32), bucket: 'private-backups', privateConfirmed: true, accessKey: 'fixture-access', secretKey: 'fixture-secret' };
  assert.throws(() => new PrivateBackupStore({ ...input, bucket: 'posters' }), /separate private/);
  assert.throws(() => new PrivateBackupStore({ ...input, privateConfirmed: false }), /separate private/);
  const methods: string[] = [];
  const store = new PrivateBackupStore({ ...input, fetch: async request => {
    assert.ok(request instanceof Request); const value = request as Request;
    assert.equal(new URL(value.url).hostname, `${input.account}.r2.cloudflarestorage.com`); assert.ok(value.headers.get('Authorization')?.startsWith('AWS4-HMAC-SHA256')); methods.push(value.method);
    if (value.method === 'PUT') { assert.equal(value.headers.get('cache-control'),'private, no-store'); return new Response(null); }
    if (value.method === 'GET') return new Response('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>backups/2026-11-09T00-00-00.000Z-old.json.gz</Key></Contents></ListBucketResult>');
    return new Response(null);
  } });
  const key = 'backups/2026-11-09T00-00-00.000Z-new.json.gz'; await store.put(key,encodeBackup('SELECT 1;',[])); assert.equal((await store.list()).length,1); await store.delete(key);
  assert.deepEqual(methods,['PUT','GET','DELETE']); await assert.rejects(store.delete('poster/private.webp'), /Unsafe/);
});
