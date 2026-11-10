/// <reference types="astro/client" />
interface ScreenPeekBindings {
  DB: D1Database;
  CONFIG: KVNamespace;
  POSTERS: R2Bucket;
  BACKUPS?: R2Bucket;
  SITE_NAME?: string;
  SITE_URL?: string;
  DEPLOYMENT_ENV?: string;
  ADS_ENABLED?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_ACTIONS_TOKEN?: string;
  R2_PUBLIC_BASE?: string;
  ASSETS: Fetcher;
}
interface Env extends ScreenPeekBindings {}
declare namespace Cloudflare {
  interface Env extends ScreenPeekBindings {}
}
type Runtime = import('@astrojs/cloudflare').Runtime;
declare namespace App {
  interface Locals extends Runtime {
    ads?: ReturnType<typeof import('./lib/ads').createAdResolver>;
    adTestAuthorized?: boolean;
    admin?: import('./lib/admin/access').AdminIdentity;
    adminFailure?: { status: number; message: string };
    siteConfig?: Promise<{ name: string; tagline: string; logo: string | null; google?: string | null; bing?: string | null; socials: Array<{ slug: string; name: string }>; cacheTtlList: number; cacheTtlDetail: number }>;
  }
}
