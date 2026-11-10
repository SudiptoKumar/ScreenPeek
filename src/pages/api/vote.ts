import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleVote } from '../../../functions/api/vote.ts';
export const ALL: APIRoute = ({ request, locals }) => handleVote(request, env, locals.cfContext);
