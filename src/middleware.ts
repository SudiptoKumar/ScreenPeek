import { storedRedirect, recordNotFound } from './lib/route-policy';
import { cachedCatalogue } from './lib/catalogue-cache';
import { cachedWatch } from './lib/watch-cache';
import { defineMiddleware } from 'astro:middleware';
import { env, waitUntil } from 'cloudflare:workers';
import { authenticateAdmin, AdminError, permitted } from './lib/admin/access';
import { readConfig } from './lib/ads';
import { siteConfig } from './lib/site-config';

export const onRequest = defineMiddleware(async (context, next) => {
  let path = context.url.pathname;
  try { path = decodeURIComponent(path); } catch { /* Invalid paths stay unprivileged. */ }
  const admin = path === '/admin' || path.startsWith('/admin/');
  const publicPage = !admin && !/^\/(?:api|go)(?:\/|$)/.test(path);
  if (publicPage && ['GET', 'HEAD'].includes(context.request.method)) {
    try { const target = await storedRedirect(env.DB, context.url.pathname, context.url.origin); if (target) {const location=new URL(target,context.url);if(!location.search)location.search=context.url.search;return new Response(null, { status: 301, headers: { Location: location.pathname+location.search+location.hash, 'Cache-Control': 'public, max-age=300' } });} } catch { /* Normal rendering handles database failures. */ }
  }
  const adTest = context.url.searchParams.get('adtest') === '1';
  if (!admin && path !== '/maintenance/') {
    let maintenance = false;
    try { maintenance = await readConfig(env, 'maintenance') === '1'; } catch { /* The route retains its own storage-failure handling. */ }
    if (maintenance) {
      if (path.startsWith('/api/') || path.startsWith('/go/')) return new Response('Service temporarily unavailable.', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3600' } });
      return context.rewrite('/maintenance/');
    }
  }
  if (admin || adTest) {
    try {
      context.locals.admin = await authenticateAdmin(context.request, env) || undefined;
      if (!context.locals.admin && admin) context.locals.adminFailure = { status: 401, message: 'Sign in through Cloudflare Access to continue.' };
      context.locals.adTestAuthorized = adTest && !!context.locals.admin && permitted(context.locals.admin, 'ads');
    } catch (error) {
      if (admin) context.locals.adminFailure = error instanceof AdminError ? { status: error.status, message: error.message } : { status: 503, message: 'Admin access is temporarily unavailable.' };
    }
  }
  const cache = env.DEPLOYMENT_ENV === 'production' && !adTest ? (caches as unknown as { default: Cache }).default : undefined;
  let ttls: { list: number; detail: number } | undefined;
  if (cache && !path.startsWith('/watch/')) {
    try { const config = await siteConfig(context.locals, env); ttls = { list: config.cacheTtlList, detail: config.cacheTtlDetail }; } catch { /* The page libraries' built-in TTLs apply. */ }
  }
  const original = path.startsWith('/watch/') ? await cachedWatch(context.request, cache, next)
    : await cachedCatalogue(context.request, cache, next, ttls);
  const response = admin || adTest ? new Response(original.body, { status: original.status, statusText: original.statusText, headers: original.headers }) : original;
  if (admin || adTest) {
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    response.headers.set('Referrer-Policy', 'same-origin');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    if (admin) response.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  }
  if (publicPage && context.request.method === 'GET' && response.status === 404) waitUntil(recordNotFound(env.DB, context.url.pathname));
  return response;
});
