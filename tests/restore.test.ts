import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings,applyLocalSql,applyLocalMigrations } from '../sync/local.ts';
import { createSeedSql } from '../db/seed.mjs';
import { exportAdminBackup } from '../src/lib/admin/data.ts';
import { restoreConfiguration } from '../src/lib/admin/restore.ts';
import { deliverChange } from '../src/lib/admin/changes.ts';
import type { AdminIdentity } from '../src/lib/admin/access.ts';
test('Owner-only config restore creates a private pre-snapshot and resumes bounded KV delivery; storage failure leaves D1 untouched',async()=>{
 const state=await mkdtemp(resolve(tmpdir(),'screenpeek-config-restore-')),local=await localBindings(state);
 const env={DB:local.database as unknown as D1Database,CONFIG:local.config as unknown as KVNamespace,BACKUPS:local.backups as unknown as R2Bucket},owner:AdminIdentity={email:'owner@example.test',role:'owner',modules:{}};
 try{
  await applyLocalSql(local.database,await readFile('db/schema.sql','utf8'));await applyLocalMigrations(local.database);await applyLocalSql(local.database,createSeedSql());
  await local.db.batch([{sql:"UPDATE config SET value='Before restore' WHERE key='site_name'"}]);
  const snapshot=await exportAdminBackup(env,owner);const target=structuredClone(snapshot);const settings=target.data.config as Array<{key:string;value:string}>;settings.find(row=>row.key==='site_name')!.value='Restored name';
  const form=new URLSearchParams({confirm_restore:'RESTORE',backup_json:JSON.stringify(target)});
  await assert.rejects(restoreConfiguration(env,{...owner,role:'editor'},form),/role/);
  await assert.rejects(restoreConfiguration({...env,BACKUPS:{async put(){throw new Error('private storage failed')}} as unknown as R2Bucket},owner,form),/private storage failed/);
  assert.equal((await local.db.query("SELECT value FROM config WHERE key='site_name'"))[0].value,'Before restore');
  await restoreConfiguration(env,owner,form);
  assert.equal((await local.db.query("SELECT value FROM config WHERE key='site_name'"))[0].value,'Restored name');
  const objects=await local.backups.list({prefix:'backups/'});assert.equal(objects.objects.length,1);assert.match(objects.objects[0].key,/pre-restore/);
  const object=await local.backups.get(objects.objects[0].key);assert.equal(object!.httpMetadata?.cacheControl,'private, no-store');
  const previous=JSON.parse(gunzipSync(Buffer.from(await object!.arrayBuffer())).toString('utf8'));assert.equal(previous.data.config.find((row:{key:string})=>row.key==='site_name').value,'Before restore');
  const delivery=Number((await local.db.query('SELECT id FROM admin_delivery ORDER BY id DESC LIMIT 1'))[0].id);
  for(let step=0;step<10;step++){const row=(await local.db.query('SELECT kv_done FROM admin_delivery WHERE id=?',[delivery]))[0];if(row.kv_done)break;await deliverChange(env,delivery);}
  assert.equal(await env.CONFIG.get('config:site_name'),'Restored name');
 }finally{await local.dispose();await rm(state,{recursive:true,force:true});}
});
