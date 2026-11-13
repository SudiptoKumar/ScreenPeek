import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { ingestPostback } from '../src/lib/tracking/postback.ts';
import { expandMacros, retryOutgoingPostbacks, templateForNetwork, testFireOutgoing } from '../src/lib/tracking/outgoing.ts';

// Gate G23 — outgoing postbacks (F23, docs/06), against a fixture server.
const hits: Array<{ path: string; query: string }> = [];
let server: Server;
let port = 0;

test.before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://fixture');
    hits.push({ path: url.pathname, query: url.search.slice(1) });
    if (url.pathname === '/fail') { response.writeHead(500); response.end('no'); return; }
    if (url.pathname === '/slow') { setTimeout(() => { response.writeHead(200); response.end('ok'); }, 2500); return; }
    response.writeHead(200); response.end('ok');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  port = (server.address() as { port: number }).port;
});
test.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });

async function outgoingEnv(templatePath: string) {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-out-'));
  const local = await localBindings(state);
  await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort())
    await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
  const template = `http://127.0.0.1:${port}${templatePath}?cid={click_id}&ev={event}&pay={payout}&cur={currency}&tx={txid}&s1={sub1}&cc={country}&dev={device}`;
  await local.db.batch([
    { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
    { sql: `UPDATE config SET value='${JSON.stringify({ testnet: { postback_url: template } }).replace(/'/g, "''")}' WHERE key='tracking_networks'` },
    { sql: "INSERT INTO tr_clicks(click_id,ts,slug,country,device_type,visitor_id,session_id,sub1,dest_host) VALUES('click-out-1',datetime('now'),'smartlink-main','US','mobile','v1','s1','promo-a','example.com')" },
  ]);
  const env = { DB: local.database, TRACKING_PB_SECRET_TESTNET: 'topsecret' } as { DB: D1Database } & Record<string, unknown>;
  return { state, local, env };
}

const fire = (env: { DB: D1Database } & Record<string, unknown>) => ingestPostback(env, 'testnet',
  new URLSearchParams({ click_id: 'click-out-1', event: 'purchase', payout: '12.50', currency: 'USD', txid: 'TX-OUT-1', status: 'approved', key: 'topsecret' }));

const until = async (check: () => Promise<boolean>, timeoutMs = 6000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await check()) return true; await new Promise(done => setTimeout(done, 100)); }
  return false;
};

test('G23 macro units: expansion encodes values; per-link template wins', () => {
  assert.equal(
    expandMacros('https://x.test/pb?cid={click_id}&pay={payout}', { click_id: 'a b', event: 'e', payout: '1.00', currency: 'USD', txid: 't', sub1: '', country: 'US', device: 'mobile' }),
    'https://x.test/pb?cid=a%20b&pay=1.00');
  const json = JSON.stringify({ net: { postback_url: 'https://x.test/base', postback_url_by_slug: { special: 'https://x.test/special' } } });
  assert.equal(templateForNetwork(json, 'net', 'special'), 'https://x.test/special');
  assert.equal(templateForNetwork(json, 'net', 'other'), 'https://x.test/base');
  assert.equal(templateForNetwork(json, 'missing', 'other'), '');
  assert.equal(templateForNetwork('{bad json', 'net', 'other'), '');
});

