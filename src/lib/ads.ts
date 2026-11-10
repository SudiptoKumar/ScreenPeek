// Every in-flow area is a STACK of up to three units: the base placement
// plus its `_b` and `_c` partners, so different ad networks can run in
// the same area (the extras render only when filled — no empty boxes).
// Stacking stops at three on purpose: more units slow the page and
// collapse click rates. There is deliberately NO second popunder
// placement: one popunder per visit, from one network, is the rule
// every network's terms and rates depend on.
export const adMap = {
  home: ['top_300x250', 'top_300x250_b', 'top_300x250_c', 'native', 'native_b', 'native_c', 'sticky_320x50'],
  list: ['native', 'native_b', 'native_c', 'infeed', 'infeed_b', 'infeed_c', 'sticky_320x50'],
  detail: ['top_300x250', 'top_300x250_b', 'top_300x250_c', 'native', 'native_b', 'native_c', 'sticky_320x50', 'popunder'],
  cast: ['top_300x250', 'top_300x250_b', 'top_300x250_c', 'native', 'native_b', 'native_c', 'sticky_320x50'],
  watch: ['top_300x250', 'top_300x250_b', 'top_300x250_c', 'native', 'native_b', 'native_c', 'sticky_320x50'],
  trailer: ['top_300x250', 'top_300x250_b', 'top_300x250_c', 'sticky_320x50'],
  search: ['native', 'native_b', 'native_c', 'sticky_320x50'],
  global: ['social_bar', 'inpage_push', 'interstitial', 'push_notifications'],
} as const;
export type AdPage = keyof typeof adMap;
export type AdPlacement = typeof adMap[AdPage][number];
export interface AdRecord {
  page_type: AdPage; placement: AdPlacement; code: string; enabled: number | boolean;
  deleted_at?: string | null; starts_at?: string | null; ends_at?: string | null; test_mode?: number | boolean;
}
interface AdEnvironment { DB: D1Database; CONFIG: KVNamespace; ADS_ENABLED?: string; }
export const adKey = (page: AdPage, placement: AdPlacement) => `ad:${page}:${placement}`;
export const adAllowed = (page: AdPage, placement: AdPlacement) => (adMap[page] as readonly string[]).includes(placement);
export function adActive(slot: AdRecord, now = new Date()) {
  if (slot.deleted_at) return false;
  if (!(slot.enabled === 1 || slot.enabled === true) || typeof slot.code !== 'string' || !slot.code.trim()) return false;
  for (const date of [slot.starts_at, slot.ends_at]) if (date && !Number.isFinite(Date.parse(date))) return false;
  return (!slot.starts_at || Date.parse(slot.starts_at) <= now.getTime()) && (!slot.ends_at || Date.parse(slot.ends_at) > now.getTime());
}
export async function readConfig(env: Pick<AdEnvironment, 'DB' | 'CONFIG'>, key: string): Promise<string | null> {
  try {
    const value = await env.CONFIG.get(`config:${key}`);
    if (value !== null) return value;
  } catch { /* Read-only D1 fallback. */ }
  return (await env.DB.prepare('SELECT value FROM config WHERE key=?').bind(key).first<{ value: string }>())?.value ?? null;
}
/** One resolver per request; no cross-request cache of owner-controlled switches. */
export function createAdResolver(env: AdEnvironment, authenticatedTest = false) {
  let settings: Promise<{ enabled: boolean; capHours: number }> | undefined;
  const formats = new Map<string, Promise<string | null>>();
  const slots = new Map<string, Promise<AdRecord | null>>();
  const loadSettings = () => settings ??= (async () => {
    const [master, cap] = await Promise.all([readConfig(env, 'ads_enabled'), readConfig(env, 'popunder_cap_hours')]);
    const hours = Number(cap);
    return { enabled: master === '1', capHours: Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : 24 };
  })();
  return {
    async resolve(page: AdPage, placement: AdPlacement, now = new Date()) {
      // The platform flag is an absolute preview kill switch. In particular,
      // ?adtest=1 is not authorization to load an owner's test snippet.
      if (env.ADS_ENABLED !== '1' || !adAllowed(page, placement)) return null;
      try {
        const config = await loadSettings();
        if (!config.enabled) return null;
        const basePlacement = placement.replace(/_[bc]$/, '');
        const format = basePlacement === 'popunder' ? 'popunder' : basePlacement === 'social_bar' ? 'social' : basePlacement === 'sticky_320x50' ? 'sticky' : basePlacement === 'inpage_push' ? 'push' : basePlacement === 'interstitial' ? 'interstitial' : basePlacement === 'push_notifications' ? 'notifications' : ['native','infeed'].includes(basePlacement) ? 'native' : 'display';
        const formatKey = `ads_${format}_enabled`;
        if (!formats.has(formatKey)) formats.set(formatKey, readConfig(env, formatKey));
        if (await formats.get(formatKey) === '0') return null;
        const key = adKey(page, placement);
        let result = slots.get(key);
        if (!result) {
          result = (async () => {
            try {
              const mirrored: unknown = await env.CONFIG.get(key, 'json');
              if (mirrored !== null) {
                if (!mirrored || typeof mirrored !== 'object' || Array.isArray(mirrored)) return null;
                const slot = mirrored as AdRecord;
                return slot.page_type === page && slot.placement === placement ? slot : null;
              }
            } catch { /* Read-only fallback when KV is unavailable. */ }
            return env.DB.prepare('SELECT page_type,placement,code,enabled,starts_at,ends_at,test_mode,deleted_at FROM ad_slots WHERE page_type=? AND placement=?').bind(page, placement).first<AdRecord>();
          })();
          slots.set(key, result);
        }
        const slot = await result;
        if (!slot || !adActive(slot, now) || ((slot.test_mode === 1 || slot.test_mode === true) && !authenticatedTest)) return null;
        return { code: slot.code, capHours: config.capHours };
      } catch { return null; }
    },
  };
}
export function requestAds(locals: App.Locals, env: AdEnvironment) {
  // adTestAuthorized is set only by verified Access middleware (task 1.19).
  return locals.ads ??= createAdResolver(env, locals.adTestAuthorized === true);
}
