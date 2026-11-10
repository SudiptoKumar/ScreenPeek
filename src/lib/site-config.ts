import { readConfig } from './ads.ts';
import { readLink, linkActive } from './links.ts';
interface SiteEnvironment { DB: D1Database; CONFIG: KVNamespace; SITE_NAME?: string; }
export function siteConfig(locals: App.Locals, env: SiteEnvironment) {
  return locals.siteConfig ??= (async () => {
    const read = async (key: string) => { try { return await readConfig(env, key); } catch { return null; } };
    const [name, tagline, logo, socials, google, bing] = await Promise.all(['site_name', 'site_tagline', 'logo_r2', 'social_links', 'google_site_verification', 'bing_site_verification'].map(read));
    const links: Array<{ slug: string; name: string }> = [];
    for (const slug of (socials || '').split(',').map(value => value.trim()).filter(value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)).slice(0, 5)) {
      try { const link = await readLink(env.CONFIG, env.DB, slug); if (link && link.type === 'social' && linkActive(link)) links.push({ slug, name: link.name }); } catch { /* Omit unavailable links. */ }
    }
    return { name: name?.trim().slice(0, 100) || env.SITE_NAME || 'ScreenPeek', tagline: tagline?.trim().slice(0, 250) || '', logo, socials: links, google, bing };
  })();
}
