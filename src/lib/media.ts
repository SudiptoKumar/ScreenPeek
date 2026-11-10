/** Only owned storage is a source for public images; missing config uses a placeholder. */
export function mediaUrl(key: string | null | undefined, base: string | undefined, width?: 185 | 500) {
  if (!key || !base) return null;
  let url: URL;
  try { url = new URL(base); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (['image.tmdb.org', 'api.themoviedb.org', 'files.tmdb.org'].includes(url.hostname.replace(/\.$/, ''))) return null;
  const variant = width ? key.replace(/_w(?:185|500)\.webp$/, `_w${width}.webp`) : key;
  if (variant.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return `${url.href.replace(/\/$/, '')}/${variant.split('/').map(encodeURIComponent).join('/')}`;
}
