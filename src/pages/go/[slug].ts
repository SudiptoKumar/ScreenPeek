import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleGo } from '../../../functions/go/[slug].ts';
export const ALL: APIRoute = ({ request, params, locals }) => handleGo(request, env, locals.cfContext, params.slug || '');
