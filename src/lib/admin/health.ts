import { AdminError,permitted,requirePermission } from './access.ts';
import type { AdminIdentity } from './access.ts';
import type { AdminEnvironment } from './changes.ts';
import { adMap } from '../ads.ts';
export interface HealthIssue { key:string;severity:'error'|'warning'|'info';message:string;fix:string;snoozed_until?:string; }
export async function healthReport(env:AdminEnvironment,actor:AdminIdentity):Promise<HealthIssue[]>{
 requirePermission(actor,'dashboard');const issues:HealthIssue[]=[];
 const latest=await env.DB.prepare('SELECT id,status FROM sync_log ORDER BY id DESC LIMIT 1').first<{id:number;status:string}>();
 if(!latest||['failed','partial'].includes(latest.status))issues.push({key:'sync',severity:latest?(latest.status==='failed'?'error':'warning'):'info',message:latest?`Latest sync is ${latest.status}.`:'No sync recorded.',fix:'/admin/sync/'});
 if(permitted(actor,'titles')&&permitted(actor,'content')){
  const rows=(await env.DB.prepare("SELECT id,type,title,poster_r2,overview FROM titles WHERE hidden=0 AND deleted=0 AND deleted_at IS NULL AND (poster_r2 IS NULL OR trim(poster_r2)='' OR overview IS NULL OR length(trim(overview))<80) ORDER BY id LIMIT 1000").all<{id:number;type:string;title:string;poster_r2:string|null;overview:string|null}>()).results;
  for(const row of rows){const fix='/admin/content/?'+new URLSearchParams({list:'titles',u_edit:JSON.stringify([row.id,row.type])});if(!row.poster_r2?.trim())issues.push({key:`poster:${row.type}:${row.id}`,severity:'warning',message:`Missing poster: ${row.title}`,fix});if(!row.overview||row.overview.trim().length<80)issues.push({key:`overview:${row.type}:${row.id}`,severity:'warning',message:`Missing or short overview: ${row.title}`,fix});}
 }
 if(permitted(actor,'ads')){
  const slots=(await env.DB.prepare('SELECT page_type,placement,code FROM ad_slots WHERE deleted_at IS NULL').all<{page_type:string;placement:string;code:string}>()).results;
  for(const [page,placements]of Object.entries(adMap))for(const placement of placements){const slot=slots.find(row=>row.page_type===page&&row.placement===placement),fix=`/admin/ads/#slot-${page}-${placement}`;if(!slot?.code.trim()&&!/_[bc]$/.test(placement)&&!['inpage_push','interstitial','push_notifications'].includes(placement))issues.push({key:`empty:${page}:${placement}`,severity:'warning',message:`Empty ad slot: ${page}/${placement}`,fix});}
  const byCode=new Map<string,number>();for(const row of slots){const code=row.code.trim();if(code)byCode.set(code,(byCode.get(code)||0)+1);}const sharedSlots=[...byCode.values()].filter(count=>count>1).reduce((sum,count)=>sum+count,0);if(sharedSlots)issues.push({key:'duplicate:shared',severity:'info',message:`Ad code shared across ${sharedSlots} slots — normal with Adsterra: it gives one code per ad size, so same-size slots share it and their earnings are reported together.`,fix:'/admin/ads/'});
 }
 if(permitted(actor,'seo'))for(const row of (await env.DB.prepare('SELECT path,count FROM notfound_log WHERE count>0 ORDER BY count DESC LIMIT 100').all<{path:string;count:number}>()).results)issues.push({key:`404:${row.path}`,severity:'warning',message:`Visited 404: ${row.path} (≈ ${row.count})`,fix:'/admin/seo/?path='+encodeURIComponent(row.path)});
 let usage: {source?:string;measured_at?:string;worker_requests?:number;d1_rows_read?:number}|null=null;
 try{usage=await env.CONFIG.get('health:usage','json')}catch{}
 if(typeof usage?.worker_requests==='number'&&Number.isFinite(usage.worker_requests)&&usage.worker_requests>=0&&typeof usage?.d1_rows_read==='number'&&Number.isFinite(usage.d1_rows_read)&&usage.d1_rows_read>=0&&usage?.source==='cloudflare-graphql'&&Date.now()-Date.parse(usage.measured_at||'')>=0&&Date.now()-Date.parse(usage.measured_at||'')<3600000){for(const [key,label,limit]of [['worker_requests','Worker requests',100000],['d1_rows_read','D1 rows read',5000000]]as const){const value=usage[key];if(typeof value==='number'&&Number.isFinite(value)&&value>limit*.8)issues.push({key:`quota:${key}`,severity:'error',message:`${label} above 80%: ${value.toLocaleString()} / ${limit.toLocaleString()}`,fix:'https://dash.cloudflare.com/'});}}
 else issues.push({key:'quota-unavailable',severity:'info',message:'Live quota telemetry unavailable; usage has not been verified.',fix:'https://dash.cloudflare.com/'});
 const snoozed=(await env.DB.prepare("SELECT key,snoozed_until FROM admin_issue_state WHERE datetime(snoozed_until)>datetime('now') LIMIT 1000").all<{key:string;snoozed_until:string}>()).results;
 for(const issue of issues){const state=snoozed.find(row=>row.key===issue.key);if(state)issue.snoozed_until=state.snoozed_until;}
 const rank={error:0,warning:1,info:2};return issues.sort((a,b)=>rank[a.severity]-rank[b.severity]||a.key.localeCompare(b.key));
}

export async function setIssueSnooze(env:AdminEnvironment,actor:AdminIdentity,key:string,clear=false){
 requirePermission(actor,'dashboard',true);const issue=(await healthReport(env,actor)).find(row=>row.key===key);if(!issue)throw new AdminError('This problem is no longer present or visible to your role.',404);
 const until=clear?new Date(0).toISOString():new Date(Date.now()+86400000).toISOString();
 await env.DB.batch([
  env.DB.prepare('INSERT INTO admin_issue_state(key,snoozed_until,actor) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET snoozed_until=excluded.snoozed_until,actor=excluded.actor').bind(key,until,actor.email),
  env.DB.prepare("INSERT INTO admin_log(actor,entity,entity_id,after) VALUES(?,'issue_status',?,?)").bind(actor.email,key,JSON.stringify({snoozed_until:until})),
  env.DB.prepare("DELETE FROM admin_issue_state WHERE datetime(snoozed_until)<=datetime('now')")
 ]);return clear?'Issue reopened.':'Issue snoozed for 24 hours; the underlying check still determines whether it is fixed.';
}
