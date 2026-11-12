import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ingestPostback } from '../../../lib/tracking/postback';

export const prerender = false;

async function handle({ request, params }: Parameters<APIRoute>[0]): Promise<Response> {
  const network = String(params.network || '').toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(network)) return new Response('Not found', { status: 404 });
  const collected = new URLSearchParams(new URL(request.url).searchParams);
  if (request.method === 'POST') {
    const contentType = request.headers.get('Content-Type') || '';
    try {
      if (contentType.includes('application/json')) {
        const body = await request.json() as Record<string, unknown>;
        for (const [key, value] of Object.entries(body)) if (!collected.has(key)) collected.set(key, String(value ?? ''));
      } else {
        const form = new URLSearchParams(await request.text());
        for (const [key, value] of form.entries()) if (!collected.has(key)) collected.set(key, value);
      }
    } catch { /* an unreadable body still gets its query params processed */ }
  }
  const outcome = await ingestPostback(env as unknown as { DB: D1Database } & Record<string, unknown>, network, collected);
  return new Response(outcome.body, { status: outcome.http, headers: { 'Cache-Control': 'no-store' } });
}

export const GET: APIRoute = handle;
export const POST: APIRoute = handle;
