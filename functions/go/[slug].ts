import { readLink, resolveDestination, httpsDestination } from '../../src/lib/links.ts';
import type { ManagedLink } from '../../src/lib/links.ts';
import { requestCountry } from '../../src/lib/geo.ts';
import { queueClick } from '../../src/lib/counters.ts';
import type { BackgroundContext } from '../../src/lib/counters.ts';
import { parseTrackingConfig, readTrackingValues } from '../../src/lib/tracking/config.ts';
import { captureClick, newClickId } from '../../src/lib/tracking/click.ts';
import { resolveIdentity } from '../../src/lib/tracking/identity.ts';
import { decideRoute, qualityGateSignals, readVariantCounts, readVariants, recordCapAlerts } from '../../src/lib/tracking/routing.ts';
import { clientInfo, parseUserAgent } from '../../src/lib/tracking/parse.ts';

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
  const switchesPromise = readTrackingValues(env, ['tracking_enabled', 'tracking_pass_click_id', 'tracking_click_param_name', 'tracking_consent_mode', 'tracking_daily_cap', 'tracking_tier1_countries', 'tracking_fill_pct', 'tracking_fill_after_hour_utc', 'tracking_ip_mode', 'tracking_quality_weights', 'tracking_rotation_sticky', 'tracking_quality_gate_enabled', 'tracking_disguise_weights']).catch(() => null);
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
            // Variant routing (F18/F19/F21): weighted pick among active,
            // in-schedule, under-cap variants; cascade to the resolved
            // destination when none can serve; the quality gate may send
            // flagged clicks to the link's safe page instead.
            let finalDestination = resolved;
            let routeReason = routeReasonOf(link, country, device, resolved);
            let variantId: number | null = null;
            const variants = await readVariants(env, slug).catch(() => []);
            let safeUrl = '';
            if (switches.tracking_quality_gate_enabled === '1') {
              const settings = await env.DB.prepare('SELECT safe_url FROM tr_link_settings WHERE slug=?').bind(slug)
                .first<{ safe_url: string }>().catch(() => null);
              safeUrl = settings?.safe_url || '';
            }
            if (safeUrl) {
              const info = clientInfo(request);
              const ua = parseUserAgent(request.headers.get('User-Agent') || '');
              if (qualityGateSignals(request, info.asOrg, info.trustScore, ua.isBotUa) >= 2) {
                finalDestination = safeUrl;
                routeReason = 'quality_gate';
              }
            }
            if (routeReason !== 'quality_gate' && variants.length) {
              const counts = await readVariantCounts(env, variants, new Date());
              const decision = decideRoute({
                variants, counts, fallbackDestination: resolved, fallbackReason: routeReason,
                stickyKey: switches.tracking_rotation_sticky !== '0' && identity.visitorId ? `${slug}:${identity.visitorId}` : null,
                now: new Date(),
              });
              finalDestination = decision.destination;
              routeReason = decision.routeReason;
              variantId = decision.variantId;
              if (decision.cappedIds.length) context.waitUntil(recordCapAlerts(env, slug, decision.cappedIds, new Date()));
            }
            destination = finalDestination;
            context.waitUntil(captureClick(env, {
              request, slug, linkName: link.name, linkType: link.type, destination: finalDestination,
              routeReason, clickId,
              visitorId: identity.visitorId, sessionId: identity.sessionId,
              variantId,
              cfg: parseTrackingConfig(rows),
            }));
            if (pass !== '0') {
              const target = new URL(finalDestination);
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
