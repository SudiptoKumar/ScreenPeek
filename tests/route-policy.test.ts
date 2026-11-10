import test from 'node:test';
import assert from 'node:assert/strict';
import { redirectTarget } from '../src/lib/route-policy.ts';
import { testWorker } from './helpers/worker.ts';
test('redirect targets stay on the owned origin and exclude privileged endpoints', () => {
  assert.equal(redirectTarget('/movies/', 'https://site.test'), '/movies/');
  for (const target of ['https://evil.test/', '//evil.test/', '/admin/', '/api/search/', '/go/slug/', '/bad\\path']) assert.equal(redirectTarget(target, 'https://site.test'), null);
});
test('actual Worker honours redirect before rendering, returns 410, and batches bounded 404 paths', async () => {
  const worker = await testWorker({ ADS_ENABLED: '0' }, 8797);
  try {
    await worker.local.db.batch([{ sql: "INSERT INTO redirects(from_path,to_target) VALUES('/old-title/','/movies/')" }, { sql: "UPDATE titles SET deleted=1 WHERE id=-10001 AND type='movie'" }]);
    const moved = await fetch(worker.base + '/old-title/', { redirect: 'manual' });
    assert.equal(moved.status, 301); assert.equal(moved.headers.get('Location'), '/movies/');
    const gone = await fetch(worker.base + '/movie/sample-the-quiet-atlas-1-2022/'); assert.equal(gone.status, 410);
    const missing = await fetch(worker.base + '/missing-policy-title/'); assert.equal(missing.status, 404); await missing.body?.cancel();
    const deadline = Date.now() + 12000; let logged = false;
    while (Date.now() < deadline) {
      const rows = await worker.local.db.query("SELECT count FROM notfound_log WHERE path='/missing-policy-title/'");
      if (Number(rows[0]?.count) >= 1) { logged = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(logged, true);
  } finally { await worker.dispose(); }
});
