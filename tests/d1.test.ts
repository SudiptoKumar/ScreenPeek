import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { HttpD1 } from '../sync/d1.ts';

const credentials = { accountId: 'a'.repeat(32), databaseId: '11111111-2222-3333-4444-555555555555', token: 'fixture-token-do-not-echo' };
const result = (rows: Record<string, unknown>[] = [], written = 0) => ({ success: true, results: rows, meta: { rows_written: written } });
const response = (results: unknown[]) => Response.json({ success: true, errors: [], result: results });

test('D1 query uses fixed HTTPS endpoint, Bearer auth and separately bound values', async () => {
  const client = new HttpD1({ ...credentials, fetch: async (input, init) => {
    assert.equal(input, `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${credentials.databaseId}/query`);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${credentials.token}`);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), { sql: 'SELECT * FROM titles WHERE title=? AND year>? AND poster_r2 IS ?', params: ["Owner's title", 2020, null] });
    return response([result([{ id: 1, title: "Owner's title" }])]);
  } });
  assert.deepEqual(await client.query('SELECT * FROM titles WHERE title=? AND year>? AND poster_r2 IS ?', ["Owner's title", 2020, null]), [{ id: 1, title: "Owner's title" }]);
  assert.ok(!inspect(client).includes(credentials.token), 'Private token is not exposed through ordinary object inspection');
});

test('D1 batch is one REST batch request, preserves order and sums billed write metadata', async () => {
  let requests = 0;
  const statements = [{ sql: 'INSERT INTO titles(id,type,title,slug) VALUES(?,?,?,?)', params: [1, 'movie', 'Fixture', 'fixture'] }, { sql: 'UPDATE titles SET year=? WHERE id=?', params: [2026, 1] }];
  const client = new HttpD1({ ...credentials, fetch: async (_input, init) => {
    requests++;
    assert.deepEqual(JSON.parse(String(init?.body)), { batch: statements });
    return response([result([], 3), result([], 2)]);
  } });
  assert.deepEqual(await client.batch(statements), { rowsWritten: 5 });
  assert.equal(requests, 1);
  assert.deepEqual(await client.batch([]), { rowsWritten: 0 });
  assert.equal(requests, 1);
});

test('D1 accepts empty query rows and query metadata is optional', async () => {
  const client = new HttpD1({ ...credentials, fetch: async () => response([{ success: true, results: [] }]) });
  assert.deepEqual(await client.query('SELECT * FROM titles WHERE 0'), []);
});

test('D1 failures redact response bodies and transport errors and never automatically retry writes', async () => {
  const failures: Array<() => Promise<Response>> = [
    async () => new Response(credentials.token, { status: 401 }),
    async () => Response.json({ success: false, errors: [{ message: credentials.token }], result: [] }),
    async () => response([{ success: false, error: credentials.token }]),
    async () => { throw new Error(`Network error with ${credentials.token}`); },
    async () => new Response(`not JSON ${credentials.token}`),
    async () => response([{ success: true, results: [], meta: { rows_written: -1 } }]),
    async () => response([{ success: true, results: [] }]),
  ];
  for (const fail of failures) {
    let requests = 0;
    const client = new HttpD1({ ...credentials, fetch: async () => { requests++; return fail(); } });
    await assert.rejects(client.batch([{ sql: 'UPDATE titles SET year=2026' }]), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(credentials.token));
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('D1 refuses incomplete result batches, invalid rows and invalid write metadata', async () => {
  const missing = new HttpD1({ ...credentials, fetch: async () => response([result()]) });
  await assert.rejects(missing.batch([{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }]), /incomplete batch/);
  const badRows = new HttpD1({ ...credentials, fetch: async () => response([{ success: true, results: [null] }]) });
  await assert.rejects(badRows.query('SELECT 1'), /invalid result rows/);
  const badMeta = new HttpD1({ ...credentials, fetch: async () => response([{ success: true, results: [], meta: { rows_written: 1.5 } }]) });
  await assert.rejects(badMeta.batch([{ sql: 'UPDATE titles SET year=2026' }]), /write metadata/);
});

test('D1 validates identifiers, parameters, statement bytes and whole-request size before any request', async () => {
  assert.throws(() => new HttpD1({ ...credentials, accountId: '../other-account' }), /account ID/);
  assert.throws(() => new HttpD1({ ...credentials, databaseId: 'bad-id' }), /UUID/);
  assert.throws(() => new HttpD1({ ...credentials, token: '' }), /CLOUDFLARE_API_TOKEN/);
  assert.throws(() => new HttpD1({ ...credentials, token: 'bad\nheader' }), /CLOUDFLARE_API_TOKEN/);
  let requests = 0;
  const client = new HttpD1({ ...credentials, fetch: async () => { requests++; return response([result()]); } });
  await assert.rejects(client.query(' '), /empty/);
  await assert.rejects(client.query('é'.repeat(50_001)), /100 KB/);
  await assert.rejects(client.query('SELECT ?', Array.from({ length: 101 }, () => 1)), /100 bound parameters/);
  await assert.rejects(client.query('SELECT ?', [NaN]), /finite numbers/);
  await assert.rejects(client.batch([{ sql: 'SELECT ?', params: ['x'.repeat(6 * 1024 * 1024)] }]), /5 MiB/);
  assert.equal(requests, 0);
});
