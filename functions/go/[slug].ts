import { readLink, resolveDestination } from '../../src/lib/links.ts';
import { requestCountry } from '../../src/lib/geo.ts';
import { queueClick } from '../../src/lib/counters.ts';
import type { BackgroundContext } from '../../src/lib/counters.ts';

export interface RedirectEnvironment { DB: D1Database; CONFIG: KVNamespace; }
export async function handleGo(request: Request, env: RedirectEnvironment, context: BackgroundContext, slug: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  if (/prefetch|prerender/i.test(`${request.headers.get('Sec-Purpose') || ''} ${request.headers.get('Purpose') || ''}`)) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  let destination = '/';
  try {
    const link = await readLink(env.CONFIG, env.DB, slug);
    const country = requestCountry(request);
    const device = /Mobile|Android|iPhone|iPad/i.test(request.headers.get('User-Agent') || '') ? 'mobile' : 'desktop';
    const resolved = link ? resolveDestination(link, country, device) : null;
    if (resolved) {
      destination = resolved;
      if (request.method === 'GET') {
        try { queueClick(env.DB, context, { slug, day: new Date().toISOString().slice(0, 10), country, device }); }
        catch { console.warn('Approximate click logging was unavailable.'); }
      }
    }
  } catch { /* Missing storage or malformed links safely return home. */ }
  return new Response(null, { status: 302, headers: { Location: destination, 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Content-Type-Options': 'nosniff' } });
}
