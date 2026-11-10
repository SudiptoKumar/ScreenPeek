export const supportedCountries = ['US', 'GB', 'CA', 'AU'] as const;
export const countryNames: Record<string, string> = { US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia' };
export function requestCountry(request: Request) {
  const selected = new URL(request.url).searchParams.get('country');
  const cookie = request.headers.get('Cookie')?.match(/(?:^|;\s*)country=(US|GB|CA|AU)(?:;|$)/)?.[1];
  const cf = (request as Request & { cf?: { country?: string } }).cf?.country;
  const value = selected || cookie || cf || request.headers.get('CF-IPCountry') || 'US';
  return supportedCountries.includes(value as typeof supportedCountries[number]) ? value : 'US';
}
export const countryCookie = (country: string) => `country=${country}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;
