import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

/** Runtime-generated test credentials, never a production login bypass. */
export function accessFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID(), team = `fixture-${randomUUID().slice(0, 8)}.cloudflareaccess.com`, aud = 'local-test-audience';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const token = (email: string, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const encoded = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
    const value = `${encoded({ alg: 'RS256', kid, ...header })}.${encoded({ iss: `https://${team}`, aud: [aud], email, sub: 'local-fixture', iat: now, exp: now + 3600, ...claims })}`;
    return `${value}.${sign('RSA-SHA256', Buffer.from(value), privateKey).toString('base64url')}`;
  };
  const headers = (email: string) => ({ 'Cf-Access-Authenticated-User-Email': email, 'Cf-Access-Jwt-Assertion': token(email) });
  return { team, aud, jwk, token, headers, certUrl: `https://${team}/cdn-cgi/access/certs` };
}
