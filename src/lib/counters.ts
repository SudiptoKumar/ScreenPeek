export interface ClickEvent { slug: string; day: string; country: string; device: 'mobile' | 'desktop'; }
export interface BackgroundContext { waitUntil(promise: Promise<unknown>): void; }

/** Best-effort per-isolate aggregation. Never describe these counters as exact. */
export class ClickBuffer {
  private pending = new Map<string, ClickEvent & { count: number }>();
  private inFlight: Promise<boolean> | undefined;
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  record(event: ClickEvent) {
    const key = JSON.stringify([event.slug, event.day, event.country, event.device]);
    const existing = this.pending.get(key);
    if (existing) existing.count++;
    else if (this.pending.size < 2000) this.pending.set(key, { ...event, count: 1 });
    else console.warn('Approximate click buffer is full; an event was not retained.');
  }
  size() { return this.pending.size; }
  async flush(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (!this.pending.size) return true;
    const snapshot = this.pending;
    this.pending = new Map();
    this.inFlight = (async () => {
      try {
        const statements: D1PreparedStatement[] = [];
        const totals = new Map<string, { slug: string; day: string; count: number; events: Array<ClickEvent & { count: number }> }>();
        for (const event of snapshot.values()) {
          const key = JSON.stringify([event.slug, event.day]);
          const total = totals.get(key);
          if (total) { total.count += event.count; total.events.push(event); }
          else totals.set(key, { slug: event.slug, day: event.day, count: event.count, events: [event] });
        }
        let omitted = false;
        for (const total of totals.values()) {
          // Leave headroom below Free-plan's 50 D1 queries per invocation.
          if (statements.length + total.events.length + 1 > 40) { omitted = true; continue; }
          for (const event of total.events) statements.push(this.db.prepare(`INSERT INTO click_log(slug,day,country,device,dest,count) VALUES(?,?,?,?,'',?)
            ON CONFLICT(slug,day,country,device,dest) DO UPDATE SET count=count+excluded.count`).bind(event.slug, event.day, event.country, event.device, event.count));
          statements.push(this.db.prepare(`UPDATE links SET clicks_total=clicks_total+?,
          clicks_today=CASE WHEN clicks_day=? THEN clicks_today+? WHEN clicks_day IS NULL OR clicks_day<? THEN ? ELSE clicks_today END,
          clicks_day=CASE WHEN clicks_day IS NULL OR clicks_day<? THEN ? ELSE clicks_day END WHERE slug=?`).bind(total.count, total.day, total.count, total.day, total.count, total.day, total.day, total.slug));
        }
        if (statements.length) await this.db.batch(statements);
        if (omitted) console.warn('Approximate click flush safety limit reached; some counts were omitted.');
        return !omitted;
      } catch {
        // Discard an ambiguous snapshot rather than retrying increments which
        // might already have committed. The UI labels counters approximate.
        console.warn('Approximate click flush failed; some counts may be missing.');
        return false;
      }
    })();
    try { return await this.inFlight; } finally { this.inFlight = undefined; }
  }
}

const buffers = new WeakMap<D1Database, ClickBuffer>();
const scheduled = new WeakMap<ClickBuffer, Promise<void>>();
export function queueClick(db: D1Database, context: BackgroundContext, event: ClickEvent) {
  let buffer = buffers.get(db);
  if (!buffer) { buffer = new ClickBuffer(db); buffers.set(db, buffer); }
  buffer.record(event);
  let task = scheduled.get(buffer);
  if (!task) {
    const current = buffer;
    task = new Promise<void>(resolve => setTimeout(() => {
      scheduled.delete(current);
      void current.flush().finally(resolve);
    }, 5000));
    scheduled.set(buffer, task);
  }
  context.waitUntil(task);
}
