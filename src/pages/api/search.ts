import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleSearch } from '../../../functions/api/search.ts';
export const ALL: APIRoute = ({ request }) => handleSearch(request, env);
