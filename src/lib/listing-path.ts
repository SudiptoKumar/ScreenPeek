/** Clean hub assets and dynamic pagination/filter endpoints must have distinct paths. */
export function listingBase(path: string): string | null {
  const match = /^(\/(?:movies|series|new|top10|upcoming)\/|\/(?:genre|collection|language)\/[a-z0-9]+(?:-[a-z0-9]+)*\/)(?:(?:page\/[1-9]\d*|filter)\/)?$/.exec(path);
  return match?.[1] || null;
}
export function paginationLink(url: URL, page: number) {
  const base = listingBase(url.pathname);
  if (base && !['genre', 'year', 'rating', 'sort'].some(key => url.searchParams.has(key))) return page === 1 ? base : `${base}page/${page}/`;
  const query = new URLSearchParams(url.searchParams);
  if (page === 1) query.delete('page'); else query.set('page', String(page));
  return `${base ? `${base}filter/` : url.pathname}${query.size ? `?${query}` : ''}`;
}
