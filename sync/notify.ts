import type { SyncSummary } from './log.ts';

/** Owner-only failure alerts. Successful runs and unconfigured alerts stay silent. */
export async function notifyFailure(
  environment: Record<string, string | undefined>,
  summary: SyncSummary,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ sent: boolean; warning: string | null }> {
  if (summary.status === 'ok' || (summary.status === 'partial' && summary.errors.length === 0)) {
    return { sent: false, warning: null };
  }
  const token = environment.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = environment.OWNER_CHAT_ID?.trim();
  if (!token || !chatId) return { sent: false, warning: null };
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token) || !/^-?[1-9]\d{0,19}$/.test(chatId)) {
    return { sent: false, warning: 'Telegram failure alert configuration is invalid' };
  }

  // Do not copy arbitrary upstream error strings into another service: their
  // count and the admin Sync view provide context without risking secret echoes.
  const text = [
    `ScreenPeek sync ${summary.status}`,
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    `Source: ${summary.source}`,
    `Added: ${summary.added}; updated: ${summary.updated}; errors: ${summary.errors.length}`,
    'Open admin Sync for details.',
  ].join('\n');
  const warning = 'Telegram failure alert could not be sent';
  try {
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { sent: false, warning };
    }
    const result = await response.json() as { ok?: boolean } | null;
    return result?.ok === true ? { sent: true, warning: null } : { sent: false, warning };
  } catch {
    // Telegram transport errors can contain the token-bearing URL. Never echo it.
    return { sent: false, warning };
  }
}
