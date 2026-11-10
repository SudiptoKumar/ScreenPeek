import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { sitemapIndex } from '../lib/sitemaps';
export const GET: APIRoute = () => sitemapIndex(env);
