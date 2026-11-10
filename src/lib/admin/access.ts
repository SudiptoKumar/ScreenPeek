export type AdminRole = 'owner' | 'editor' | 'ads' | 'viewer';
export type AdminModule = 'dashboard' | 'links' | 'ads' | 'content' | 'sync' | 'settings' | 'backup' | 'pages' | 'seo' | 'titles' | 'people' | 'tools' | 'changes';
export interface AdminIdentity { email: string; role: AdminRole; modules: Record<string, boolean>; }
export interface AccessEnvironment { DB: D1Database; CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUD?: string; }
export class AdminError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}
const scopes: Record<AdminRole, readonly AdminModule[]> = {
  owner: ['dashboard', 'links', 'ads', 'content', 'sync', 'settings', 'backup', 'pages', 'seo', 'titles', 'people', 'tools', 'changes'],
  editor: ['dashboard', 'links', 'content', 'pages', 'seo', 'titles', 'people', 'changes'],
  ads: ['links', 'ads'],
  viewer: ['dashboard', 'links', 'ads', 'content', 'sync', 'settings', 'pages', 'seo', 'titles', 'people', 'changes'],
};
export function permitted(identity: AdminIdentity, module: AdminModule, write = false) {
  return scopes[identity.role].includes(module) && identity.modules[module] !== false && (!write || identity.role !== 'viewer');
}
export function requirePermission(identity: AdminIdentity | undefined, module: AdminModule, write = false): asserts identity is AdminIdentity {
  if (!identity) throw new AdminError('Sign in through Cloudflare Access to continue.', 401);
  if (!permitted(identity, module, write)) throw new AdminError('Your role does not allow this action.', 403);
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const decode = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
};
const parse = (value: string) => { const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(value))); if (!record(data)) throw new Error('Invalid object'); return data; };
const keyCache = new Map<string, { expires: number; keys: Array<JsonWebKey & { kid: string }> }>();

/** Verify signature/issuer/audience before trusting the Access email header. */
export async function verifyAccess(request: Request, env: Pick<AccessEnvironment, 'CF_ACCESS_TEAM_DOMAIN' | 'CF_ACCESS_AUD'>, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) throw new AdminError('Admin access is not configured. Add the Cloudflare Access team domain and application audience in secure settings.', 503);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(env.CF_ACCESS_TEAM_DOMAIN) || env.CF_ACCESS_AUD.length > 256) throw new AdminError('Admin access configuration needs attention.', 503);
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const emailHeader = request.headers.get('Cf-Access-Authenticated-User-Email')?.trim().toLowerCase();
  if (!token || token.length > 16_384 || !emailHeader) return null;
  const issuer = `https://${env.CF_ACCESS_TEAM_DOMAIN}`;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = parse(parts[0]), payload = parse(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 128) return null;
    const now = Math.floor(Date.now() / 1000);
    const audience = payload.aud;
    if (payload.iss !== issuer || !(audience === env.CF_ACCESS_AUD || (Array.isArray(audience) && audience.includes(env.CF_ACCESS_AUD))) ||
      typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= now ||
      (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > now + 30)) ||
      (payload.iat !== undefined && (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now + 30)) ||
      typeof payload.email !== 'string' || payload.email.length > 254 || payload.email.trim().toLowerCase() !== emailHeader || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailHeader)) return null;
    let cached = keyCache.get(issuer);
    if (!cached || cached.expires < Date.now()) {
      const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      const text = await response.text();
      if (text.length > 100_000) return null;
      const data: unknown = JSON.parse(text);
      if (!record(data) || !Array.isArray(data.keys)) return null;
      const keys = data.keys.filter((key): key is JsonWebKey & { kid: string } => record(key) && key.kty === 'RSA' && typeof key.kid === 'string' && typeof key.n === 'string' && typeof key.e === 'string' && (!key.use || key.use === 'sig')).slice(0, 8);
      cached = { expires: Date.now() + 300_000, keys };
      if (keyCache.size >= 8) keyCache.delete(keyCache.keys().next().value!);
      keyCache.set(issuer, cached);
    }
    const jwk = cached.keys.find(key => key.kid === header.kid);
    if (!jwk || !jwk.n || decode(jwk.n).length < 256 || decode(jwk.n).length > 1024) return null;
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) return null;
    return emailHeader;
  } catch { return null; }
}
export async function authenticateAdmin(request: Request, env: AccessEnvironment, fetcher: typeof fetch = fetch): Promise<AdminIdentity | null> {
  const email = await verifyAccess(request, env, fetcher);
  if (!email) return null;
  let row: { email: string; role: AdminRole; modules: string } | null;
  try { row = await env.DB.prepare('SELECT email,role,modules FROM admin_users WHERE email=? COLLATE NOCASE').bind(email).first(); }
  catch { throw new AdminError('Admin permissions are temporarily unavailable.', 503); }
  if (!row || !Object.hasOwn(scopes, row.role)) throw new AdminError('This Access identity has no admin role. Ask the owner to add it to admin_users.', 403);
  let modules: unknown;
  try { modules = JSON.parse(row.modules); } catch { return null; }
  if (!record(modules) || Object.values(modules).some(value => typeof value !== 'boolean')) return null;
  return { email, role: row.role, modules: modules as Record<string, boolean> };
}
