import type { BackgroundContext } from '../../src/lib/counters.ts';
import { queueVote, readVotes, voteChoices } from '../../src/lib/votes.ts';
import type { VoteChoice } from '../../src/lib/votes.ts';

interface VoteEnvironment { DB: D1Database; CONFIG: KVNamespace; }
const reply = (body: Record<string, unknown>, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value !== 0;
const validType = (value: unknown): value is 'movie' | 'tv' => value === 'movie' || value === 'tv';

export async function handleVote(request: Request, env: VoteEnvironment, context: BackgroundContext) {
  if (request.method !== 'GET' && request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST', 'Cache-Control': 'no-store' } });
  const url = new URL(request.url);
  if (request.method === 'POST' && (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')) return reply({ error: 'Same-origin requests only.' }, 403);
  let id: unknown, type: unknown, choice: unknown;
  if (request.method === 'GET') {
    id = Number(url.searchParams.get('id')); type = url.searchParams.get('type');
  } else {
    if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return reply({ error: 'Use JSON.' }, 415);
    // Bound the body while streaming, before parsing or allocating a large body.
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: 'A vote is required.' }, 400);
    let body = '', bytes = 0;
    try {
      const decoder = new TextDecoder();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 512) { void reader.cancel(); return reply({ error: 'Request too large.' }, 413); }
        body += decoder.decode(part.value, { stream: true });
      }
      body += decoder.decode();
      const data: unknown = JSON.parse(body);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return reply({ error: 'Invalid vote.' }, 400);
      ({ id, type, choice } = data as Record<string, unknown>);
    } catch { return reply({ error: 'Invalid JSON.' }, 400); }
    finally { reader.releaseLock(); }
  }
  if (!validId(id) || !validType(type) || (request.method === 'POST' && !voteChoices.includes(choice as VoteChoice))) return reply({ error: 'Invalid vote.' }, 400);
  try {
    const title = await env.DB.prepare('SELECT id,vote_epoch FROM titles WHERE id=? AND type=? AND hidden=0 AND deleted=0 AND deleted_at IS NULL').bind(id, type).first<{id:number;vote_epoch:number}>();
    if (!title) return reply({ error: 'Title not found.' }, 404);
    if (request.method === 'GET') return reply({ counts: await readVotes(env.DB, id, type, title.vote_epoch), approximate: true });
    // Cloudflare supplies this header. Missing metadata shares a conservative
    // fallback bucket rather than accepting an untrusted forwarded IP header.
    const ip = request.headers.get('CF-Connecting-IP') || 'unavailable';
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([day, ip, type, id])));
    const key = `vote:${day}:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    if (await env.CONFIG.get(key)) return reply({ error: 'A vote for this title was already received today.', duplicate: true, counts: await readVotes(env.DB, id, type, title.vote_epoch), approximate: true }, 409);
    // KV is eventually consistent: this is a basic abuse guard, not a lock.
    const midnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
    await env.CONFIG.put(key, '1', { expirationTtl: Math.max(60, Math.ceil((midnight - now.getTime()) / 1000)) });
    queueVote(env.DB, context, { id, type, choice: choice as VoteChoice, epoch: title.vote_epoch });
    return reply({ accepted: true, counts: await readVotes(env.DB, id, type, title.vote_epoch), approximate: true }, 202);
  } catch { return reply({ error: 'Voting is temporarily unavailable. Please try again.' }, 503); }
}
