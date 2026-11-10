import { test,expect } from '@playwright/test';
import { accessFixture } from './helpers/access.ts';
import { testWorker } from './helpers/worker.ts';
test('owner list UI applies multi-row changes, exports CSV, confirms referenced Trash and restores it',async({browser})=>{
 const access=accessFixture(),worker=await testWorker({CF_ACCESS_TEAM_DOMAIN:access.team,CF_ACCESS_AUD:access.aud,ADS_ENABLED:'0'},8790,{[access.certUrl]:{body:{keys:[access.jwk]}}});
 const context=await browser.newContext({extraHTTPHeaders:access.headers('owner@example.test')}),page=await context.newPage();
 try{
  await worker.local.db.batch([{sql:"INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner'),('ads@example.test','ads')"},{sql:"INSERT OR IGNORE INTO collections(slug,name) VALUES('ref','Reference')"},{sql:"INSERT INTO collection_titles(collection_slug,title_id,title_type,source) VALUES('ref',-10003,'movie','manual')"}]);
  await page.goto(worker.base+'/admin/content/');const list=page.getByRole('region',{name:'Record list controls',exact:true});
  await list.locator('input[name="u_keys"]').nth(0).check();await list.locator('input[name="u_keys"]').nth(1).check();
  await list.getByLabel('Bulk field').selectOption('hidden');await list.getByLabel('Bulk value').fill('1');await list.getByRole('button',{name:'Apply bulk value',exact:true}).click();
  await expect(page.locator('.notice[role="status"]')).toContainText('Saved');
  const exportLink=await page.getByRole('link',{name:'Export filtered CSV (Owner/Editor)',exact:true}).getAttribute('href');const csv=await context.request.get(worker.base+exportLink);expect(csv.status()).toBe(200);expect(csv.headers()['content-type']).toContain('text/csv');
  const query=new URLSearchParams({list:'titles',u_edit:JSON.stringify([-10003,'movie'])});await page.goto(worker.base+'/admin/content/?'+query);
  await expect(page.getByText('Used in 1 places.',{exact:false})).toBeVisible();
  const trashList=page.getByRole('region',{name:'Record list controls',exact:true});await trashList.locator('input[name="u_keys"]').filter({visible:true}).first().uncheck();
  await trashList.locator('input[name="u_keys"]').evaluateAll((nodes,key)=>{for(const node of nodes)if((node as HTMLInputElement).value===key)(node as HTMLInputElement).click()},JSON.stringify([-10003,'movie']));
  await trashList.locator('input[name="confirm_used"]').check();await trashList.getByRole('button',{name:'Move selected to Trash',exact:true}).click();
  expect((await worker.local.db.query("SELECT deleted_at FROM titles WHERE id=-10003 AND type='movie'"))[0].deleted_at).toBeTruthy();
  await page.goto(worker.base+'/admin/changes/?list=admin_trash');await page.getByRole('button',{name:'Restore item',exact:true}).click();
  expect((await worker.local.db.query("SELECT deleted_at FROM titles WHERE id=-10003 AND type='movie'"))[0].deleted_at).toBeNull();
  const ads=await browser.newContext({extraHTTPHeaders:access.headers('ads@example.test')});try{expect((await ads.request.get(worker.base+'/admin/links/?ucsv=1')).status()).toBe(403)}finally{await ads.close()}
 }finally{await context.close();await worker.dispose()}
});
