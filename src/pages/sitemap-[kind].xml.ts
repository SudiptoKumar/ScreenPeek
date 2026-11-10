import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { sitemapPart } from '../lib/sitemaps';
import type { SitemapKind } from '../lib/sitemaps';
export const GET: APIRoute = ({ params }) => {
  const match = /^(titles|people|taxonomy|pages)(?:-([1-9]\d{0,5}))?$/.exec(params.kind || '');
  if (!match || (match[1] === 'titles' && !match[2])) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return sitemapPart(env, match[1] as SitemapKind, match[2] || '1');
};
