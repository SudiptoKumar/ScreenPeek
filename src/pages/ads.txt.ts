import { env } from 'cloudflare:workers';
import { readConfig } from '../lib/ads';
export async function GET() {
  try { return new Response(await readConfig(env, 'ads_txt') || '', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, s-maxage=3600', 'X-Content-Type-Options': 'nosniff' } }); }
  catch { return new Response('Unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
