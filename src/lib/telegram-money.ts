/**
 * Always-on refresh path for the @TrafeeUpdatebot money widget.
 *
 * The widget's Refresh button makes Telegram deliver a `widget_query`
 * update to /telegram/money-webhook; this module rebuilds the widget's
 * chat_data live from Adsterra's Publisher API and pushes it back with
 * editMessageWidgetData + answerWidgetQuery. The numbers mirror
 * scripts/money_check.py (same stats calls, same D1 config keys, same
 * milestone ladder, same chat_data keys) so the 30-minute checker and
 * this live refresh never disagree.
 */
export interface TelegramMoneyEnvironment {
  DB: D1Database;
  ADSTERRA_API_TOKEN?: string;
  MONEY_BOT_TOKEN?: string;
  MONEY_BOT_CHAT_ID?: string;
}

export interface WidgetChatData {
  revenue: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  month_revenue: number;
  month_impressions: number;
  earned: number;
  balance: number;
  milestone: number;
  payout_target: number;
  trend: number[];
  updated: string;
}

export interface WidgetQuery {
  id: string;
  data?: string;
  message?: { message_id?: number; chat?: { id?: number | string } };
}

const DOMAIN_ID = 6190252; // screenpeek.screenpeek.workers.dev
const EPOCH = '2026-11-01'; // first possible stats day (site added 2026-11-10)
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const ADSTERRA_API = 'https://api3.adsterratools.com/publisher';
const TELEGRAM_API = 'https://api.telegram.org';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface StatsItem {
  date?: unknown;
  impression?: unknown;
  clicks?: unknown;
  ctr?: unknown;
  cpm?: unknown;
  revenue?: unknown;
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const int = (value: unknown): number => Math.trunc(num(value));

async function adsterraStats(env: TelegramMoneyEnvironment, params: Record<string, string>, fetcher: typeof fetch): Promise<StatsItem[]> {
  const query = new URLSearchParams(params);
  const response = await fetcher(`${ADSTERRA_API}/stats.json?${query}`, {
    headers: { 'X-API-Key': env.ADSTERRA_API_TOKEN as string, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Adsterra stats failed: HTTP ${response.status}`);
  const data: unknown = await response.json();
  const items = (data as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as StatsItem[]) : [];
}

async function readMoneyConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM config WHERE key=?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/** Same rendering as money_check.py's strftime("%b %d · %H:%M UTC"). */
function formatUpdated(now: Date): string {
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[now.getUTCMonth()]} ${day} · ${hours}:${minutes} UTC`;
}

/**
 * Rebuild the widget chat_data from exactly two sequential Adsterra stats
 * calls (the API rate-limits simultaneous requests, so never parallelise):
 * the current UTC month grouped by date, then all-time totals since EPOCH.
 */
export async function buildWidgetChatData(env: TelegramMoneyEnvironment, now = new Date(), fetcher: typeof fetch = fetch): Promise<WidgetChatData> {
  if (!env.ADSTERRA_API_TOKEN) throw new Error('ADSTERRA_API_TOKEN is not configured');
  const today = now.toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const daily = await adsterraStats(env, { domain: String(DOMAIN_ID), start_date: monthStart, finish_date: today, 'group_by[]': 'date' }, fetcher);
  const totals = await adsterraStats(env, { domain: String(DOMAIN_ID), start_date: EPOCH, finish_date: today }, fetcher);

  const todayRow = daily.find(item => item.date === today);
  let monthRevenue = 0;
  let monthImpressions = 0;
  for (const item of daily) {
    monthRevenue += num(item.revenue);
    monthImpressions += int(item.impression);
  }
  // money_check.py: last 7 stored days, oldest first, zero-padded in front.
  const trend = [...daily]
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
    .slice(0, 7)
    .map(item => num(item.revenue))
    .reverse();
  while (trend.length < 7) trend.unshift(0);
  const earned = totals.reduce((sum, item) => sum + num(item.revenue), 0);

  const paid = Number.parseFloat((await readMoneyConfig(env.DB, 'money_paid_modeled')) ?? '0') || 0;
  const parsedMin = Number.parseFloat((await readMoneyConfig(env.DB, 'payout_min_usd')) ?? '');
  const payoutMin = Number.isFinite(parsedMin) && parsedMin > 0 ? parsedMin : 100;

  return {
    revenue: num(todayRow?.revenue),
    impressions: int(todayRow?.impression),
    clicks: int(todayRow?.clicks),
    ctr: num(todayRow?.ctr),
    cpm: num(todayRow?.cpm),
    month_revenue: monthRevenue,
    month_impressions: monthImpressions,
    earned,
    balance: earned - paid,
    milestone: MILESTONES.find(milestone => milestone > earned) ?? MILESTONES[MILESTONES.length - 1] * 2,
    payout_target: payoutMin,
    trend,
    updated: formatUpdated(now),
  };
}

export function serializeWidgetChatData(data: WidgetChatData): string {
  return JSON.stringify(data);
}

async function telegram(env: TelegramMoneyEnvironment, method: string, payload: Record<string, unknown>, fetcher: typeof fetch): Promise<void> {
  try {
    const response = await fetcher(`${TELEGRAM_API}/bot${env.MONEY_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    const out = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!out?.ok) {
      const description = out?.description || `HTTP ${response.status}`;
      // Re-applying identical data is a successful no-op for the widget.
      if (method === 'editMessageWidgetData' && /not modified/i.test(description)) return;
      console.error(`telegram ${method} failed:`, description);
    }
  } catch (error) {
    console.error(`telegram ${method} error:`, error);
  }
}

/**
 * Answer one Refresh tap on the owner's widget card: rebuild the numbers,
 * edit the card in place, then acknowledge the query (Telegram expects the
 * answer within about 15 seconds). Queries from any other chat are ignored.
 */
export async function handleWidgetQuery(env: TelegramMoneyEnvironment, query: WidgetQuery, fetcher: typeof fetch = fetch): Promise<void> {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (chatId === undefined || messageId === undefined) return;
  if (!env.MONEY_BOT_TOKEN || !env.MONEY_BOT_CHAT_ID) return;
  if (String(chatId) !== env.MONEY_BOT_CHAT_ID) return;
  try {
    const data = await buildWidgetChatData(env, new Date(), fetcher);
    await telegram(env, 'editMessageWidgetData', { chat_id: chatId, message_id: messageId, chat_data: serializeWidgetChatData(data) }, fetcher);
  } catch (error) {
    console.error('widget refresh failed:', error);
  }
  await telegram(env, 'answerWidgetQuery', { widget_query_id: query.id }, fetcher);
}
