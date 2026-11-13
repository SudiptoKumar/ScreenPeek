import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { ingestPixel, PIXEL_GIF } from '../../../lib/tracking/pixel';

// ScreenPeek Insight pixel endpoint (F22). Image variant returns a 1×1
// GIF; ?via=js returns 204 for script-tag fires. Dark (404) while
// tracking is off.
export const GET: APIRoute = async ({ params, request, url, locals }) => {
  const network = String(params.network || '');
  if (!/^[a-z0-9_-]{1,32}$/.test(network)) return new Response('Not found', { status: 404 });
  const background = (promise: Promise<unknown>) => { try { locals.cfContext?.waitUntil(promise); } catch { /* no context in tests */ } };
  const outcome = await ingestPixel(Object.assign(Object.create(null), env, { background }) as never, network, request, url.searchParams);
  if (url.searchParams.get('via') === 'js') return new Response(null, { status: outcome.status === 404 ? 404 : 204 });
  return new Response(outcome.status === 404 ? 'Not found' : PIXEL_GIF, {
    status: outcome.status,
    headers: outcome.status === 404 ? {} : { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' },
  });
};
export const ALL: APIRoute = () => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
