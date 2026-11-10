import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleWidgetQuery, type WidgetQuery } from '../../lib/telegram-money';

export const prerender = false;

const methodNotAllowed: APIRoute = () => new Response('Method Not Allowed', { status: 405, headers: { 'Cache-Control': 'no-store' } });
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;

/**
 * Webhook receiver for @TrafeeUpdatebot. Only `widget_query` updates with
 * data "refresh" (the money card's Refresh button) are acted on; every
 * other update type is acknowledged and ignored. Telegram retries non-200
 * deliveries, so a validly signed request is always acked with 200 and
 * failures are logged instead of surfacing as HTTP errors.
 */
export const POST: APIRoute = async ({ request }) => {
  if (!env.MONEY_WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.MONEY_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const update = (await request.json()) as { widget_query?: WidgetQuery } | null;
    if (update?.widget_query?.data === 'refresh') await handleWidgetQuery(env, update.widget_query);
  } catch (error) {
    console.error('telegram money webhook failed:', error);
  }
  return new Response('OK', { status: 200, headers: { 'Cache-Control': 'no-store' } });
};
