import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { authorizeInsightApi, insightApiFilters, insightStats } from '../../../lib/tracking/api';

// ScreenPeek Insight reporting API (F26): aggregate stats as JSON.
// Key-gated by the platform secret named in Tracking Settings.
export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  const auth = await authorizeInsightApi(env as unknown as { DB: D1Database } & Record<string, unknown>, request);
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status, headers: { 'Cache-Control': 'no-store' } });
  const stats = await insightStats((env as unknown as { DB: D1Database }).DB, insightApiFilters(url));
  return Response.json(stats, { headers: { 'Cache-Control': 'no-store' } });
};
export const ALL: APIRoute = () => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
