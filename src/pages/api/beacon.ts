import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ingestBeacon } from '../../lib/tracking/beacon';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const outcome = await ingestBeacon(env, request);
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    for (const cookie of outcome.setCookies) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: outcome.status, headers });
  } catch {
    // The endpoint always answers safely; a tracking fault is invisible.
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
};

export const ALL: APIRoute = () => new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
