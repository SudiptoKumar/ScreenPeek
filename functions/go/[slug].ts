import { readLink, resolveDestination, httpsDestination } from '../../src/lib/links.ts';
import type { ManagedLink } from '../../src/lib/links.ts';
import { requestCountry } from '../../src/lib/geo.ts';
import { queueClick } from '../../src/lib/counters.ts';
import type { BackgroundContext } from '../../src/lib/counters.ts';
import { parseTrackingConfig, readTrackingValues } from '../../src/lib/tracking/config.ts';
import { captureClick, newClickId } from '../../src/lib/tracking/click.ts';
import { resolveIdentity } from '../../src/lib/tracking/identity.ts';

/** Why this destination won — mirrors resolveDestination's precedence. */
function routeReasonOf(link: ManagedLink, country: string, device: 'mobile' | 'desktop', resolved: string): string {
  let rules: Record<string, unknown> = {};
  try {
    const value: unknown = typeof link.rules === 'string' ? JSON.parse(link.rules) : link.rules;
    if (value && typeof value === 'object' && !Array.isArray(value)) rules = value as Record<string, unknown>;
  } catch { /* Malformed rules resolved as the default destination. */ }
  const mapping = (value: unknown, key: string) => value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  for (const [reason, candidate] of [['country', mapping(rules.byCountry, country)], ['device', mapping(rules.byDevice, device)]] as const) {
    if (httpsDestination(candidate) && new URL(candidate).href === resolved) return reason;
  }
  return 'default';
}

export interface RedirectEnvironment { DB: D1Database; CONFIG: KVNamespace; }
export async function handleGo(request: Request, env: RedirectEnvironment, context: BackgroundContext, slug: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  if (/prefetch|prerender/i.test(`${request.headers.get('Sec-Purpose') || ''} ${request.headers.get('Purpose') || ''}`)) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  let destination = '/';
  const identityCookies: string[] = [];
  // Insight switches are read in parallel with the link lookup below, so
  // the tracking check adds no serial time to the redirect (gate G3.6).
  const switchesPromise = readTrackingValues(env, ['tracking_enabled', 'tracking_pass_click_id', 'tracking_click_param_name', 'tracking_consent_mode', 'tracking_daily_cap', 'tracking_tier1_countries', 'tracking_fill_pct', 'tracking_fill_after_hour_utc', 'tracking_ip_mode', 'tracking_quality_weights']).catch(() => null);
  try {
    const link = await readLink(env.CONFIG, env.DB, slug);
    const country = requestCountry(request);
    const device = /Mobile|Android|iPhone|iPad/i.test(request.headers.get('User-Agent') || '') ? 'mobile' : 'desktop';
    const resolved = link ? resolveDestination(link, country, device) : null;
    if (resolved) {
      destination = resolved;
      if (request.method === 'GET') {
        try { queueClick(env.DB, context, { slug, day: new Date().toISOString().slice(0, 10), country, device }); }
        catch { console.warn('Approximate click logging was unavailable.'); }
        // ScreenPeek Insight capture — dark while tracking_enabled != '1',
        // backgrounded so the redirect is never delayed by it.
        try {
          const switches = await switchesPromise;
          if (link && switches?.tracking_enabled === '1') {
            const clickId = newClickId();
            const pass = switches.tracking_pass_click_id;
            const paramName = switches.tracking_click_param_name;
            const identity = resolveIdentity(request, switches.tracking_consent_mode || 'basic');
            identityCookies.push(...identity.setCookies);
            const rows: Record<string, string> = {};
            for (const [key, value] of Object.entries(switches)) if (typeof value === 'string') rows[key] = value;
            context.waitUntil(captureClick(env, {
              request, slug, linkName: link.name, linkType: link.type, destination: resolved,
              routeReason: routeReasonOf(link, country, device, resolved), clickId,
              visitorId: identity.visitorId, sessionId: identity.sessionId,
              cfg: parseTrackingConfig(rows),
            }));
            if (pass !== '0') {
              const target = new URL(resolved);
              target.searchParams.set(paramName || 'sp_cid', clickId);
              destination = target.href;
            }
          }
        } catch { /* Insight must never break the redirect. */ }
      }
    }
  } catch { /* Missing storage or malformed links safely return home. */ }
  const headers = new Headers({ Location: destination, 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Content-Type-Options': 'nosniff' });
  for (const cookie of identityCookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}
