import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{resolve}from'node:path';
import{localBindings,applyLocalSql,applyLocalMigrations}from'../sync/local.ts';
import{healthReport,setIssueSnooze}from'../src/lib/admin/health.ts';
test('diagnostics detect and clear real local failures, respect roles, flag measured quotas and snooze without pretending fixed',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'screenpeek-health-')),local=await localBindings(root),env={DB:local.database as unknown as D1Database,CONFIG:local.config as unknown as KVNamespace},owner={email:'owner@example.test',role:'owner' as const,modules:{}};
 try{await applyLocalSql(local.database,await readFile('db/schema.sql','utf8'));await applyLocalMigrations(local.database);
 await local.db.batch([{sql:"INSERT INTO titles(id,type,slug,title) VALUES(1,'movie','missing','Missing')"},{sql:"INSERT INTO sync_log(started_at,status) VALUES(datetime('now'),'failed')"},{sql:"INSERT INTO notfound_log(path,count) VALUES('/missing/',3)"},{sql:"INSERT INTO ad_slots(page_type,placement,code) VALUES('home','native','same'),('detail','native','same')"}]);
 await env.CONFIG.put('health:usage',JSON.stringify({source:'cloudflare-graphql',measured_at:new Date().toISOString(),worker_requests:90000,d1_rows_read:4100000}));
 const issues=await healthReport(env,owner);for(const key of ['sync','poster:movie:1','overview:movie:1','404:/missing/','duplicate:home:native','quota:worker_requests','quota:d1_rows_read'])assert.ok(issues.some(row=>row.key===key),key);
 await setIssueSnooze(env,owner,'poster:movie:1');assert.ok((await healthReport(env,owner)).find(row=>row.key==='poster:movie:1')?.snoozed_until);
 await assert.rejects(setIssueSnooze(env,{...owner,role:'viewer'},'sync'),/role/);
 const editor=await healthReport(env,{...owner,role:'editor'});assert.equal(editor.some(row=>row.key.startsWith('duplicate:')||row.key.startsWith('empty:')),false);
 await local.db.batch([{sql:"UPDATE titles SET poster_r2='poster/owned.webp',overview=? WHERE id=1",params:['A'.repeat(100)]},{sql:"UPDATE sync_log SET status='ok'"}]);
 const fixed=await healthReport(env,owner);assert.equal(fixed.some(row=>['sync','poster:movie:1','overview:movie:1'].includes(row.key)),false);
 await env.CONFIG.delete('health:usage');assert.ok((await healthReport(env,owner)).some(row=>row.key==='quota-unavailable'));
 }finally{await local.dispose();await rm(root,{recursive:true,force:true})}
});
