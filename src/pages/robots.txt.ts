import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { robots } from '../lib/sitemaps';
export const GET: APIRoute = () => robots(env);
