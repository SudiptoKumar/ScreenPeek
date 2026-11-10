import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWidgetChatData, handleWidgetQuery, serializeWidgetChatData, type TelegramMoneyEnvironment } from '../src/lib/telegram-money.ts';

const DAILY = [
  { date: '2026-12-03', impression: 120, clicks: 9, ctr: 7.5, cpm: 1.25, revenue: 1.5 },
  { date: '2026-12-01', impression: 10, clicks: 1, ctr: 10, cpm: 2.5, revenue: 0.25 },
  { date: '2026-12-02', impression: 20, clicks: 2, ctr: 10, cpm: 1, revenue: 0.5 },
];
const TOTALS = [{ impression: 9999, clicks: 321, ctr: 3.21, cpm: 1.5, revenue: 1234.5 }];

const fakeDb = (values: Record<string, string>) => ({
  prepare: () => ({
    bind: (key: string) => ({
      first: async () => (key in values ? { value: values[key] } : null),
    }),
  }),
}) as unknown as D1Database;

const fakeEnv = (values: Record<string, string> = { money_paid_modeled: '234.5' }): TelegramMoneyEnvironment => ({
  DB: fakeDb(values),
  ADSTERRA_API_TOKEN: 'test-token',
  MONEY_BOT_TOKEN: 'bot-token',
  MONEY_BOT_CHAT_ID: '555',
});

interface RecordedCall { url: string; init?: RequestInit }

function fixtureFetcher(calls: RecordedCall[], options: { editResult?: unknown; totals?: unknown[] } = {}) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('api3.adsterratools.com')) {
      return url.includes('group_by') ? Response.json({ items: DAILY }) : Response.json({ items: options.totals ?? TOTALS });
    }
    if (url.includes('editMessageWidgetData')) return Response.json(options.editResult ?? { ok: true, result: true });
    if (url.includes('answerWidgetQuery')) return Response.json({ ok: true, result: true });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

test('buildWidgetChatData mirrors money_check.py: two sequential stats calls, same keys and math', async () => {
  const calls: RecordedCall[] = [];
  const data = await buildWidgetChatData(fakeEnv(), new Date('2026-12-03T09:05:00Z'), fixtureFetcher(calls));

  // Exactly two Adsterra calls, month window first (grouped by date), then
  // all-time since the 2026-11-01 epoch; the API key rides the header.
  const stats = calls.filter(call => call.url.includes('api3.adsterratools.com'));
  assert.equal(stats.length, 2);
  assert.ok(stats[0].url.includes('start_date=2026-12-01'));
  assert.ok(stats[0].url.includes('group_by'));
  assert.ok(stats[1].url.includes('start_date=2026-11-01'));
  assert.ok(!stats[1].url.includes('group_by'));
  assert.equal((stats[0].init?.headers as Record<string, string>)['X-API-Key'], 'test-token');

  assert.deepEqual(data, {
    revenue: 1.5,
    impressions: 120,
    clicks: 9,
    ctr: 7.5,
    cpm: 1.25,
    month_revenue: 2.25,
    month_impressions: 150,
    earned: 1234.5,
    balance: 1000,
    milestone: 2500,
    payout_target: 100,
    trend: [0, 0, 0, 0, 0.25, 0.5, 1.5],
    updated: 'Dec 03 · 09:05 UTC',
  });
  assert.ok(new TextEncoder().encode(serializeWidgetChatData(data)).length <= 1024);
});

test('buildWidgetChatData honours payout_min_usd and the past-the-top milestone fallback', async () => {
  const calls: RecordedCall[] = [];
  const env = fakeEnv({ money_paid_modeled: '0', payout_min_usd: '250' });
  const data = await buildWidgetChatData(env, new Date('2026-12-03T09:05:00Z'), fixtureFetcher(calls, { totals: [{ revenue: 12000 }] }));
  assert.equal(data.earned, 12000);
  assert.equal(data.balance, 12000);
  assert.equal(data.milestone, 20000); // ladder top (10000) x 2, as in widget_chat_data
  assert.equal(data.payout_target, 250);
});

test('buildWidgetChatData fails loudly without an Adsterra token', async () => {
  const calls: RecordedCall[] = [];
  const env = fakeEnv();
  delete env.ADSTERRA_API_TOKEN;
  await assert.rejects(buildWidgetChatData(env, new Date(), fixtureFetcher(calls)), /ADSTERRA_API_TOKEN/);
  assert.equal(calls.length, 0);
});

test('handleWidgetQuery refreshes the owner card, then answers the query', async () => {
  const calls: RecordedCall[] = [];
  await handleWidgetQuery(fakeEnv(), { id: 'q1', data: 'refresh', chat: { id: 555 }, message_id: 38 }, fixtureFetcher(calls));
  const telegramCalls = calls.filter(call => call.url.includes('api.telegram.org'));
  assert.equal(telegramCalls.length, 2);
  assert.ok(telegramCalls[0].url.endsWith('/editMessageWidgetData'));
  assert.ok(telegramCalls[1].url.endsWith('/answerWidgetQuery'));
  const edit = JSON.parse(String(telegramCalls[0].init?.body));
  assert.equal(edit.chat_id, 555);
  assert.equal(edit.message_id, 38);
  assert.equal(JSON.parse(edit.chat_data).earned, 1234.5);
  assert.deepEqual(JSON.parse(String(telegramCalls[1].init?.body)), { widget_query_id: 'q1' });
});

test('handleWidgetQuery ignores other chats without any network call', async () => {
  const calls: RecordedCall[] = [];
  await handleWidgetQuery(fakeEnv(), { id: 'q2', data: 'refresh', chat: { id: 999 }, message_id: 38 }, fixtureFetcher(calls));
  assert.equal(calls.length, 0);
});

test('handleWidgetQuery still answers when Telegram reports the data as not modified', async () => {
  const calls: RecordedCall[] = [];
  const fetcher = fixtureFetcher(calls, { editResult: { ok: false, error_code: 400, description: 'Bad Request: message is not modified' } });
  await handleWidgetQuery(fakeEnv(), { id: 'q3', data: 'refresh', chat: { id: 555 }, message_id: 38 }, fetcher);
  assert.ok(calls.some(call => call.url.includes('answerWidgetQuery')));
});
