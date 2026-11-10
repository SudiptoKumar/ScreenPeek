import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyLocalSql, localBindings } from '../../sync/local.ts';
import { createSeedSql } from '../../db/seed.mjs';

/** Isolated production Worker with actual local bindings and test-only vars. */
export async function testWorker(vars: Record<string, string>, port = 8790, outbound: Record<string, { body: unknown; status?: number }> = {}, options: { assetsFirst?: boolean; client?: string; beforeStart?: (local: Awaited<ReturnType<typeof localBindings>>, state: string) => Promise<void> } = {}) {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-worker-'));
  const local = await localBindings(state);
  let child: ReturnType<typeof spawn> | undefined;
  const dispose = async () => {
    if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed; }
    await local.dispose(); await rm(state, { recursive: true, force: true });
  };
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort()) await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
    await applyLocalSql(local.database, createSeedSql());
    await options.beforeStart?.(local, state);
    let configPath = 'dist/server/wrangler.json';
    {
      // Test-only wrapper intercepts external service responses. Authentication
      // and the production handler are unchanged and must verify real signatures.
      const original = JSON.parse(await readFile(configPath, 'utf8'));
      const fixtureRoot = resolve(state, 'worker');
      await cp('dist/server', fixtureRoot, { recursive: true });
      const main = resolve(fixtureRoot, 'fixture-entry.mjs');
      await writeFile(main, `import worker from './${original.main}';\nconst fixtures=${JSON.stringify(outbound)};\nconst originalFetch=globalThis.fetch;\nglobalThis.fetch=(input,init)=>{const key=typeof input==='string'?input:input instanceof URL?input.href:input.url;const fixture=fixtures[key];return fixture?Promise.resolve(new Response(fixture.status===204?null:JSON.stringify(fixture.body),{status:fixture.status||200,headers:{'Content-Type':'application/json'}})):originalFetch(input,init);};\nexport default { ...worker, async fetch(...args) { const original=await worker.fetch(...args); const response=new Response(original.body,{status:original.status,statusText:original.statusText,headers:original.headers});response.headers.set('X-Test-Worker','invoked');return response; } };\n`);
      configPath = resolve(state, 'worker.json');
      await writeFile(configPath, JSON.stringify({ ...original, main, assets: { ...original.assets, directory: options.client || resolve('dist/server', original.assets.directory), run_worker_first: !options.assetsFirst } }));
    }
    child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', configPath, '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state,
      ...Object.entries(vars).flatMap(([key, value]) => ['--var', `${key}:${value}`]),
    ], { env: { ...process.env, XDG_CONFIG_HOME: resolve('.cache/config'), WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-5000); });
    child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-5000); });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Test Worker exited: ${output}`);
      try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* Startup pending. */ }
      if (Date.now() > deadline) throw new Error(`Test Worker did not start: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { base, local, state, dispose };
  } catch (error) { await dispose(); throw error; }
}