test('G23.1 + G23.4 stored conversion fires with every macro substituted; the log keeps host+path only', { timeout: 60_000 }, async () => {
  const { state, local, env } = await outgoingEnv('/ok');
  try {
    hits.length = 0;
    const outcome = await fire(env);
    assert.equal(outcome.result, 'matched');
    assert.ok(await until(async () => hits.some(hit => hit.path === '/ok')), 'fixture server received the outgoing fire');
    const received = new URLSearchParams(hits.find(hit => hit.path === '/ok')!.query);
    assert.equal(received.get('cid'), 'click-out-1');
    assert.equal(received.get('ev'), 'purchase');
    assert.equal(received.get('pay'), '12.50');
    assert.equal(received.get('cur'), 'USD');
    assert.equal(received.get('tx'), 'TX-OUT-1');
    assert.equal(received.get('s1'), 'promo-a');
    assert.equal(received.get('cc'), 'US');
    assert.equal(received.get('dev'), 'mobile');
    assert.ok(await until(async () => (await local.db.query<{ status: string }>('SELECT status FROM tr_postbacks_out'))[0]?.status === 'sent'));
    const rows = await local.db.query<{ url_host: string; attempts: number; http_status: number }>('SELECT url_host, attempts, http_status FROM tr_postbacks_out');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url_host, `127.0.0.1:${port}/ok`); // host + path only
    assert.ok(!rows[0].url_host.includes('click-out-1') && !rows[0].url_host.includes('?'));
    assert.equal(rows[0].attempts, 1);
    assert.equal(rows[0].http_status, 200);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G23.2 the incoming postback response is never delayed by the outgoing fire', { timeout: 60_000 }, async () => {
  const { state, local, env } = await outgoingEnv('/slow');
  try {
    const start = Date.now();
    const outcome = await fire(env);
    const elapsed = Date.now() - start;
    assert.equal(outcome.result, 'matched');
    assert.ok(elapsed < 1500, `incoming postback took ${elapsed}ms while the outgoing endpoint needs 2500ms`);
    // Let the background fire land so nothing dangles past the test.
    assert.ok(await until(async () => (await local.db.query<{ status: string }>('SELECT status FROM tr_postbacks_out'))[0]?.status === 'sent', 8000));
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G23.3 a failing endpoint retries on schedule and lands failed after the last retry', { timeout: 60_000 }, async () => {
  const { state, local, env } = await outgoingEnv('/fail');
  try {
    hits.length = 0;
    await fire(env);
    // The background first fire lands attempt 1; wait for it so the
    // retry driving below starts from a settled row.
    assert.ok(await until(async () => (await local.db.query<{ attempts: number }>('SELECT attempts FROM tr_postbacks_out'))[0]?.attempts === 1));
    // Drive the schedule with a far-future clock until the row settles.
    for (let round = 0; round < 10; round++) {
      const row = (await local.db.query<{ status: string; attempts: number }>('SELECT status, attempts FROM tr_postbacks_out'))[0];
      if (row.status === 'failed') break;
      await retryOutgoingPostbacks({ DB: local.database }, new Date(Date.now() + 2 * 60 * 60 * 1000));
      await new Promise(done => setTimeout(done, 120));
    }
    const row = (await local.db.query<{ status: string; attempts: number; http_status: number }>('SELECT status, attempts, http_status FROM tr_postbacks_out'))[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 4); // first fire + 3 retries (1m, 10m, 1h)
    assert.equal(row.http_status, 500);
    assert.equal(hits.filter(hit => hit.path === '/fail').length, 4);
    // A retry run long before the next slot is due fires nothing.
    const fresh = await outgoingEnv('/fail');
    try {
      await fire(fresh.env);
      assert.ok(await until(async () => (await fresh.local.db.query<{ attempts: number }>('SELECT attempts FROM tr_postbacks_out'))[0]?.attempts === 1));
      const early = await retryOutgoingPostbacks({ DB: fresh.local.database }, new Date(Date.now() + 30 * 1000));
      assert.equal(early.attempted, 0); // 30s < the 1-minute first retry slot
    } finally { await fresh.local.dispose(); await rm(fresh.state, { recursive: true, force: true }); }
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G23.5 test-fire sends a marked test payload and creates nothing', { timeout: 60_000 }, async () => {
  const { state, local, env } = await outgoingEnv('/ok');
  try {
    hits.length = 0;
    const result = await testFireOutgoing(`http://127.0.0.1:${port}/ok?cid={click_id}&tx={txid}`);
    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);
    const received = new URLSearchParams(hits.find(hit => hit.path === '/ok')!.query);
    assert.equal(received.get('cid'), 'TEST-CLICK');
    assert.equal(received.get('tx'), 'TEST-TX');
    assert.equal((await local.db.query('SELECT * FROM tr_conversions')).length, 0);
    assert.equal((await local.db.query('SELECT * FROM tr_postbacks_out')).length, 0);
    void env;
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
