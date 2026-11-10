import { countryCookie, requestCountry } from './geo.ts';
/** Internal HTML cache has an explicit country key and never stores a cookie. */
export async function cachedWatch(request: Request, cache: Cache | undefined, next: () => Promise<Response>) {
  if (!cache || request.method !== 'GET' || new URL(request.url).searchParams.has('adtest')) return next();
  const country = requestCountry(request);
  const url = new URL('/__watch-cache/', request.url);
  url.searchParams.set('path', new URL(request.url).pathname); url.searchParams.set('country', country);
  const key = new Request(url);
  try {
    const hit = await cache.match(key);
    if (hit) {
      const response = new Response(hit.body, { status: hit.status, headers: hit.headers });
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('Set-Cookie', countryCookie(country));
      return response;
    }
  } catch { /* Cache failure must not prevent rendering. */ }
  const response = await next();
  if (response.status === 200 && response.headers.get('Content-Type')?.includes('text/html')) {
    const stored = new Response(response.clone().body, { status: 200, headers: response.headers });
    stored.headers.delete('Set-Cookie'); stored.headers.set('Cache-Control', 'public, max-age=3600');
    try { await cache.put(key, stored); } catch { /* Best-effort; source response remains usable. */ }
  }
  return response;
}
