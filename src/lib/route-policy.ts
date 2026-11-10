/** Public route policy; never redirects administrative/API/outbound handlers. */
export function redirectTarget(value: string, origin: string) {
  if (!value || value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, origin);
    if (url.username || url.password || url.origin !== origin || !url.pathname.startsWith('/') || /^\/(?:admin|api|go)(?:\/|$)/.test(url.pathname)) return null;
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}
export async function storedRedirect(db: D1Database, path: string, origin: string) {
  let row = await db.prepare('SELECT to_target,type FROM redirects WHERE from_path=? AND deleted_at IS NULL').bind(path).first<{ to_target: string; type: number }>();
  if(!row&&/^\/tv\/[^/]+\/season\//.test(path)){const root=path.split('/').slice(0,3).join('/')+'/';const parent=await db.prepare('SELECT to_target,type FROM redirects WHERE from_path=? AND deleted_at IS NULL').bind(root).first<{to_target:string;type:number}>();if(parent&&parent.type===301){const base=redirectTarget(parent.to_target,origin);if(base&&base.startsWith('/tv/')&&base.endsWith('/'))row={type:301,to_target:base+path.slice(root.length)};}}
  if (!row || row.type !== 301) return null;
  const target = redirectTarget(row.to_target, origin);
  return target && new URL(target, origin).pathname !== path ? target : null;
}
/** Approximate per-isolate batching; bounded paths and table avoid unbounded bot logs. */
const buffers = new WeakMap<D1Database, Map<string, number>>();
export async function recordNotFound(db: D1Database, path: string) {
  if (path.length > 250 || !/^\/[a-zA-Z0-9/_.,~-]*$/.test(path)) return;
  let buffer = buffers.get(db);
  if (!buffer) { buffer = new Map(); buffers.set(db, buffer); }
  if (buffer.size >= 40 && !buffer.has(path)) return;
  buffer.set(path, (buffer.get(path) || 0) + 1);
  if (buffer.size > 1 || [...buffer.values()].some(count => count > 1)) return;
  await new Promise(resolve => setTimeout(resolve, 5000));
  const rows = [...buffer]; buffer.clear();
  try {
    await db.batch(rows.map(([key, count]) => db.prepare("INSERT INTO notfound_log(path,count,last_seen) SELECT ?,?,datetime('now') WHERE (SELECT COUNT(*) FROM notfound_log)<1000 OR EXISTS(SELECT 1 FROM notfound_log WHERE path=?) ON CONFLICT(path) DO UPDATE SET count=count+excluded.count,last_seen=excluded.last_seen").bind(key, count, key)));
  } catch { /* Lost buffers are approximate; never interrupt a public response. */ }
}
