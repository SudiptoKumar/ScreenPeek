/** Local-only owned-image fixtures. No TMDb, cloud account or public image host. */
import { createServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import sharp from 'sharp';
import { localBindings } from '../../sync/local.ts';
import { renderStatic, snapshotCatalogue } from '../../scripts/static-build.ts';
import { testWorker } from './worker.ts';

async function image(width: number, height: number, target: number) {
  const raw = Buffer.alloc(width * height * 3); let seed = 73;
  for (let index = 0; index < raw.length; index++) { seed = (1664525 * seed + 1013904223) >>> 0; raw[index] = (seed >>> 24); }
  // Valid textured WebPs, not empty image placeholders or padding counted as art.
  let selected: Buffer | undefined;
  for (let quality = 1; quality <= 90; quality += 2) {
    const bytes = await sharp(raw, { raw: { width, height, channels: 3 } }).blur(0.8).webp({ quality, effort: 1 }).toBuffer();
    selected = bytes; if (bytes.length >= target) break;
  }
  if (!selected || selected.length < target || selected.length > target * 1.4) throw new Error(`Image fixture ${width}x${height} missed ${target} byte range (${selected?.length}).`);
  return selected;
}
export async function performanceFixture(bloat = false) {
  const root = await mkdtemp(resolve(tmpdir(), 'screenpeek-perf-'));
  let worker: Awaited<ReturnType<typeof testWorker>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const keyPath = resolve(root, 'key.pem'), certPath = resolve(root, 'cert.pem');
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
    const cert = await readFile(certPath), key = await readFile(keyPath);
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const [card, detail, profile, gallery, logo] = await Promise.all([image(185, 278, 10_000), image(500, 750, 40_000), image(185, 185, 4_000), image(300, 169, 8_000), image(64, 64, 1_000)]);
    server = createServer({ key, cert }, (request, response) => {
      const pathname = new URL(request.url || '/', 'https://localhost').pathname;
      const bytes = pathname.startsWith('/profiles/') ? profile : pathname.startsWith('/gallery/') ? gallery : pathname.startsWith('/logos/') ? logo : /_w500\.webp$/.test(pathname) ? detail : card;
      response.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'Timing-Allow-Origin': '*' }); response.end(bytes);
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Image fixture did not bind');
    const images = `https://localhost:${address.port}`;
    const client = resolve(root, 'client');
    await cp('dist/client', client, { recursive: true, filter: path => !path.endsWith('.html') });
    worker = await testWorker({ ADS_ENABLED: '0', DEPLOYMENT_ENV: 'preview', R2_PUBLIC_BASE: images }, 8796, {}, { assetsFirst: true, client, beforeStart: async local => {
      await local.db.batch([
        { sql: "UPDATE titles SET poster_r2='posters/'||type||'-'||id||'_w185.webp',poster_color='#294253'" },
        { sql: "UPDATE titles SET quality_gate=1 WHERE id=-10001 AND type='movie'" },
        { sql: "UPDATE people SET profile_r2='profiles/'||id||'_w185.webp'" },
        { sql: "UPDATE providers SET logo_r2='logos/'||provider_id||'.webp'" },
        { sql: "UPDATE titles SET gallery_r2=? WHERE id=-10001 AND type='movie'", params: [JSON.stringify(Array.from({ length: 6 }, (_, index) => `gallery/scene-${index}.webp`))] },
      ]);
      if (bloat) {
        const { randomBytes } = await import('node:crypto');
        await local.db.batch([{ sql: "UPDATE titles SET overview=? WHERE id=-10001 AND type='movie'", params: [randomBytes(180_000).toString('base64')] }]);
      }
      const snapshotState = resolve(root, 'snapshot'), snapshot = await localBindings(snapshotState);
      try {
        const inventory = await snapshotCatalogue(local.db, snapshot);
        await snapshot.dispose();
        await renderStatic({ state: snapshotState, client, paths: inventory.paths, vars: { ADS_ENABLED: '0', DEPLOYMENT_ENV: 'preview', R2_PUBLIC_BASE: images } });
      } finally { await snapshot.dispose(); }
    } });
    const title = (await worker.local.db.query("SELECT slug FROM titles WHERE id=-10001 AND type='movie'"))[0];
    return { base: worker.base, images, spki, detail: `/movie/${title.slug}/`, watch: `/watch/${title.slug}/`, imageBytes: { card: card.length, detail: detail.length, profile: profile.length, gallery: gallery.length, logo: logo.length },
      async dispose() { await worker?.dispose(); server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) { await worker?.dispose(); server?.closeAllConnections(); server?.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
