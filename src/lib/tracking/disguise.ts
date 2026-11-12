/**
 * ScreenPeek Insight — disguise / consistency score (F16, docs/04).
 *
 * A whoer-STYLE consistency score: it starts at 100 and subtracts for
 * signals that disagree with each other (browser timezone vs IP country,
 * WebRTC IP vs connection IP, datacentre ASN, and so on). It is a
 * consistency score only — the admin never presents it as a whoer score
 * or as proof of anything; it only flags rows for a human to look at.
 * Flag-only: nothing is blocked or rerouted by this score (the F21
 * quality gate is separate and ships disabled).
 */
import { tzToCountry } from './quality.ts';

export interface DisguiseSignals {
  /** Browser timezone (from the beacon session) disagrees with the IP country. */
  tzMismatch?: boolean;
  /** Primary browser language points at a different country than the IP. */
  languageMismatch?: boolean;
  /** WebRTC-reported IP differs from the connection IP. */
  webrtcMismatch?: boolean;
  connClass?: string;
  trustScore?: number | null;
  blacklisted?: boolean;
  /** Client-Hints platform disagrees with the user-agent OS. */
  uaChIncoherent?: boolean;
}

export interface DisguiseVerdict { score: number; band: string; label: string; reasons: string[] }

export const DISGUISE_DEFAULTS: Record<string, number> = {
  tz_mismatch: 25,
  language_mismatch: 15,
  webrtc_mismatch: 30,
  datacentre: 25,
  vpn_proxy: 15,
  trust_low: 20,
  blacklist: 20,
  ua_ch_incoherent: 10,
};

export function disguiseBand(score: number): { band: string; label: string } {
  if (score >= 90) return { band: 'regular', label: 'Looks like a regular local user' };
  if (score >= 70) return { band: 'mostly', label: 'Mostly consistent' };
  if (score >= 40) return { band: 'leaks', label: 'Disguised, with leaks' };
  return { band: 'obvious', label: 'Obvious proxy / bot setup' };
}

export function computeDisguise(signals: DisguiseSignals, weightsJson: string): DisguiseVerdict {
  let weights = { ...DISGUISE_DEFAULTS };
  try {
    const parsed = JSON.parse(weightsJson || '{}') as Record<string, unknown>;
    for (const key of Object.keys(DISGUISE_DEFAULTS)) if (typeof parsed[key] === 'number') weights[key] = parsed[key] as number;
  } catch { /* defaults apply */ }
  let score = 100;
  const reasons: string[] = [];
  const subtract = (key: string, reason: string) => { score -= weights[key]; reasons.push(reason); };
  if (signals.tzMismatch) subtract('tz_mismatch', 'Browser timezone does not match the IP country');
  if (signals.languageMismatch) subtract('language_mismatch', 'Browser language does not match the IP country');
  if (signals.webrtcMismatch) subtract('webrtc_mismatch', 'WebRTC IP differs from the connection IP');
  if (signals.connClass === 'datacentre') subtract('datacentre', 'Connection ASN looks like a datacentre');
  if (signals.connClass === 'vpn' || signals.connClass === 'proxy') subtract('vpn_proxy', 'Connection looks like a VPN or proxy');
  if (typeof signals.trustScore === 'number' && signals.trustScore < 30) subtract('trust_low', 'Platform trust score under 30');
  if (signals.blacklisted) subtract('blacklist', 'IP appears on a blacklist (adapter)');
  if (signals.uaChIncoherent) subtract('ua_ch_incoherent', 'Client Hints platform disagrees with the user agent');
  score = Math.max(0, Math.min(100, score));
  const { band, label } = disguiseBand(score);
  return { score, band, label, reasons };
}

/** Primary language → the countries where it is the expected local language. */
const LANGUAGE_COUNTRIES: Record<string, string[]> = {
  en: ['US', 'GB', 'CA', 'AU', 'NZ', 'IE'],
  bn: ['BD'],
  hi: ['IN'],
  es: ['ES', 'MX', 'AR', 'CO', 'CL', 'PE'],
  fr: ['FR', 'BE', 'CA', 'CH'],
  de: ['DE', 'AT', 'CH'],
  pt: ['PT', 'BR'],
  ru: ['RU', 'UA', 'BY', 'KZ'],
  ar: ['EG', 'SA', 'AE', 'MA', 'DZ'],
  ur: ['PK'],
  ta: ['IN', 'LK', 'SG'],
  te: ['IN'],
  id: ['ID'],
  ms: ['MY'],
  th: ['TH'],
  vi: ['VN'],
  ja: ['JP'],
  ko: ['KR'],
  zh: ['CN', 'TW', 'HK', 'SG'],
};

/**
 * True when the primary language confidently maps to other countries
 * than the IP country. Unknown languages never flag — conservative by
 * design, like the timezone check.
 */
export function languageCountryMismatch(languages: string, country: string): boolean {
  const primary = (languages || '').split(',')[0].trim().toLowerCase().split('-')[0];
  const expected = LANGUAGE_COUNTRIES[primary];
  if (!expected || !country) return false;
  return !expected.includes(country.toUpperCase());
}

/** Browser-timezone country vs IP country (reuses the quality TZ map). */
export function browserTzMismatch(browserTimezone: string, country: string): boolean {
  const tzCountry = tzToCountry(browserTimezone || '');
  return Boolean(tzCountry && country && tzCountry !== country.toUpperCase());
}

/** Sec-CH-UA-Platform vs UA-parsed OS family. */
export function uaChIncoherent(platformHint: string, os: string): boolean {
  const hint = (platformHint || '').replace(/"/g, '').trim().toLowerCase();
  if (!hint || !os) return false;
  const family = (value: string) => value.includes('android') ? 'android'
    : value.includes('ios') || value.includes('iphone') || value.includes('ipad') ? 'ios'
    : value.includes('windows') ? 'windows'
    : value.includes('mac') ? 'macos'
    : value.includes('linux') ? 'linux' : '';
  const hintFamily = family(hint);
  const osFamily = family(os.toLowerCase());
  return Boolean(hintFamily && osFamily && hintFamily !== osFamily);
}
