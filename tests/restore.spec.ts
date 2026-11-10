import { test,expect } from '@playwright/test';
import { accessFixture } from './helpers/access.ts';
import { testWorker } from './helpers/worker.ts';
import { exportAdminBackup } from '../src/lib/admin/data.ts';
test('Owner uploads a configuration export and gets a private pre-restore snapshot',async({browser})=>{
 const access=accessFixture(),worker=await testWorker({CF_ACCESS_TEAM_DOMAIN:access.team,CF_ACCESS_AUD:access.aud,ADS_ENABLED:'0'},8790,{[access.certUrl]:{body:{keys:[access.jwk]}}});
 const context=await browser.newContext({extraHTTPHeaders:access.headers('owner@example.test')}),page=await context.newPage();
 try{
  await worker.local.db.batch([{sql:"INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner')"}]);
  const value=await exportAdminBackup({DB:worker.local.database as unknown as D1Database,CONFIG:worker.local.config as unknown as KVNamespace},{email:'owner@example.test',role:'owner',modules:{}});
  (value.data.config as Array<{key:string;value:string}>).find(row=>row.key==='site_name')!.value='Restored ScreenPeek';
  await page.goto(worker.base+'/admin/backup/');await page.getByLabel('Configuration export',{exact:true}).setInputFiles({name:'config.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
  await page.getByLabel('Type RESTORE to replace configuration').fill('RESTORE');await page.getByRole('button',{name:'Restore configuration',exact:true}).click();
  await expect(page.locator('.notice[role="status"]')).toContainText('Saved');
  expect((await worker.local.db.query("SELECT value FROM config WHERE key='site_name'"))[0].value).toBe('Restored ScreenPeek');
  const objects=await worker.local.backups.list({prefix:'backups/'});expect(objects.objects).toHaveLength(1);
  const download=await context.request.get(worker.base+'/admin/backup/?snapshot='+encodeURIComponent(objects.objects[0].key));expect(download.status()).toBe(200);expect(download.headers()['cache-control']).toContain('private, no-store');
 }finally{await context.close();await worker.dispose()}
});
