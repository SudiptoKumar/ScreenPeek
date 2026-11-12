// ScreenPeek Insight — UA / device / referrer parsing + client info.
//
// Honesty rules (PRD §3, gate G4): a value is stored only when the UA
// actually carries it. iPhone model is ALWAYS empty (the UA never names
// it — never guessed). Reduced/frozen UA values are stored as-is, never
// "corrected". Estimates stay labelled at the UI layer.

export interface ParsedUa {
  browser: string;
  browserMajor: string;
  os: string;
  osVersion: string;
  deviceType: 'mobile' | 'tablet' | 'desktop' | 'bot' | '';
  deviceBrand: string;
  deviceModel: string;
  isBotUa: boolean;
}

const BOT_PATTERN = /googlebot|bingbot|duckduckbot|yandexbot|baiduspider|slurp|facebookexternalhit|telegrambot|twitterbot|whatsapp|bot\b|crawler|spider|headlesschrome|lighthouse/i;

const majorOf = (ua: string, pattern: RegExp) => ua.match(pattern)?.[1]?.split('.')[0] ?? '';

export function parseUserAgent(rawUa: string): ParsedUa {
  const ua = rawUa || '';
  const isBotUa = BOT_PATTERN.test(ua);
  const result: ParsedUa = { browser: '', browserMajor: '', os: '', osVersion: '', deviceType: '', deviceBrand: '', deviceModel: '', isBotUa };

  // Browser — order matters: vendor browsers carry Chrome/Safari tokens too.
  if (/SamsungBrowser\//.test(ua)) { result.browser = 'Samsung Internet'; result.browserMajor = majorOf(ua, /SamsungBrowser\/(\d+(?:\.\d+)?)/); }
  else if (/Edg(A|iOS)?\//.test(ua)) { result.browser = 'Edge'; result.browserMajor = majorOf(ua, /Edg(?:A|iOS)?\/(\d+(?:\.\d+)?)/); }
  else if (/OPR\/|Opera/.test(ua)) { result.browser = 'Opera'; result.browserMajor = majorOf(ua, /OPR\/(\d+(?:\.\d+)?)/); }
  else if (/YaBrowser\//.test(ua)) { result.browser = 'Yandex'; result.browserMajor = majorOf(ua, /YaBrowser\/(\d+(?:\.\d+)?)/); }
  else if (/Firefox\//.test(ua)) { result.browser = 'Firefox'; result.browserMajor = majorOf(ua, /Firefox\/(\d+(?:\.\d+)?)/); }
  else if (/Chrome\/|Chromium\//.test(ua)) { result.browser = 'Chrome'; result.browserMajor = majorOf(ua, /(?:Chrome|Chromium)\/(\d+(?:\.\d+)?)/); }
  else if (/Safari\//.test(ua)) { result.browser = 'Safari'; result.browserMajor = majorOf(ua, /Version\/(\d+(?:\.\d+)?)/) || majorOf(ua, /Safari\/(\d+(?:\.\d+)?)/); }

  // OS + device.
  const android = ua.match(/Android[ /](\d+(?:\.\d+)?)?/);
  if (/iPhone|iPad|iPod/.test(ua)) {
    result.os = 'iOS';
    result.osVersion = ua.match(/OS (\d+(?:_\d+)*)/)?.[1]?.replace(/_/g, '.') ?? '';
    result.deviceBrand = 'Apple';
    result.deviceModel = ''; // The UA never carries the model. Never guessed.
    result.deviceType = /iPad/.test(ua) ? 'tablet' : 'mobile';
  } else if (android) {
    result.os = 'Android';
    result.osVersion = android[1] ?? '';
    result.deviceType = /Mobile/.test(ua) ? 'mobile' : 'tablet';
    // Model token: "Android 14; SM-S918B)" / "Android 13; Pixel 7)". The
    // reduced UA freezes it to "K" — that is a placeholder, not a model.
    const token = ua.match(/Android [^;]+;\s*([^;)]+?)(?:\s+Build\/|\)|;)/)?.[1]?.trim() ?? '';
    if (token && token !== 'K' && !/^(Mobile|Tablet|Android)$/i.test(token)) {
      result.deviceModel = token;
      if (/^SM-/i.test(token)) result.deviceBrand = 'Samsung';
      else if (/Pixel/i.test(token)) result.deviceBrand = 'Google';
    }
  } else if (/Windows NT/.test(ua)) {
    result.os = 'Windows';
    result.osVersion = ua.match(/Windows NT (\d+\.\d+)/)?.[1] ?? '';
    result.deviceType = 'desktop';
  } else if (/Mac OS X/.test(ua)) {
    result.os = 'macOS';
    result.osVersion = ua.match(/Mac OS X (\d+(?:[._]\d+)*)/)?.[1]?.replace(/_/g, '.') ?? '';
    result.deviceType = /Mobile/.test(ua) ? 'mobile' : 'desktop';
  } else if (/Linux/.test(ua)) {
    result.os = 'Linux';
    result.deviceType = /Mobile/.test(ua) ? 'mobile' : 'desktop';
  }
  if (isBotUa) result.deviceType = 'bot';
  if (!result.deviceType) result.deviceType = 'desktop';
  return result;
}

export type ReferrerClass = 'search' | 'social' | 'internal' | 'direct' | 'external' | '';

const SEARCH_HOSTS = /(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu|ecosia|startpage)\./i;
const SOCIAL_HOSTS = /(^|\.)(t\.me|telegram\.org|facebook\.com|fb\.com|twitter\.com|x\.com|instagram\.com|reddit\.com|linkedin\.com|youtube\.com|whatsapp\.com|pinterest\.com|tiktok\.com)$/i;

export function classifyReferrer(referrer: string, siteHost: string): { domain: string; cls: ReferrerClass } {
  if (!referrer) return { domain: '', cls: 'direct' };
  let url: URL;
  try { url = new URL(referrer); } catch { return { domain: '', cls: 'external' }; }
  const host = url.hostname.toLowerCase();
  const domain = host.replace(/^www\./, '');
  if (siteHost && (host === siteHost.toLowerCase() || host.endsWith(`.${siteHost.toLowerCase()}`))) return { domain, cls: 'internal' };
  if (SEARCH_HOSTS.test(host)) return { domain, cls: 'search' };
  if (SOCIAL_HOSTS.test(host)) return { domain, cls: 'social' };
  return { domain, cls: 'external' };
}

export interface ClientInfo {
  ip: string;
  country: string;
  region: string;
  city: string;
  continent: string;
  postalCode: string;
  lat: number | null;
  lon: number | null;
  ipTimezone: string;
  asn: number | null;
  asOrg: string;
  httpProtocol: string;
  tlsVersion: string;
  trustScore: number | null;
}

interface CfShape {
  country?: string; region?: string; city?: string; continent?: string; postalCode?: string;
  latitude?: string; longitude?: string; timezone?: string; asn?: number; asOrganization?: string;
  httpProtocol?: string; tlsVersion?: string; clientTrustScore?: number;
}

/** NULL-safe client info from request.cf (docs/01 geo seam). */
export function clientInfo(request: Request): ClientInfo {
  const cf = (request as Request & { cf?: CfShape }).cf;
  const num = (value: string | undefined) => {
    const parsed = Number(value);
    return value !== undefined && Number.isFinite(parsed) ? parsed : null;
  };
  return {
    ip: request.headers.get('CF-Connecting-IP') || '',
    country: cf?.country || request.headers.get('CF-IPCountry') || '',
    region: cf?.region || '',
    city: cf?.city || '',
    continent: cf?.continent || '',
    postalCode: cf?.postalCode || '',
    lat: num(cf?.latitude),
    lon: num(cf?.longitude),
    ipTimezone: cf?.timezone || '',
    asn: typeof cf?.asn === 'number' ? cf.asn : null,
    asOrg: cf?.asOrganization || '',
    httpProtocol: cf?.httpProtocol || '',
    tlsVersion: cf?.tlsVersion || '',
    trustScore: typeof cf?.clientTrustScore === 'number' ? cf.clientTrustScore : null,
  };
}

/** Apply the configured IP mode at insert time (G3.7). */
export function maskIp(ip: string, mode: 'full' | 'masked' | 'off'): string {
  if (!ip || mode === 'off') return '';
  if (mode === 'full') return ip;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : ip;
  }
  const groups = ip.split(':');
  return groups.length > 2 ? `${groups.slice(0, 3).join(':')}::` : ip;
}
