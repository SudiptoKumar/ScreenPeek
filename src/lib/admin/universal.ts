import { AdminError, permitted, requirePermission } from './access.ts';
import type { AdminIdentity, AdminModule } from './access.ts';
import { deliverChange, savedMessage } from './changes.ts';
import type { AdminEnvironment, MirrorRef } from './changes.ts';
import type { AdminRow } from './advanced.ts';
type Spec = { table: string; module: AdminModule; keys: string[]; fields: string[]; search: string[]; sort: string[]; trash?: boolean; add?: boolean; };
export const lists: Record<string, Spec> = {
  links: { table:'links',module:'links',keys:['slug'],fields:['name','type','destination','enabled','starts_at','ends_at'],search:['name','slug'],sort:['name','slug','clicks_total','updated_at'],trash:true },
  ad_slots: { table:'ad_slots',module:'ads',keys:['page_type','placement'],fields:['enabled','starts_at','ends_at'],search:['page_type','placement'],sort:['page_type','placement','enabled'],trash:true },
  titles: { table:'titles',module:'content',keys:['id','type'],fields:['hidden','pinned','pin_starts_at','pin_ends_at'],search:['title','slug'],sort:['title','year','popularity','views','updated_at'],trash:true },
  people: { table:'people',module:'people',keys:['id'],fields:[],search:['name','slug'],sort:['name','popularity','updated_at'],trash:true },
  pages: { table:'pages',module:'pages',keys:['slug'],fields:['title','body_md'],search:['title','slug'],sort:['title','updated_at'],trash:true,add:true },
  redirects: { table:'redirects',module:'seo',keys:['from_path'],fields:[],search:['from_path','to_target'],sort:['from_path','created_at'],trash:true },
  seo_overrides: { table:'seo_overrides',module:'seo',keys:['path'],fields:['noindex'],search:['path','title'],sort:['path','title'],trash:true },
  collections: { table:'collections',module:'content',keys:['slug'],fields:['name','starts_at','ends_at'],search:['name','slug'],sort:['name','title_count'],trash:true,add:true },
  taxonomy_overrides: { table:'taxonomy_overrides',module:'content',keys:['kind','slug'],fields:['display_name','intro','hidden','ord'],search:['display_name','slug','kind'],sort:['kind','slug','ord'],trash:true,add:true },
  homepage_sections: { table:'homepage_sections',module:'content',keys:['key'],fields:['label','ord','enabled','source','pins','starts_at','ends_at'],search:['label','key'],sort:['ord','key'],trash:true,add:true },
  sync_log: { table:'sync_log',module:'sync',keys:['id'],fields:[],search:['status','source','errors'],sort:['id','started_at','status'] },
  admin_trash:{table:'admin_trash',module:'changes',keys:['entity','entity_key'],fields:[],search:['entity','entity_key','actor','snapshot'],sort:['deleted_at','entity','actor']},
  admin_log: { table:'admin_log',module:'changes',keys:['id'],fields:[],search:['actor','entity','entity_id'],sort:['id','ts','actor','entity'] },
  notfound_log: { table:'notfound_log',module:'seo',keys:['path'],fields:[],search:['path'],sort:['count','last_seen','path'] },
};
export const listDefaults: Partial<Record<AdminModule,string>> = { links:'links',ads:'ad_slots',content:'titles',titles:'titles',people:'people',pages:'pages',seo:'redirects',sync:'sync_log',changes:'admin_log' };
const like = (text: string) => `%${text.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')}%`;
export function listSpec(actor: AdminIdentity, name: string) {
  const spec = Object.hasOwn(lists,name) ? lists[name] : undefined;
  if (!spec) throw new AdminError('Unknown record list.');
  if(name==='titles'&&permitted(actor,'titles'))return spec;
  requirePermission(actor,spec.module); return spec;
}
export function rowKey(spec: Spec,row: AdminRow) { return JSON.stringify(spec.keys.map(key => row[key])); }
export async function listData(env: AdminEnvironment, actor: AdminIdentity, name: string, url: URL, exportAll=false) {
  const spec = listSpec(actor,name), query = (url.searchParams.get('uq') || '').slice(0,100);
  const requestedSort = url.searchParams.get('usort') || spec.sort[0], sort = spec.sort.includes(requestedSort) ? requestedSort : spec.sort[0];
  const desc = url.searchParams.get('udir') === 'desc', state = url.searchParams.get('ustate') || 'active';
  const page = Math.max(1,Math.min(10000,Number.parseInt(url.searchParams.get('upage') || '1') || 1));
  const clauses = [`(${spec.search.map(key => `${key} LIKE ? ESCAPE '\\'`).join(' OR ')})`], params: Array<string|number> = spec.search.map(() => like(query));
  if(name==='admin_log'){
    if(!permitted(actor,'ads'))clauses.push("entity NOT IN ('ad_slot','bulk:ad_slots')");
    if(!permitted(actor,'settings'))clauses.push("NOT(entity='config' AND entity_id NOT IN ('google_site_verification','bing_site_verification'))");
  }
  if(name==='admin_trash'){const names=Object.keys(lists).filter(key=>lists[key].trash&&permitted(actor,lists[key].module));clauses.push('entity IN(SELECT value FROM json_each(?))');params.push(JSON.stringify(names));}
  if(['titles','people'].includes(name)&&state!=='all')clauses.push('deleted=0');
  if (spec.trash) clauses.push(state === 'trash' ? 'deleted_at IS NOT NULL' : state === 'all' ? '1' : 'deleted_at IS NULL');
  const flag = ['enabled','hidden','pinned'].find(key => spec.fields.includes(key));
  if (flag && ['0','1'].includes(url.searchParams.get('uflag') || '')) { clauses.push(`${flag}=?`); params.push(Number(url.searchParams.get('uflag'))); }
  const where = clauses.join(' AND ');
  const total = (await env.DB.prepare(`SELECT COUNT(*) n FROM ${spec.table} WHERE ${where}`).bind(...params).first<{ n:number }>())?.n || 0;
  if (exportAll && total>2000) throw new AdminError('Narrow the filtered list to 2000 records before export.');
  const rows = (await env.DB.prepare(`SELECT * FROM ${spec.table} WHERE ${where} ORDER BY ${sort} ${desc?'DESC':'ASC'},${spec.keys.join(',')} LIMIT ? OFFSET ?`).bind(...params,exportAll?2000:50,exportAll?0:(page-1)*50).all<AdminRow>()).results;
  let selected: AdminRow | null = null;
  if (url.searchParams.has('u_edit') && url.searchParams.get('u_edit') !== 'new') {
    const key = parseKeys(url.searchParams.get('u_edit') || '',spec);
    selected = await env.DB.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.keys.map(key=>`${key}=?`).join(' AND ')}`).bind(...key).first<AdminRow>();
  }
  let used = 0;
  if (selected) used = await usedIn(env,name,selected);
  let collectionPins = '';
  if (name==='collections' && selected) collectionPins = (await env.DB.prepare("SELECT title_type||':'||title_id AS value FROM collection_titles WHERE collection_slug=? ORDER BY title_type,title_id").bind(selected.slug).all<{value:string}>()).results.map(row=>row.value).join(', ');
  return { spec,rows,selected,used,total,page,pages:Math.max(1,Math.ceil(total/50)),query,sort,desc,state,collectionPins };
}
export function csvRows(rows: AdminRow[]) {
  const keys = [...new Set(rows.flatMap(row=>Object.keys(row)))];
  const cell = (value: unknown) => { let text=String(value??''); if (typeof value==='string' && /^[=+\-@\t\r]/.test(text)) text="'"+text; return '"'+text.replaceAll('"','""')+'"'; };
  return [keys.map(cell).join(','),...rows.map(row=>keys.map(key=>cell(row[key])).join(','))].join('\r\n');
}
function parseKeys(value: string,spec: Spec): Array<string|number> {
  let keys: unknown; try { keys=JSON.parse(value); } catch { throw new AdminError('Choose a valid item.'); }
  if (!Array.isArray(keys)||keys.length!==spec.keys.length||keys.some(value=>typeof value!=='string'&&(typeof value!=='number'||!Number.isSafeInteger(value)))) throw new AdminError('Choose a valid item.');
  return keys;
}
export async function usedIn(env: AdminEnvironment,name:string,row:AdminRow) {
  if (name==='titles') {
    const count = await env.DB.prepare('SELECT COUNT(*) n FROM collection_titles WHERE title_id=? AND title_type=?').bind(row.id,row.type).first<{n:number}>();
    const sections=(await env.DB.prepare('SELECT pins FROM homepage_sections WHERE deleted_at IS NULL').all<{pins:string}>()).results;
    return (count?.n||0)+Number(!!row.pinned)+sections.filter(section=>{try{return JSON.parse(section.pins).includes(`${row.type}:${row.id}`)}catch{return false}}).length;
  }
  if (name==='people') return (await env.DB.prepare('SELECT COUNT(*) n FROM credits WHERE person_id=?').bind(row.id).first<{n:number}>())?.n||0;
  if (name==='collections') return (await env.DB.prepare('SELECT COUNT(*) n FROM collection_titles WHERE collection_slug=?').bind(row.slug).first<{n:number}>())?.n||0;
  if (name==='links') {
    const refs=await env.DB.prepare("SELECT value FROM config WHERE key='social_links'").first<{value:string}>();
    return Number((refs?.value||'').split(',').map(value=>value.trim()).includes(String(row.slug))) + (/^prov-\d+$/.test(String(row.slug)) ? (await env.DB.prepare('SELECT COUNT(DISTINCT title_type||title_id) n FROM providers WHERE provider_id=?').bind(Number(String(row.slug).slice(5))).first<{n:number}>())?.n||0 : 0);
  }
  if (name==='pages') return 1;
  return 0;
}
function refreshCounts(env:AdminEnvironment){return [
  env.DB.prepare('UPDATE genres SET title_count=(SELECT COUNT(*) FROM title_genres g JOIN titles t ON t.id=g.title_id AND t.type=g.title_type WHERE g.genre_slug=genres.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL)'),
  env.DB.prepare('UPDATE languages SET title_count=(SELECT COUNT(*) FROM titles t WHERE t.original_language=languages.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL)'),
  env.DB.prepare('UPDATE collections SET title_count=(SELECT COUNT(*) FROM collection_titles c JOIN titles t ON t.id=c.title_id AND t.type=c.title_type WHERE c.collection_slug=collections.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL)')
];}
const mirrorsFor=(name:string,row:AdminRow):MirrorRef[]=>name==='links'?[{kind:'link',id:String(row.slug)}]:name==='ad_slots'?[{kind:'ad',page:String(row.page_type) as 'detail',placement:String(row.placement) as 'native'}]:[];
function fieldValue(field:string,value:string):string|number|null {
  if (['enabled','hidden','pinned','noindex'].includes(field)) { if (!['0','1'].includes(value)) throw new AdminError('Boolean values must be 0 or 1.'); return Number(value); }
  if (field==='ord') { const number=Number(value); if (!Number.isSafeInteger(number)||Math.abs(number)>10000) throw new AdminError('Order must be an integer from -10000 to 10000.'); return number; }
  if (/ends_at$|starts_at$/.test(field)) {
    if (!value) return null; const date=new Date(value.endsWith('Z')?value:`${value}:00+06:00`); if (!Number.isFinite(date.getTime())) throw new AdminError('Use a valid schedule date.'); return date.toISOString();
  }
  if (field==='destination') { try { const url=new URL(value); if(url.protocol==='https:'&&!url.username&&!url.password)return url.href; }catch{} throw new AdminError('Destination must be an HTTPS URL.'); }
  if (field==='source'&&!['auto','manual'].includes(value)) throw new AdminError('Choose auto or manual.');
  if (field==='type'&&!['affiliate','smartlink','social','other'].includes(value)) throw new AdminError('Choose a supported link type.');
  if (field==='pins') {
    const pins=value.split(',').map(value=>value.trim()).filter(Boolean);
    if (pins.length>10||pins.some(value=>! /^(movie|tv):-?[1-9]\d*$/.test(value))) throw new AdminError('Choose up to ten movie:ID or tv:ID values.');
    return JSON.stringify([...new Set(pins)]);
  }
  if (value.length>(field==='body_md'?20000:field==='intro'?2000:250)) throw new AdminError('Value is too long.');
  return value;
}
async function titlePins(env:AdminEnvironment,value:string,max:number) {
  const pins=[...new Set(value.split(',').map(value=>value.trim()).filter(Boolean))];
  if(pins.length>max||pins.some(value=>! /^(movie|tv):-?[1-9]\d*$/.test(value)))throw new AdminError(`Choose up to ${max} movie:ID or tv:ID values.`);
  const pairs=pins.map(value=>{const [type,id]=value.split(':');return [Number(id),type]});
  if(pairs.length){const rows=await env.DB.prepare("SELECT COUNT(*) n FROM titles WHERE (id,type) IN(SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)) AND deleted=0 AND deleted_at IS NULL").bind(JSON.stringify(pairs)).first<{n:number}>();if(rows?.n!==pairs.length)throw new AdminError('A chosen title is missing or in Trash.');}
  return {pins,pairs};
}
export async function undoBulk(env:AdminEnvironment,actor:AdminIdentity,id:number,fetcher:typeof fetch=fetch){
  const log=await env.DB.prepare('SELECT entity,before,after FROM admin_log WHERE id=?').bind(id).first<{entity:string;before:string;after:string}>();
  if(!log?.entity.startsWith('bulk:'))throw new AdminError('Choose a bulk change.');
  const name=log.entity.slice(5),spec=listSpec(actor,name);requirePermission(actor,spec.module,true);
  const originals=JSON.parse(log.before) as AdminRow[], recorded=JSON.parse(log.after) as {operation:string;rows:AdminRow[]};
  if(recorded.operation==='purge')throw new AdminError('Permanent purges cannot be undone. Use the pre-purge backup.');
  const statements:D1PreparedStatement[]=[],currentRows:AdminRow[]=[],restoredRows:AdminRow[]=[],mirrors:MirrorRef[]=[];
  for(const expected of recorded.rows){
    const keys=spec.keys.map(key=>expected[key]),where=spec.keys.map(key=>`${key}=?`).join(' AND ');
    const current=await env.DB.prepare(`SELECT * FROM ${spec.table} WHERE ${where}`).bind(...keys).first<AdminRow>();
    if(!current||Number(current.revision)!==Number(expected.revision))throw new AdminError('A bulk item changed. Undo its latest change first.',409);
    const original=originals.find(row=>rowKey(spec,row)===rowKey(spec,expected));
    const restored={...current};
    if(original){for(const field of [...spec.fields,'deleted_at'])if(Object.hasOwn(original,field))restored[field]=original[field];}
    else{restored.deleted_at=new Date().toISOString();if(Object.hasOwn(restored,'enabled'))restored.enabled=0;}
    statements.push(env.DB.prepare(`INSERT INTO admin_revision_guard(id) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM ${spec.table} WHERE ${where} AND revision=?)`).bind(...keys,Number(current.revision)));
    const fields=Object.keys(restored).filter(key=>!spec.keys.includes(key)&&key!=='revision'&&!key.startsWith('_')&&restored[key]!==current[key]);
    if(!fields.length)throw new AdminError('This change has no remaining values to restore.');
    statements.push(env.DB.prepare(`UPDATE ${spec.table} SET ${[...fields.map(key=>`${key}=?`),'revision=revision+1'].join(',')} WHERE ${where} AND revision=?`).bind(...fields.map(key=>restored[key]),...keys,Number(current.revision)));
    if(restored.deleted_at)statements.push(env.DB.prepare('INSERT OR REPLACE INTO admin_trash(entity,entity_key,snapshot,actor) VALUES(?,?,?,?)').bind(name,rowKey(spec,current),JSON.stringify(current),actor.email));
    else statements.push(env.DB.prepare('DELETE FROM admin_trash WHERE entity=? AND entity_key=?').bind(name,rowKey(spec,current)));
    if(name==='collections'&&original?._members){
      const refs=JSON.parse(String(original._members)) as string[];
      statements.push(env.DB.prepare('DELETE FROM collection_titles WHERE collection_slug=?').bind(current.slug));
      statements.push(env.DB.prepare("INSERT INTO collection_titles(collection_slug,title_id,title_type,source) SELECT ?,CAST(substr(value,instr(value,':')+1) AS INTEGER),substr(value,1,instr(value,':')-1),'manual' FROM json_each(?)").bind(current.slug,JSON.stringify(refs)));
    }
    currentRows.push(current);restoredRows.push({...restored,revision:Number(current.revision)+1});mirrors.push(...mirrorsFor(name,restored));
  }
  if(name==='titles'||name==='collections')statements.push(...refreshCounts(env));
  const token=crypto.randomUUID();
  statements.push(env.DB.prepare('INSERT INTO admin_log(actor,entity,entity_id,before,after) VALUES(?,?,?,?,?)').bind(actor.email,`bulk:${name}`,token,JSON.stringify(currentRows),JSON.stringify({operation:'undo',rows:restoredRows})));
  statements.push(env.DB.prepare('INSERT INTO admin_delivery(log_id,entity,entity_id,payload) VALUES(last_insert_rowid(),?,?,?)').bind(`bulk:${name}`,token,JSON.stringify(mirrors)));
  let results;try{results=await env.DB.batch(statements)}catch{throw new AdminError('The Undo batch changed concurrently; reload before retrying.',409)}
  return savedMessage(await deliverChange(env,Number(results.at(-1)?.meta.last_row_id),fetcher));
}
export async function universalAction(env:AdminEnvironment,actor:AdminIdentity,module:AdminModule,form:URLSearchParams,fetcher:typeof fetch=fetch) {
  const name=form.get('list')||'',spec=listSpec(actor,name); requirePermission(actor,name==='titles'&&module==='titles'?'titles':spec.module,true); requirePermission(actor,module,true);
  const operation=form.get('u_action')||'', statements:D1PreparedStatement[]=[], before:AdminRow[]=[], after:AdminRow[]=[], mirrors:MirrorRef[]=[];
  if(operation==='purge'&&actor.role!=='owner')throw new AdminError('Only the owner can permanently purge Trash.',403);
  if(operation==='add'){
    if(!spec.add)throw new AdminError('Use the dedicated creation tool for this record.');
    const row:AdminRow={};for(const key of spec.keys){const value=form.get(`u_${key}`)||'';if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)||value.length>120)throw new AdminError('Use short lowercase keys.');row[key]=value;}
    if(name==='pages'&&!['about','privacy','dmca','contact','404'].includes(String(row.slug)))throw new AdminError('Choose a supported trust-page slug.');
    if(name==='homepage_sections'&&!['trending','top10','movies','series','upcoming','categories','genres'].includes(String(row.key)))throw new AdminError('Choose a documented homepage section.');
    if(name==='taxonomy_overrides'&&!['genre','language','collection'].includes(String(row.kind)))throw new AdminError('Choose genre, language or collection.');
    for(const field of spec.fields)row[field]=fieldValue(field,form.get(`u_${field}`)||'');
    if(name==='collections'&&!String(row.name).trim())throw new AdminError('A collection name is required.');
    const columns=Object.keys(row);const token=crypto.randomUUID();
    const results=await env.DB.batch([
      env.DB.prepare(`INSERT INTO ${spec.table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(key=>row[key])),
      env.DB.prepare('INSERT INTO admin_log(actor,entity,entity_id,before,after) VALUES(?,?,?,?,?)').bind(actor.email,`bulk:${name}`,token,'[]',JSON.stringify({operation:'add',rows:[{...row,revision:0}]})),
      env.DB.prepare('INSERT INTO admin_delivery(log_id,entity,entity_id,payload) VALUES(last_insert_rowid(),?,?,?)').bind(`bulk:${name}`,token,'[]')
    ]);
    return savedMessage(await deliverChange(env,Number(results.at(-1)?.meta.last_row_id),fetcher));
  }
  const values=operation==='save'?[form.get('u_key')||'']:form.getAll('u_keys');
  if(values.length>5||!values.length)throw new AdminError('Select 1–5 items per batch.');
  for(const value of values){
    const keys=parseKeys(value,spec),where=spec.keys.map(key=>`${key}=?`).join(' AND ');
    const current=await env.DB.prepare(`SELECT * FROM ${spec.table} WHERE ${where}`).bind(...keys).first<AdminRow>();
    if(!current)throw new AdminError('An item no longer exists. Reload the list.',409);
    statements.push(env.DB.prepare(`INSERT INTO admin_revision_guard(id) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM ${spec.table} WHERE ${where} AND revision=?)`).bind(...keys,Number(current.revision)));
    const next={...current};let membershipChanged=false;
    if(operation==='trash'){
      if(!spec.trash)throw new AdminError('This operational log cannot be deleted here.');
      const used=await usedIn(env,name,current);if(used&&form.get('confirm_used')!=='1')throw new AdminError(`Used in ${used} places. Confirm the referenced-item deletion before applying.`);
      next.deleted_at=new Date().toISOString();if(Object.hasOwn(current,'enabled'))next.enabled=0;
      statements.push(env.DB.prepare('INSERT OR REPLACE INTO admin_trash(entity,entity_key,snapshot,actor) VALUES(?,?,?,?)').bind(name,value,JSON.stringify(current),actor.email));
    }else if(operation==='restore'){
      const trash=await env.DB.prepare('SELECT snapshot FROM admin_trash WHERE entity=? AND entity_key=? AND deleted_at>datetime(\'now\',\'-30 days\')').bind(name,value).first<{snapshot:string}>();
      if(!trash)throw new AdminError('This item is not in restorable Trash.');
      const original=JSON.parse(trash.snapshot) as AdminRow; next.deleted_at=null;
      if(Object.hasOwn(current,'enabled'))next.enabled=original.enabled;
      statements.push(env.DB.prepare('DELETE FROM admin_trash WHERE entity=? AND entity_key=?').bind(name,value));
    }else if(operation==='purge'){
      if(!current.deleted_at)throw new AdminError('Move the item to Trash first.');
      if(name==='titles'){
        statements.push(env.DB.prepare("INSERT OR IGNORE INTO blocklist(tmdb_id,type,reason) VALUES(?,?,'Owner purge')").bind(current.id,current.type));
        next.deleted=1;next.deleted_at=null;next.hidden=0;next.overview=null;next.poster_r2=null;next.quality_gate=0;
      }else{
        if(name==='people')statements.push(env.DB.prepare("INSERT OR IGNORE INTO blocklist(tmdb_id,type,reason) VALUES(?,'person','Owner purge')").bind(current.id));
        statements.push(env.DB.prepare(`DELETE FROM ${spec.table} WHERE ${where}`).bind(...keys));
        statements.push(env.DB.prepare('DELETE FROM admin_trash WHERE entity=? AND entity_key=?').bind(name,value));
        before.push(current);after.push({...current,deleted_at:'purged'});mirrors.push(...mirrorsFor(name,current));continue;
      }
      statements.push(env.DB.prepare('DELETE FROM admin_trash WHERE entity=? AND entity_key=?').bind(name,value));
    }else if(operation==='bulk'){
      const field=form.get('u_field')||'';if(!spec.fields.includes(field)||['destination','name','label','intro','display_name','pins'].includes(field))throw new AdminError('Choose an allowed bulk field.');
      next[field]=fieldValue(field,form.get('u_value')||'');
    }else if(operation==='save'){
      if(!spec.fields.length)throw new AdminError('Use the dedicated editor for this record.');
      for(const field of spec.fields)next[field]=fieldValue(field,form.get(`u_${field}`)||'');
      if(Number(form.get('u_revision'))!==Number(current.revision))throw new AdminError('This item changed; reload before saving.',409);
    }else throw new AdminError('Unknown list action.');
    if(name==='homepage_sections'&&next.source==='manual'){
      const pins=JSON.parse(String(next.pins||'[]')) as string[];await titlePins(env,pins.join(','),next.key==='top10'?10:6);
      if(['categories','genres'].includes(String(next.key)))throw new AdminError('Only title sections support manual pins.');
    }
    if(name==='collections'&&operation==='save'&&form.has('u_members')){
      const previous=(await env.DB.prepare("SELECT title_type||':'||title_id value FROM collection_titles WHERE collection_slug=? ORDER BY title_type,title_id").bind(current.slug).all<{value:string}>()).results.map(row=>row.value);
      const selected=await titlePins(env,form.get('u_members')||'',100);membershipChanged=JSON.stringify(previous)!==JSON.stringify([...selected.pins].sort());
      current._members=JSON.stringify(previous);next._members=JSON.stringify(selected.pins);
      if(membershipChanged){
        statements.push(env.DB.prepare('DELETE FROM collection_titles WHERE collection_slug=?').bind(current.slug));
        statements.push(env.DB.prepare("INSERT INTO collection_titles(collection_slug,title_id,title_type,source) SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),'manual' FROM json_each(?)").bind(current.slug,JSON.stringify(selected.pairs)));
        statements.push(env.DB.prepare('UPDATE collections SET title_count=(SELECT COUNT(*) FROM collection_titles c JOIN titles t ON t.id=c.title_id AND t.type=c.title_type WHERE c.collection_slug=? AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL) WHERE slug=?').bind(current.slug,current.slug));
      }
    }
    if(name==='collections'&&!String(next.name||'').trim())throw new AdminError('A collection name is required.');
    if(name==='homepage_sections'&&!String(next.label||'').trim())throw new AdminError('A section label is required.');
    if(next.starts_at&&next.ends_at&&String(next.starts_at)>=String(next.ends_at))throw new AdminError('Schedule end must follow start.');
    if(next.pin_starts_at&&next.pin_ends_at&&String(next.pin_starts_at)>=String(next.pin_ends_at))throw new AdminError('Pin schedule end must follow start.');
    const fields=Object.keys(next).filter(key=>!spec.keys.includes(key)&&key!=='revision'&&!key.startsWith('_')&&next[key]!==current[key]);
    if(!fields.length&&!membershipChanged)throw new AdminError('No values changed.');
    statements.push(env.DB.prepare(`UPDATE ${spec.table} SET ${[...fields.map(key=>`${key}=?`),'revision=revision+1'].join(',')} WHERE ${where} AND revision=?`).bind(...fields.map(key=>next[key]),...keys,Number(current.revision)));
    before.push(current);after.push({...next,revision:Number(current.revision)+1});mirrors.push(...mirrorsFor(name,next));
  }
  if(statements.length>35)throw new AdminError('This operation exceeds its free-tier statement budget; choose fewer items.');
  if (name === 'titles') {
    statements.push(env.DB.prepare('UPDATE genres SET title_count=(SELECT COUNT(*) FROM title_genres g JOIN titles t ON t.id=g.title_id AND t.type=g.title_type WHERE g.genre_slug=genres.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL)'));
    statements.push(env.DB.prepare('UPDATE languages SET title_count=(SELECT COUNT(*) FROM titles t WHERE t.original_language=languages.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL)'));
    statements.push(env.DB.prepare('UPDATE collections SET title_count=(SELECT COUNT(*) FROM collection_titles c JOIN titles t ON t.id=c.title_id AND t.type=c.title_type WHERE c.collection_slug=collections.slug AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL)'));
  }
  // Every row is checked before one atomic mutation/audit/outbox batch.
  const token=crypto.randomUUID();
  statements.push(env.DB.prepare('INSERT INTO admin_log(actor,entity,entity_id,before,after) VALUES(?,?,?,?,?)').bind(actor.email,`bulk:${name}`,token,JSON.stringify(before),JSON.stringify({operation,rows:after})));
  statements.push(env.DB.prepare('INSERT INTO admin_delivery(log_id,entity,entity_id,payload) VALUES(last_insert_rowid(),?,?,?)').bind(`bulk:${name}`,token,JSON.stringify(mirrors)));
  let results; try { results=await env.DB.batch(statements); } catch { throw new AdminError('The batch could not commit. A record may have changed; reload before retrying.',409); } const deliveryId=Number(results.at(-1)?.meta.last_row_id);
  return savedMessage(await deliverChange(env,deliveryId,fetcher));
}
