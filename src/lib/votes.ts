import type { BackgroundContext } from './counters.ts';

export const voteChoices = ['must', 'good', 'average', 'skip'] as const;
export type VoteChoice = typeof voteChoices[number];
export interface VoteEvent { id: number; type: 'movie' | 'tv'; choice: VoteChoice; epoch?: number; }
export type VoteCounts = Record<VoteChoice, number>;
export const emptyVotes = (): VoteCounts => ({ must: 0, good: 0, average: 0, skip: 0 });

/** Best-effort aggregation, subject to isolate lifetime and storage availability. */
export class VoteBuffer {
  private readonly db: D1Database;
  private pending = new Map<string, VoteEvent & { count: number }>();
  private inFlight: Promise<boolean> | undefined;
  constructor(db: D1Database) { this.db = db; }
  record(event: VoteEvent) {
    const key = JSON.stringify([event.id, event.type, event.choice, event.epoch || 0]);
    const previous = this.pending.get(key);
    if (previous) previous.count++;
    else if (this.pending.size < 2000) this.pending.set(key, { ...event, count: 1 });
    else throw new Error('Vote queue is full');
  }
  counts(id: number, type: string, epoch = 0): VoteCounts {
    const counts = emptyVotes();
    for (const event of this.pending.values()) if (event.id === id && event.type === type && (event.epoch || 0) === epoch) counts[event.choice] += event.count;
    return counts;
  }
  async flush(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (!this.pending.size) return true;
    const snapshot = this.pending;
    this.pending = new Map();
    this.inFlight = (async () => {
      try {
        const values = [...snapshot.values()].slice(0, 40);
        await this.db.batch(values.map(event => this.db.prepare(`INSERT INTO votes(title_id,title_type,choice,count)
          SELECT id,type,?,? FROM titles WHERE id=? AND type=? AND hidden=0 AND deleted=0 AND deleted_at IS NULL AND vote_epoch=?
          ON CONFLICT(title_id,title_type,choice) DO UPDATE SET count=count+excluded.count`)
          .bind(event.choice, event.count, event.id, event.type, event.epoch || 0)));
        if (snapshot.size > 40) console.warn('Approximate vote flush safety limit reached; some votes were omitted.');
        return snapshot.size <= 40;
      } catch {
        console.warn('Approximate vote flush failed; some votes may be missing.');
        return false;
      }
    })();
    try { return await this.inFlight; } finally { this.inFlight = undefined; }
  }
}
const buffers = new WeakMap<D1Database, VoteBuffer>();
const scheduled = new WeakMap<VoteBuffer, Promise<void>>();
export function voteBuffer(db: D1Database) {
  let buffer = buffers.get(db);
  if (!buffer) { buffer = new VoteBuffer(db); buffers.set(db, buffer); }
  return buffer;
}
export function queueVote(db: D1Database, context: BackgroundContext, event: VoteEvent) {
  const buffer = voteBuffer(db);
  buffer.record(event);
  let task = scheduled.get(buffer);
  if (!task) {
    task = new Promise<void>(resolve => setTimeout(() => {
      scheduled.delete(buffer);
      void buffer.flush().finally(resolve);
    }, 5000));
    scheduled.set(buffer, task);
  }
  context.waitUntil(task);
}
export async function readVotes(db: D1Database, id: number, type: string, epoch?: number): Promise<VoteCounts> {
  const counts = emptyVotes();
  if(epoch === undefined)epoch=(await db.prepare('SELECT vote_epoch FROM titles WHERE id=? AND type=?').bind(id,type).first<{vote_epoch:number}>())?.vote_epoch || 0;
  const result = await db.prepare('SELECT choice,count FROM votes WHERE title_id=? AND title_type=?').bind(id, type).all<{ choice: VoteChoice; count: number }>();
  for (const row of result.results) if (voteChoices.includes(row.choice)) counts[row.choice] = Math.max(0, row.count);
  const pending = voteBuffer(db).counts(id, type, epoch);
  for (const choice of voteChoices) counts[choice] += pending[choice];
  return counts;
}
