import type { TitleCard } from './catalogue.ts';
export interface HomeSection { key:string;label:string;ord:number;source:string;pins:string; }
const keys=['trending','top10','movies','series','upcoming','categories','genres'];
export async function homeSections(db:D1Database){
  const rows=(await db.prepare("SELECT key,label,ord,source,pins FROM homepage_sections WHERE enabled=1 AND deleted_at IS NULL AND (starts_at IS NULL OR datetime(starts_at)<=datetime('now')) AND (ends_at IS NULL OR datetime(ends_at)>datetime('now')) ORDER BY ord,key").all<HomeSection>()).results;
  return rows.filter(row=>keys.includes(row.key));
}
export async function manualTitles(db:D1Database,section:HomeSection,includeUngated=false):Promise<TitleCard[]>{
  let pins:unknown;try{pins=JSON.parse(section.pins)}catch{return []}
  if(!Array.isArray(pins))return [];
  const refs=pins.filter(value=>typeof value==='string'&&/^(movie|tv):-?[1-9]\d*$/.test(value)).slice(0,section.key==='top10'?10:6) as string[];
  const rows=(await db.prepare(`SELECT t.id,t.type,t.slug,t.title,t.year,t.poster_r2,t.poster_color,t.vote_average,t.views,t.updated_at,t.release_date FROM titles t JOIN json_each(?) p ON t.type=substr(p.value,1,instr(p.value,':')-1) AND t.id=CAST(substr(p.value,instr(p.value,':')+1) AS INTEGER) WHERE t.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL ${includeUngated?'':'AND t.quality_gate=1'} ORDER BY CAST(p.key AS INTEGER)`).bind(JSON.stringify(refs)).all<TitleCard>()).results;
  return rows;
}
