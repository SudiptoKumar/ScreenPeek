// ScreenPeek Insight — visitor + session identity (F5).
//
// First-party cookies only: sp_vid (visitor, 1 year) and sp_sid
// (session, 30-minute rolling). Consent-aware: GPC and DNT signals are
// always honoured in basic/strict modes; strict mode additionally needs
// an explicit sp_consent=1 opt-in cookie. When consent is denied, no
// cookie is set and click rows carry an empty visitor_id — the UI copy
// states plainly that clearing cookies starts a new visitor (G5.2).

export const VISITOR_COOKIE = 'sp_vid';
export const SESSION_COOKIE = 'sp_sid';
const VISITOR_MAX_AGE = 31_536_000; // 1 year
const SESSION_MAX_AGE = 1_800; // 30 minutes

const cookieValue = (request: Request, name: string) =>
  request.headers.get('Cookie')?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1] ?? '';

export function readIdentity(request: Request): { visitorId: string; sessionId: string } {
  return { visitorId: cookieValue(request, VISITOR_COOKIE), sessionId: cookieValue(request, SESSION_COOKIE) };
}

export function consentAllows(request: Request, consentMode: string): boolean {
  if (consentMode === 'off') return true;
  if (request.headers.get('Sec-GPC') === '1') return false;
  if (request.headers.get('DNT') === '1') return false;
  if (consentMode === 'strict') return cookieValue(request, 'sp_consent') === '1';
  return true; // basic
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure`;

export interface IdentityResult {
  visitorId: string;
  sessionId: string;
  /** Set-Cookie header values to attach to the response (may be empty). */
  setCookies: string[];
}

/**
 * Resolve the request's identity, minting ids when allowed and needed.
 * Existing cookies are reused (G5.1); the session cookie is refreshed so
 * its 30-minute window rolls with activity.
 */
export function resolveIdentity(request: Request, consentMode: string): IdentityResult {
  const existing = readIdentity(request);
  if (!consentAllows(request, consentMode)) return { visitorId: '', sessionId: '', setCookies: [] };
  const visitorId = existing.visitorId || crypto.randomUUID();
  const sessionId = existing.sessionId || crypto.randomUUID();
  const setCookies: string[] = [];
  if (!existing.visitorId) setCookies.push(setCookie(VISITOR_COOKIE, visitorId, VISITOR_MAX_AGE));
  setCookies.push(setCookie(SESSION_COOKIE, sessionId, SESSION_MAX_AGE));
  return { visitorId, sessionId, setCookies };
}
