export interface ManagedLink {
  slug: string; name: string; destination: string; type: string; enabled: number | boolean;
  rules: string | Record<string, unknown>; starts_at?: string | null; ends_at?: string | null; deleted_at?: string | null;
}
export function httpsDestination(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
export function linkActive(link: ManagedLink, now = new Date()) {
  if (link.deleted_at) return false;
  if (!(link.enabled === 1 || link.enabled === true) || !httpsDestination(link.destination)) return false;
  for (const date of [link.starts_at, link.ends_at]) if (date && !Number.isFinite(Date.parse(date))) return false;
  return (!link.starts_at || Date.parse(link.starts_at) <= now.getTime()) && (!link.ends_at || Date.parse(link.ends_at) > now.getTime());
}
export async function readLink(kv: KVNamespace, db: D1Database, slug: string): Promise<ManagedLink | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  try {
    const value = await kv.get<ManagedLink>(`link:${slug}`, 'json');
    if (value) return typeof value === 'object' && value.slug === slug ? value : null;
  } catch { /* Read-only fallback to the authoritative database. */ }
  return db.prepare('SELECT slug,name,destination,type,enabled,rules,starts_at,ends_at,deleted_at FROM links WHERE slug=?').bind(slug).first<ManagedLink>();
}
export const providerLinkSlug = (id: number) => id < 0 ? `prov-sample-${Math.abs(id)}` : `prov-${id}`;

export function resolveDestination(link: ManagedLink, country: string, device: 'mobile' | 'desktop', now = new Date()) {
  if (!linkActive(link, now)) return null;
  let rules: Record<string, unknown> = {};
  try {
    const value: unknown = typeof link.rules === 'string' ? JSON.parse(link.rules) : link.rules;
    if (value && typeof value === 'object' && !Array.isArray(value)) rules = value as Record<string, unknown>;
  } catch { /* Malformed rules fall back to the validated default. */ }
  const mapping = (value: unknown, key: string) => value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  for (const candidate of [mapping(rules.byCountry, country), mapping(rules.byDevice, device), link.destination]) {
    if (httpsDestination(candidate)) return new URL(candidate).href;
  }
  return null;
}
