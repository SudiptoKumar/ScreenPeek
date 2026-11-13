import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { authorizeInsightApi, insightApiFilters, insightClicks } from '../../../lib/tracking/api';

// ScreenPeek Insight reporting API (F26): stored clicks as JSON, same
// filters and 3,000-row cap as the export centre, IPs never included.
export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  const auth = await authorizeInsightApi(env as unknown as { DB: D1Database } & Record<string, unknown>, request);
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status, headers: { 'Cache-Control': 'no-store' } });
  const clicks = await insightClicks((env as unknown as { DB: D1Database }).DB, insightApiFilters(url));
  return Response.json(clicks, { headers: { 'Cache-Control': 'no-store' } });
};
export const ALL: APIRoute = () => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
