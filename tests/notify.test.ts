import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyFailure } from '../sync/notify.ts';
import type { SyncSummary } from '../sync/log.ts';

const token = '123456789:test_only_secret_token_123456789';
const environment = { TELEGRAM_BOT_TOKEN: token, OWNER_CHAT_ID: '12345678' };
const summary: SyncSummary = {
  status: 'failed', source: 'cron', startedAt: '2026-11-09T08:30:00.000Z',
  finishedAt: '2026-11-09T08:31:00.000Z', added: 12, updated: 3, errors: ['Source request failed'],
};

test('failure alert sends plain JSON only to Telegram with previews and redirects disabled', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.telegram.org');
    assert.equal(url.pathname, `/bot${token}/sendMessage`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.chat_id, environment.OWNER_CHAT_ID);
    assert.equal(body.link_preview_options.is_disabled, true);
    assert.equal(body.parse_mode, undefined);
    assert.match(body.text, /sync failed/);
    assert.match(body.text, /Added: 12; updated: 3; errors: 1/);
    assert.equal(body.text.includes(token), false);
    return Response.json({ ok: true });
  };
  assert.deepEqual(await notifyFailure(environment, summary, fetcher), { sent: true, warning: null });
  assert.equal(calls, 1);
});

test('successful runs, empty partial runs, and missing configuration remain silent', async () => {
  const noFetch: typeof fetch = async () => { assert.fail('skipped alerts must not access the network'); };
  for (const env of [{}, { TELEGRAM_BOT_TOKEN: token }, { OWNER_CHAT_ID: '12345678' }]) {
    assert.deepEqual(await notifyFailure(env, summary, noFetch), { sent: false, warning: null });
  }
  assert.deepEqual(await notifyFailure(environment, { ...summary, status: 'ok' }, noFetch), { sent: false, warning: null });
  assert.deepEqual(await notifyFailure(environment, { ...summary, status: 'partial', errors: [] }, noFetch), { sent: false, warning: null });
});

test('partial runs with errors alert the owner without forwarding arbitrary error messages', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++;
    const body = JSON.parse(init?.body as string);
    assert.match(body.text, /sync partial/);
    assert.match(body.text, /errors: 1/);
    assert.equal(body.text.includes(token), false);
    return Response.json({ ok: true });
  };
  assert.deepEqual(await notifyFailure(environment, { ...summary, status: 'partial', errors: [`provider echoed ${token}`] }, fetcher),
    { sent: true, warning: null });
  assert.equal(calls, 1);
});

test('invalid token or chat configuration cannot alter the destination or path', async () => {
  const noFetch: typeof fetch = async () => { assert.fail('invalid configuration must not fetch'); };
  for (const env of [
    { ...environment, TELEGRAM_BOT_TOKEN: `${token}/../../other` },
    { ...environment, TELEGRAM_BOT_TOKEN: 'https://other.example/token' },
    { ...environment, OWNER_CHAT_ID: '12345\nother' },
  ]) {
    assert.deepEqual(await notifyFailure(env, summary, noFetch),
      { sent: false, warning: 'Telegram failure alert configuration is invalid' });
  }
});

test('transport, HTTP, and Telegram-level failures return a redacted warning without throwing', async () => {
  const fetchers: Array<typeof fetch> = [
    async () => { throw new Error(`request failed https://api.telegram.org/bot${token}/sendMessage`); },
    async () => new Response(`upstream echoed ${token}`, { status: 403 }),
    async () => Response.json({ ok: false, description: `upstream echoed ${token}` }),
    async () => new Response('not JSON'),
  ];
  for (const fetcher of fetchers) {
    assert.deepEqual(await notifyFailure(environment, summary, fetcher),
      { sent: false, warning: 'Telegram failure alert could not be sent' });
  }
});
