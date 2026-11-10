/** Used only after an explicitly enabled, successful production deployment. */
export function purgeSettings(env) {
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ZONE_ID || '') || !env.CLOUDFLARE_API_TOKEN) throw new Error('Configure the production zone ID and scoped API token before deploying with cache purge.');
  return { zone: env.CLOUDFLARE_ZONE_ID, token: env.CLOUDFLARE_API_TOKEN };
}
export async function purgeAfterDeploy(env, fetcher = globalThis.fetch) {
  const { zone, token } = purgeSettings(env);
  const response = await fetcher(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ purge_everything: true }), redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Deployment succeeded, but the following cache purge failed. Check Cloudflare before claiming the new SSR content is live.'); }
  const data = await response.json();
  if (data?.success !== true) throw new Error('Deployment succeeded, but Cloudflare did not confirm cache purge success.');
}
