import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: process.env.SITE_URL || 'https://example.workers.dev',
  output: 'server',
  trailingSlash: 'always',
  adapter: cloudflare({ imageService: 'passthrough' }),
  session: false,
  build: { inlineStylesheets: 'never' },
  vite: { environments: { client: { build: { cssCodeSplit: false } } } },
});
