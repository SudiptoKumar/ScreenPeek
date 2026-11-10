import { AdminError, requirePermission } from './access.ts';
import type { AdminIdentity } from './access.ts';
import type { AdminEnvironment, MirrorRef } from './changes.ts';
import { deliverChange, savedMessage } from './changes.ts';
import { exportAdminBackup } from './data.ts';
import type { AdminRow } from './advanced.ts';
const tables=['links','ad_slots','config','redirects','pages','taxonomy_overrides','collections','collection_titles','homepage_sections'];
export async function restoreForm(request:Request){
 if(request.headers.get('Origin')!==new URL(request.url).origin||request.headers.get('Sec-Fetch-Site')==='cross-site')throw new AdminError('Submit restoration from the admin site.',403);
 const reader=request.body?.getReader();if(!reader)throw new AdminError('Upload a configuration file.');const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2200000){void reader.cancel();throw new AdminError('The restore upload exceeds 2 MB.',413)}chunks.push(part.value)}}finally{reader.releaseLock()}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const body=await new Response(bytes,{headers:{'Content-Type':request.headers.get('Content-Type')||''}}).formData();
 const file=body.get('backup_file');if(!(file instanceof File)||file.size>2000000)throw new AdminError('Choose a configuration JSON file under 2 MB.');
 if(body.getAll('backup_file').length!==1||body.getAll('confirm_restore').length!==1)throw new AdminError('Duplicate restore fields are not supported.');
 return new URLSearchParams({action:'restore-config',backup_json:await file.text(),confirm_restore:String(body.get('confirm_restore')||'')});
}
export async function restoreConfiguration(env:AdminEnvironment,actor:AdminIdentity,form:URLSearchParams,fetcher:typeof fetch=fetch){
 requirePermission(actor,'backup',true);if(actor.role!=='owner')throw new AdminError('Only the owner can restore a backup.',403);
 if(form.get('confirm_restore')!=='RESTORE')throw new AdminError('Type RESTORE to confirm replacement.');
 if(!env.BACKUPS)throw new AdminError('Configure the private backup binding before restoring.',503);
 let input:unknown;try{input=JSON.parse(form.get('backup_json')||'')}catch{throw new AdminError('The configuration JSON is invalid.')}
 const value=input as {format?:string;version?:number;data?:Record<string,unknown>};
 if(value?.format!=='screenpeek-config'||value.version!==1||!value.data||typeof value.data!=='object')throw new AdminError('Choose a supported configuration export.');
 const incoming:Record<string,AdminRow[]>={};let count=0;
 for(const table of tables){
  const rows=value.data[table];if(!Array.isArray(rows))throw new AdminError(`The export is missing ${table}.`);
  if(rows.length>2000)throw new AdminError('This restore exceeds the 2000-record table bound.');
  const columns=(await env.DB.prepare(`PRAGMA table_info(${table})`).all<{name:string}>()).results.map(row=>row.name);
  for(const row of rows){if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!columns.includes(key))||Object.values(row).some(item=>item!==null&&typeof item!=='string'&&(typeof item!=='number'||!Number.isFinite(item))))throw new AdminError('The export has unknown fields or unsupported values.');}
  if(rows.length&&rows.some(row=>Object.keys(row).sort().join(',')!==Object.keys(rows[0]).sort().join(',')))throw new AdminError('Rows within a table need matching columns.');
  incoming[table]=rows;count+=rows.length;
 }
 if(count>5000)throw new AdminError('The configuration exceeds the total restore bound.');
 if(incoming.config.some(row=>/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY/i.test(String(row.key))))throw new AdminError('Platform credentials cannot be restored from site configuration.');
 const content=value.data.content;
 if(!Array.isArray(content)||content.length>10000||content.some(row=>!row||!Number.isSafeInteger(row.id)||!['movie','tv'].includes(row.type)||![0,1].includes(row.pinned)||![0,1].includes(row.hidden)))throw new AdminError('Invalid content visibility snapshot.');
 const last=(await env.DB.prepare('SELECT COALESCE(MAX(id),0) id FROM admin_log').first<{id:number}>())?.id||0;
 const snapshot=await exportAdminBackup(env,actor);
 const key=`backups/${new Date().toISOString().replaceAll(':','-')}-pre-restore-${crypto.randomUUID()}.json.gz`;
 const compressed=await new Response(new Blob([JSON.stringify(snapshot)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
 await env.BACKUPS.put(key,compressed,{httpMetadata:{contentType:'application/gzip',cacheControl:'private, no-store'}});
 const statements:D1PreparedStatement[]=[env.DB.prepare('INSERT INTO admin_revision_guard(id) SELECT 1 WHERE (SELECT COALESCE(MAX(id),0) FROM admin_log)<>?').bind(last)];
 const mirrors:MirrorRef[]=[];
 // Clear old mirrors as well as publishing imported values; deleted links must not survive in KV.
 const previousLinks=(snapshot.data.links||[]) as AdminRow[],previousAds=(snapshot.data.ad_slots||[]) as AdminRow[],previousConfig=(snapshot.data.config||[]) as AdminRow[];
 for(const row of [...previousLinks,...incoming.links])mirrors.push({kind:'link',id:String(row.slug)});
 for(const row of [...previousAds,...incoming.ad_slots])mirrors.push({kind:'ad',page:String(row.page_type) as 'detail',placement:String(row.placement) as 'native'});
 for(const row of [...previousConfig,...incoming.config])mirrors.push({kind:'config',key:String(row.key)});
 for(const table of [...tables].reverse())statements.push(env.DB.prepare(`DELETE FROM ${table}`));
 for(const table of tables){const rows=incoming[table];if(!rows.length)continue;const columns=Object.keys(rows[0]);statements.push(env.DB.prepare(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map(key=>`json_extract(value,'$.${key}')`).join(',')} FROM json_each(?)`).bind(JSON.stringify(rows)));}
 statements.push(env.DB.prepare("UPDATE titles SET pinned=0,hidden=0,pin_starts_at=NULL,pin_ends_at=NULL,revision=revision+1 WHERE deleted=0 AND deleted_at IS NULL AND (pinned<>0 OR hidden<>0) AND (id,type) NOT IN(SELECT json_extract(value,'$.id'),json_extract(value,'$.type') FROM json_each(?))").bind(JSON.stringify(content)));
 statements.push(env.DB.prepare("UPDATE titles SET pinned=json_extract(j.value,'$.pinned'),hidden=json_extract(j.value,'$.hidden'),pin_starts_at=json_extract(j.value,'$.pin_starts_at'),pin_ends_at=json_extract(j.value,'$.pin_ends_at'),revision=revision+1 FROM json_each(?) j WHERE titles.id=json_extract(j.value,'$.id') AND titles.type=json_extract(j.value,'$.type') AND deleted=0 AND deleted_at IS NULL").bind(JSON.stringify(content)));
 const refs=[...new Map(mirrors.map(ref=>[JSON.stringify(ref),ref])).values()];
 statements.push(env.DB.prepare("INSERT INTO admin_log(actor,entity,entity_id,before,after) VALUES(?,'config_restore',?,NULL,?)").bind(actor.email,key,JSON.stringify({tables:tables.length,records:count,pre_restore_snapshot:key})));
 statements.push(env.DB.prepare("INSERT INTO admin_delivery(log_id,entity,entity_id,payload) VALUES(last_insert_rowid(),'config_restore',?,?)").bind(key,JSON.stringify(refs)));
 let result;try{result=await env.DB.batch(statements)}catch{throw new AdminError('Restore could not commit. The pre-restore snapshot is retained; reload before retrying.',409)}
 return savedMessage(await deliverChange(env,Number(result.at(-1)?.meta.last_row_id),fetcher,2));
}
