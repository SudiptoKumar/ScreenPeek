import type { SqlClient, SqlStatement } from './storage.ts';
const keys:Record<string,string[]>={links:['slug'],ad_slots:['page_type','placement'],titles:['id','type'],people:['id'],pages:['slug'],redirects:['from_path'],seo_overrides:['path'],collections:['slug'],taxonomy_overrides:['kind','slug'],homepage_sections:['key']};
/** Expiry runs in small bounded batches after sync. Title tombstones keep 410s. */
export async function purgeExpiredTrash(db:SqlClient,date=new Date(),maxRows=1000){
  if(maxRows<1)return 0;
  const cutoff=new Date(date.getTime()-30*86400000).toISOString();
  const rows=await db.query<{entity:string;entity_key:string}>('SELECT entity,entity_key FROM admin_trash WHERE datetime(deleted_at)<=datetime(?) ORDER BY deleted_at LIMIT ?',[cutoff,Math.max(1,Math.min(1000,maxRows))]);
  let removed=0;
  for(const row of rows){
    const columns=Object.hasOwn(keys,row.entity)?keys[row.entity]:null;if(!columns)continue;
    let values:unknown;try{values=JSON.parse(row.entity_key)}catch{continue}
    if(!Array.isArray(values)||values.length!==columns.length||values.some(value=>typeof value!=='string'&&(typeof value!=='number'||!Number.isSafeInteger(value))))continue;
    const params=values as Array<string|number>,where=columns.map(key=>`${key}=?`).join(' AND ');
    const current=(await db.query(`SELECT * FROM ${row.entity} WHERE ${where} AND datetime(deleted_at)<=datetime(?)`,[...params,cutoff]))[0];
    const statements:SqlStatement[]=[];
    if(current){
      statements.push({sql:`INSERT INTO admin_revision_guard(id) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM ${row.entity} WHERE ${where} AND revision=? AND datetime(deleted_at)<=datetime(?))`,params:[...params,Number(current.revision),cutoff]});
      if(row.entity==='titles'){
        statements.push({sql:"INSERT OR IGNORE INTO blocklist(tmdb_id,type,reason) VALUES(?,?,'Trash expired after 30 days')",params:[Number(current.id),String(current.type)]});
        statements.push({sql:"UPDATE titles SET deleted=1,deleted_at=NULL,hidden=0,overview=NULL,poster_r2=NULL,quality_gate=0,revision=revision+1 WHERE id=? AND type=? AND datetime(deleted_at)<=datetime(?)",params:[Number(current.id),String(current.type),cutoff]});
      }else{
        if(row.entity==='people')statements.push({sql:"INSERT OR IGNORE INTO blocklist(tmdb_id,type,reason) VALUES(?,'person','Trash expired after 30 days')",params:[Number(current.id)]});
        if(row.entity==='collections')statements.push({sql:'DELETE FROM collection_titles WHERE collection_slug=?',params:[String(current.slug)]});
        statements.push({sql:`DELETE FROM ${row.entity} WHERE ${where} AND datetime(deleted_at)<=datetime(?)`,params:[...params,cutoff]});
      }
      statements.push({sql:"INSERT INTO admin_log(actor,entity,entity_id,before,after) VALUES('system:trash-expiry',?,?,?,?)",params:[`expiry:${row.entity}`,row.entity_key,JSON.stringify(current),JSON.stringify({expired:true})]});
    }
    statements.push({sql:'DELETE FROM admin_trash WHERE entity=? AND entity_key=? AND datetime(deleted_at)<=datetime(?)',params:[row.entity,row.entity_key,cutoff]});
    try { await db.batch(statements); if(current)removed++; } catch { /* A restored/concurrently edited row is left intact for a later run. */ }
  }
  return removed;
}
