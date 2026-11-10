/** Cache API reduces repeat D1 reads; a hit still enters the Worker. Owner TTL settings override the origin s-maxage per page class. */
export async function cachedCatalogue(request: Request, cache: Cache | undefined, next: () => Promise<Response>, ttls?: { list: number; detail: number }) {
  const url = new URL(request.url);
  const eligible = /^\/(?:movie|tv|cast|genre|collection|language|movies|series|new|top10|upcoming)(?:\/|$)/.test(url.pathname)
    && request.method === 'GET' && [...url.searchParams.keys()].every(key => key === 'page')
    && (!url.searchParams.has('page') || /^[1-9]\d{0,5}$/.test(url.searchParams.get('page') || ''));
  if (!cache || !eligible) return next();
  const classTtl = ttls ? (/^\/(?:movie|tv|cast)\//.test(url.pathname) ? ttls.detail : ttls.list) : undefined;
  const key = new Request(url);
  try {
    const hit = await cache.match(key);
    if (hit) {
      const response = new Response(hit.body, { status: hit.status, headers: hit.headers });
      const ttl = classTtl ? String(classTtl) : /max-age=(\d+)/.exec(hit.headers.get('Cache-Control') || '')?.[1] || '3600';
      response.headers.set('Cache-Control', `public, s-maxage=${ttl}, stale-while-revalidate=604800`);
      return response;
    }
  } catch { /* Render if unavailable. */ }
  const response = await next();
  const control = response.headers.get('Cache-Control') || '';
  const ttl = /s-maxage=(\d+)/.exec(control)?.[1];
  if (response.status === 200 && /\bpublic\b/.test(control) && !/private|no-store/.test(control) && ttl && !response.headers.has('set-cookie') && response.headers.get('Content-Type')?.includes('text/html')) {
    if (classTtl) response.headers.set('Cache-Control', `public, s-maxage=${classTtl}, stale-while-revalidate=604800`);
    const stored = new Response(response.clone().body, { status: response.status, headers: response.headers });
    stored.headers.set('Cache-Control', `public, max-age=${Math.min(86400, classTtl ?? Number(ttl))}`);
    try { await cache.put(key, stored); } catch { /* Cache is optional. */ }
  }
  return response;
}
