// Read-only verification against an owner-configured public image URL.
const value = process.argv[2];
try {
  const url = new URL(value || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.webp') || /(?:^|\.)(?:r2\.dev|r2\.cloudflarestorage\.com|workers\.dev|pages\.dev|localhost|test|invalid)$/.test(url.hostname) || ['image.tmdb.org','api.themoviedb.org','files.tmdb.org'].includes(url.hostname)) throw new Error('Supply an owned HTTPS custom-domain WebP URL without credentials or query parameters.');
  const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(15000) });
  const control = response.headers.get('cache-control') || '';
  if (response.status !== 200 || !response.headers.get('content-type')?.includes('image/webp') || !/\bpublic\b/i.test(control) || !/\bmax-age=31536000\b/i.test(control) || !/\bimmutable\b/i.test(control)) throw new Error(`Image delivery verification failed (HTTP ${response.status}); require image/webp and public, max-age=31536000, immutable.`);
  console.log('PASS: owned custom-domain WebP returns HTTP 200 and immutable one-year cache headers.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
