import { usedIn } from './universal.ts';
import { AdminError,requirePermission } from './access.ts';
import type { AdminIdentity } from './access.ts';
import { commitChange,deliverChange,dispatchSync,savedMessage } from './changes.ts';
import type { AdminEnvironment } from './changes.ts';
import type { AdminRow } from './advanced.ts';
export const titleFields=['slug','title','original_title','overview','release_date','year','runtime_min','status','original_language','popularity','vote_average','vote_count','imdb_id','poster_r2','backdrop_r2','poster_color','og_r2','genres','similar_ids','trailer_key','studio','budget','revenue','gallery_r2','hidden','pinned','pin_starts_at','pin_ends_at'] as const;
export const personFields=['slug','name','bio','profile_r2','popularity'] as const;
const mediaKey=(value:string)=>!value||/^[a-zA-Z0-9_-]+\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.webp$/.test(value)&&!value.split('/').includes('..');
function validated(field:string,value:string):string|number|null{
 if(['hidden','pinned'].includes(field)){if(!['0','1'].includes(value))throw new AdminError('Visibility fields use 0 or 1.');return Number(value)}
 if(['year','runtime_min','popularity','vote_average','vote_count','budget','revenue'].includes(field)){
  if(!value.trim())return ['popularity','vote_count'].includes(field)?0:null;const number=Number(value);if(!Number.isFinite(number)||number<0||number>1e15||field==='vote_average'&&number>10||field==='year'&&(number<1888||number>2200)||!['popularity','vote_average'].includes(field)&&!Number.isSafeInteger(number))throw new AdminError(`Invalid ${field.replaceAll('_',' ')}.`);return number;
 }
 if(field==='release_date'){if(!value)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new AdminError('Use a valid release date.');return value}
 if(field.startsWith('pin_')){if(!value)return null;const date=new Date(value.endsWith('Z')?value:`${value}:00+06:00`);if(!Number.isFinite(date.getTime()))throw new AdminError('Use a valid pin schedule.');return date.toISOString()}
 if(['poster_r2','backdrop_r2','og_r2','profile_r2'].includes(field)){if(!mediaKey(value))throw new AdminError('Choose an owned WebP object key, not an external URL.');return value||null}
 if(field==='poster_color'){if(value&&!/^#[a-f0-9]{6}$/i.test(value))throw new AdminError('Use a six-digit hex colour.');return value||null}
 if(['genres','similar_ids','gallery_r2'].includes(field)){
  const items=value.split(',').map(value=>value.trim()).filter(Boolean);if(items.length>(field==='genres'?20:field==='gallery_r2'?6:12))throw new AdminError('Too many list items.');
  if(field==='genres'&&items.some(value=>!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)))throw new AdminError('Genres use lowercase slugs.');
  if(field==='gallery_r2'&&items.some(value=>!mediaKey(value)))throw new AdminError('Gallery items must be owned WebP keys.');
  if(field==='similar_ids'){const ids=items.map(Number);if(ids.some(value=>!Number.isSafeInteger(value)||value===0))throw new AdminError('Similar titles use numeric IDs.');return JSON.stringify([...new Set(ids)])}
  return JSON.stringify([...new Set(items)]);
 }
 if(field==='slug'&&(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)||value.length>200))throw new AdminError('Use a lowercase slug of at most 200 characters.');
 if(['title','name'].includes(field)&&!value.trim())throw new AdminError('A name/title is required.');
 if(field==='original_language'&&value&&!/^[a-z]{2,3}$/.test(value))throw new AdminError('Use a two- or three-letter language code.');
 if(field==='trailer_key'&&value&&!/^[a-zA-Z0-9_-]{6,20}$/.test(value))throw new AdminError('Use a valid YouTube video key.');
 if(field==='imdb_id'&&value&&!/^tt\d{5,12}$/.test(value))throw new AdminError('Use a valid IMDb title identifier.');
 if(value.length>(['overview','bio'].includes(field)?20000:1000))throw new AdminError('Field value exceeds its length limit.');return value||(['trailer_key','imdb_id','studio'].includes(field)?null:'');
}
export async function metadataAction(env:AdminEnvironment,actor:AdminIdentity,form:URLSearchParams,fetcher:typeof fetch=fetch,restoreLocks?:string[]){
 const kind=form.get('m_kind')==='person'?'person':'title',module=kind==='person'?'people':'titles';requirePermission(actor,module,true);
 const action=form.get('m_action'),id=Number(form.get('id')),type=form.get('type')||'movie';
 if(action==='import'){
  const requested=(form.get('ids')||'').split(',').map(value=>value.trim()).filter(Boolean).join(',');if(!requested)throw new AdminError('Enter at least one movie:ID, tv:ID or person:ID.');
  for(const ref of requested.split(','))requirePermission(actor,ref.startsWith('person:')?'people':'titles',true);
  const url=await dispatchSync(env,actor,fetcher,requested);return {message:'Targeted sync dispatch accepted. Import completion is not yet verified.',jobUrl:url};
 }
 if(!Number.isSafeInteger(id)||!id||kind==='title'&&!['movie','tv'].includes(type))throw new AdminError('Choose a valid record.');
 const table=kind==='person'?'people':'titles',where=kind==='person'?'id=?':'id=? AND type=?',keys=kind==='person'?[id]:[id,type];
 const current=await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`).bind(...keys).first<AdminRow>();if(!current)throw new AdminError('Record not found.',404);
 if(Number(form.get('m_revision'))!==Number(current.revision)||form.get('m_updated_at')!==String(current.updated_at))throw new AdminError('The record changed, possibly through sync. Reload before saving.',409);
 const extra:Array<{sql:string;params:Array<string|number|null>}>=[];
 let next:AdminRow={...current},entity=kind,fields:string[]=[];
 if(action==='delete'){
  if(actor.role!=='owner'||form.get('confirm_delete')!=='DELETE')throw new AdminError('Only Owner can permanently delete; type DELETE to confirm.',403);
  const used=await usedIn(env,kind==='person'?'people':'titles',current);
  if(used&&form.get('confirm_used')!=='1')throw new AdminError(`Used in ${used} places. Confirm referenced-item deletion.`);
  if(kind==='title'){next.deleted=1;next.deleted_at=null;next.hidden=0;next.quality_gate=0;fields=['deleted','deleted_at','hidden','quality_gate'];}else{next.deleted=1;next.deleted_at=new Date().toISOString();fields=['deleted','deleted_at'];}
  extra.push({sql:"INSERT OR IGNORE INTO blocklist(tmdb_id,type,reason) VALUES(?,?,'Owner permanent deletion')",params:[id,kind==='person'?'person':type]});
 }else if(action==='save'){
  if(current.deleted||current.deleted_at)throw new AdminError('Restore this item from Trash before editing.');
  const allowed=kind==='person'?personFields:titleFields;
  let locks:string[];try{const parsed=JSON.parse(String(current.locked_fields||'[]'));locks=Array.isArray(parsed)&&parsed.every(value=>typeof value==='string')?parsed:[...allowed]}catch{locks=[...allowed]}
  if(form.get('clear_locks')==='1')locks=[];
  const unlock=(form.get('unlock_fields')||'').split(',').map(value=>value.trim()).filter(Boolean);
  if(unlock.some(field=>![...allowed,'credits','providers','seasons','collection'].includes(field as never)))throw new AdminError('An unlock field is unknown.');
  locks=locks.filter(field=>!unlock.includes(field));
  for(const field of allowed){if(!form.has(`m_${field}`))continue;const value=validated(field,form.get(`m_${field}`)||'');if(value!==current[field]&&!(current[field]===null&&value==='')&&!(current[field]===''&&value===null)){
    if((['poster_r2','backdrop_r2','og_r2','profile_r2'].includes(field)&&value)||field==='gallery_r2'&&value){
      const imageKeys=field==='gallery_r2'?JSON.parse(String(value)) as string[]:[String(value)];
      if(imageKeys.length&&!env.POSTERS)throw new AdminError('Owned image verification is not configured.',503);
      for(const key of imageKeys){const object=await env.POSTERS!.head(key);if(!object||object.httpMetadata?.contentType!=='image/webp')throw new AdminError('An owned WebP key was not found in the image bucket.');}
    }
    next[field]=value;fields.push(field);if(!['hidden','pinned','pin_starts_at','pin_ends_at'].includes(field))locks.push(field)}}
  if(next.pin_starts_at&&next.pin_ends_at&&String(next.pin_starts_at)>=String(next.pin_ends_at))throw new AdminError('Pin schedule end must follow start.');
  next.locked_fields=JSON.stringify(restoreLocks || [...new Set(locks)]);fields.push('locked_fields');
  if(next.slug!==current.slug){
   const prefix=kind==='person'?'cast':type==='tv'?'tv':'movie';
   for(const path of kind==='person'?['cast']:[prefix,'watch','trailer']){
    extra.push({sql:'DELETE FROM redirects WHERE from_path=?',params:[`/${path}/${next.slug}/`]}, {sql:'UPDATE redirects SET to_target=?,revision=revision+1 WHERE to_target=?',params:[`/${path}/${next.slug}/`,`/${path}/${current.slug}/`]});
    extra.push({sql:'INSERT INTO redirects(from_path,to_target,type,deleted_at) VALUES(?,?,301,NULL) ON CONFLICT(from_path) DO UPDATE SET to_target=excluded.to_target,type=301,deleted_at=NULL,revision=revision+1',params:[`/${path}/${current.slug}/`,`/${path}/${next.slug}/`]});}
  }
 }else throw new AdminError('Unknown metadata action.');
 next.updated_at=new Date().toISOString();fields.push('updated_at');fields=[...new Set(fields)];
 if(kind==='title'){
  extra.push({sql:'DELETE FROM title_genres WHERE title_id=? AND title_type=?',params:[id,type]},{sql:"INSERT OR IGNORE INTO genres(slug,name) SELECT value,replace(value,'-',' ') FROM json_each(?)",params:[String(next.genres||'[]')]},{sql:"INSERT INTO title_genres(title_id,title_type,genre_slug) SELECT ?,?,value FROM json_each(?)",params:[id,type,String(next.genres||'[]')]});
  extra.push({sql:"INSERT OR IGNORE INTO languages(slug,name) SELECT original_language,original_language FROM titles WHERE id=? AND type=? AND original_language IS NOT NULL AND original_language<>''",params:[id,type]});
  extra.push({sql:"UPDATE titles SET quality_gate=CASE WHEN deleted=0 AND deleted_at IS NULL AND poster_r2 IS NOT NULL AND length(trim(poster_r2))>0 AND length(overview)>=80 AND popularity>=COALESCE((SELECT CAST(value AS REAL) FROM config WHERE key='sync_popularity_gate'),10) AND ((SELECT COUNT(*) FROM credits c JOIN people p ON p.id=c.person_id WHERE c.title_id=titles.id AND c.title_type=titles.type AND c.role='cast' AND p.deleted_at IS NULL)>=3 OR EXISTS(SELECT 1 FROM providers p WHERE p.title_id=titles.id AND p.title_type=titles.type)) THEN 1 ELSE 0 END WHERE id=? AND type=?",params:[id,type]});
  extra.push({sql:'DELETE FROM titles_fts WHERE slug IN (?,?)',params:[String(current.slug),String(next.slug)]},{sql:'INSERT INTO titles_fts(title,slug,year,type) SELECT title,slug,year,type FROM titles WHERE id=? AND type=? AND deleted=0 AND deleted_at IS NULL',params:[id,type]});
 }
 if(kind==='person'&&action==='delete')extra.push({sql:"UPDATE titles SET quality_gate=0 WHERE (id,type) IN(SELECT title_id,title_type FROM credits WHERE person_id=?) AND (SELECT COUNT(*) FROM credits c JOIN people p ON p.id=c.person_id WHERE c.title_id=titles.id AND c.title_type=titles.type AND c.role='cast' AND p.deleted_at IS NULL)<3 AND NOT EXISTS(SELECT 1 FROM providers p WHERE p.title_id=titles.id AND p.title_type=titles.type)",params:[id]});
 for(const [table,relation]of [['genres','SELECT COUNT(*) FROM title_genres g JOIN titles t ON t.id=g.title_id AND t.type=g.title_type WHERE g.genre_slug=genres.slug'],['languages','SELECT COUNT(*) FROM titles t WHERE t.original_language=languages.slug'],['collections','SELECT COUNT(*) FROM collection_titles c JOIN titles t ON t.id=c.title_id AND t.type=c.title_type WHERE c.collection_slug=collections.slug']])extra.push({sql:`UPDATE ${table} SET title_count=(${relation} AND t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL)`,params:[]});
 const delivery=await commitChange(env.DB,actor,{entity,id:kind==='person'?String(id):`${type}:${id}`,before:current,after:next,sql:`UPDATE ${table} SET ${fields.map(field=>`${field}=?`).join(',')},revision=revision+1 WHERE ${where} AND revision=? AND updated_at=?`,params:[...fields.map(field=>next[field]),...keys,Number(current.revision),String(current.updated_at)],mirrors:[],related:extra});
 return {message:savedMessage(await deliverChange(env,delivery,fetcher)),jobUrl:undefined};
}

export async function undoMetadata(env:AdminEnvironment,actor:AdminIdentity,id:number,fetcher:typeof fetch=fetch){
 const log=await env.DB.prepare('SELECT entity,before,after FROM admin_log WHERE id=?').bind(id).first<{entity:string;before:string;after:string}>();if(!log||!['title','person'].includes(log.entity))throw new AdminError('Choose a metadata change.');
 requirePermission(actor,log.entity==='person'?'people':'titles',true);
 const before=JSON.parse(log.before) as AdminRow,after=JSON.parse(log.after) as AdminRow;
 if(after.deleted||after.deleted_at)throw new AdminError('Permanent removals cannot be undone.');
 const kind=log.entity==='person'?'person':'title',table=kind==='person'?'people':'titles';
 const current=await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?${kind==='title'?' AND type=?':''}`).bind(...(kind==='title'?[after.id,after.type]:[after.id])).first<AdminRow>();
 if(!current||Number(current.revision)!==Number(after.revision)+1||current.updated_at!==after.updated_at)throw new AdminError('This record changed after the edit; review its current metadata first.',409);
 const form=new URLSearchParams({m_action:'save',m_kind:kind,id:String(current.id),type:String(current.type||'movie'),m_revision:String(current.revision),m_updated_at:String(current.updated_at)});
 for(const field of kind==='person'?personFields:titleFields){let value=before[field];if(['genres','similar_ids','gallery_r2'].includes(field)){try{value=JSON.parse(String(value||'[]')).join(', ')}catch{value=''}}form.set(`m_${field}`,String(value??''));}
 let locks:string[];try{const parsed=JSON.parse(String(before.locked_fields||'[]'));locks=Array.isArray(parsed)&&parsed.every(value=>typeof value==='string')?parsed:[...(kind==='person'?personFields:titleFields)]}catch{locks=[...(kind==='person'?personFields:titleFields)]}
 return (await metadataAction(env,actor,form,fetcher,locks)).message;
}
