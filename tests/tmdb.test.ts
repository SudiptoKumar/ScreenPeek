import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { TmdbClient, TmdbError, tmdbFromEnv } from '../sync/tmdb.ts';
import type { DiscoveryList, MediaType, TmdbClientOptions } from '../sync/tmdb.ts';

const testToken = 'test-only-bearer-value';
const testKey = 'test-only-v3-value';
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
});
const fakeFetch = (handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  async (input, init) => handler(new URL(input instanceof Request ? input.url : String(input)), init);
const client = (options: Partial<TmdbClientOptions> = {}) => new TmdbClient({ token: testToken, ...options });

test('Bearer authentication takes precedence over v3; requests stay English and cannot follow redirects', async () => {
  const instance = client({ apiKey: testKey, fetch: fakeFetch((url, init) => {
    assert.equal(url.origin, 'https://api.themoviedb.org');
    assert.equal(url.pathname, '/3/movie/42');
    assert.equal(url.searchParams.get('language'), 'en-US');
    assert.equal(url.searchParams.has('api_key'), false);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${testToken}`);
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/json');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    return json({ id: 42 });
  }) });
  assert.deepEqual(await instance.details('movie', 42), { id: 42 });
});

test('v3 API key is used only when a Bearer token is absent', async () => {
  const instance = client({ token: ' ', apiKey: testKey, fetch: fakeFetch((url, init) => {
    assert.equal(url.searchParams.get('api_key'), testKey);
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return json({ id: 7 });
  }) });
  assert.deepEqual(await instance.person(7), { id: 7 });
});

test('movie and TV details request their bundled metadata in one request each', async () => {
  const calls: URL[] = [];
  const instance = client({ fetch: fakeFetch(url => { calls.push(url); return json({}); }) });
  await instance.details('movie', 1);
  await instance.details('tv', 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get('append_to_response'), 'credits,videos,watch/providers,similar,release_dates,images');
  assert.equal(calls[1].searchParams.get('append_to_response'), 'credits,videos,watch/providers,similar,content_ratings,images');
  assert.equal(calls[1].pathname, '/3/tv/2');
});

test('changes and every discovery list preserve the caller’s pagination', async () => {
  const calls: URL[] = [];
  const instance = client({ fetch: fakeFetch(url => {
    calls.push(url);
    return json({ page: Number(url.searchParams.get('page')), total_pages: 3, results: [{ id: 12 }] });
  }) });
  for (const type of ['movie', 'tv', 'person'] as const) {
    const result = await instance.changes(type, '2026-11-08', '2026-11-09', 2);
    assert.equal(result.page, 2);
    assert.deepEqual(result.results, [{ id: 12 }]);
  }
  for (const list of ['trending', 'now_playing', 'upcoming', 'on_the_air', 'airing_today'] as const) {
    assert.equal((await instance.discovery(list, 3)).page, 3);
  }
  assert.deepEqual(calls.map(url => url.pathname), [
    '/3/movie/changes', '/3/tv/changes', '/3/person/changes', '/3/trending/all/day',
    '/3/movie/now_playing', '/3/movie/upcoming', '/3/tv/on_the_air', '/3/tv/airing_today',
  ]);
  assert.equal(calls[0].searchParams.get('start_date'), '2026-11-08');
  assert.equal(calls[0].searchParams.get('end_date'), '2026-11-09');
});

test('seasons include season zero and custom source bases retain their prefix', async () => {
  const calls: URL[] = [];
  const instance = client({ baseUrl: 'https://source.example/v3', fetch: fakeFetch(url => {
    calls.push(url); return json({});
  }) });
  await instance.season(99, 0);
  await instance.person(123);
  assert.equal(calls[0].href, 'https://source.example/v3/tv/99/season/0?language=en-US');
  assert.equal(calls[1].pathname, '/v3/person/123');
});

test('the default cap keeps at most five requests active until their bodies finish', async () => {
  const releases: Array<() => void> = [];
  let started = 0, active = 0, maximum = 0, completed = 0;
  const instance = client({ fetch: fakeFetch(() => {
    const id = ++started;
    active++;
    maximum = Math.max(maximum, active);
    const ready = new Promise<void>(resolve => releases.push(resolve));
    return new Response(new ReadableStream({
      async start(controller) {
        await ready;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ id })));
        controller.close();
        active--;
      },
    }), { headers: { 'Content-Type': 'application/json' } });
  }) });
  const requests = Array.from({ length: 12 }, (_, i) => instance.details('movie', i + 1).then(value => {
    completed++; return value;
  }));
  try {
    await nextTurn();
    assert.equal(started, 5, 'queued calls must not start while five response bodies remain unread');
    for (let wave = 0; wave < 20 && completed < 12; wave++) {
      releases.splice(0).forEach(release => release());
      await nextTurn();
    }
    assert.equal((await Promise.all(requests)).length, 12);
    assert.equal(maximum, 5);
    assert.equal(active, 0);
  } finally {
    releases.splice(0).forEach(release => release());
  }
});

test('429 Retry-After seconds and exponential delays are both honoured', async () => {
  const delays: number[] = [];
  let requests = 0;
  const instance = client({ maxRetries: 2, sleep: async ms => { delays.push(ms); }, fetch: fakeFetch(() => {
    requests++;
    if (requests === 1) return json({}, 429, { 'Retry-After': '3' });
    if (requests === 2) return json({}, 429, { 'Retry-After': '0' });
    return json({ id: 1 });
  }) });
  await instance.details('movie', 1);
  assert.deepEqual(delays, [3000, 2000]);
  assert.equal(requests, 3);
});

test('429 HTTP-date Retry-After uses the injected clock', async () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0);
  const delays: number[] = [];
  let requests = 0;
  const instance = client({ now: () => now, sleep: async ms => { delays.push(ms); }, fetch: fakeFetch(() =>
    ++requests === 1 ? json({}, 429, { 'Retry-After': new Date(now + 7000).toUTCString() }) : json({}),
  ) });
  await instance.person(1);
  assert.deepEqual(delays, [7000]);
});

test('429 retry exhaustion returns a typed error after the configured number of attempts', async () => {
  const delays: number[] = [];
  let requests = 0;
  const instance = client({ maxRetries: 2, sleep: async ms => { delays.push(ms); }, fetch: fakeFetch(() => {
    requests++; return json({ message: testToken }, 429);
  }) });
  await assert.rejects(() => instance.person(1), error => {
    assert.ok(error instanceof TmdbError);
    assert.equal(error.status, 429);
    assert.equal(error.message.includes(testToken), false);
    return true;
  });
  assert.equal(requests, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test('network and server failures retry with backoff and invalid Retry-After falls back safely', async () => {
  const delays: number[] = [];
  let requests = 0;
  const instance = client({ sleep: async ms => { delays.push(ms); }, fetch: fakeFetch(() => {
    requests++;
    if (requests === 1) throw new TypeError(`failed URL with ${testToken}`);
    if (requests === 2) return json({}, 503, { 'Retry-After': 'invalid-date' });
    return json({ id: 1 });
  }) });
  assert.deepEqual(await instance.person(1), { id: 1 });
  assert.deepEqual(delays, [1000, 2000]);
});

test('401 is never retried and errors cannot echo the URL, key, or response body', async () => {
  let requests = 0;
  const instance = client({ token: '', apiKey: testKey, sleep: async () => { assert.fail('401 must not retry'); }, fetch: fakeFetch(url => {
    requests++; return json({ message: `${url.href} ${testToken}` }, 401);
  }) });
  await assert.rejects(() => instance.person(1), error => {
    assert.ok(error instanceof TmdbError);
    assert.equal(error.status, 401);
    assert.equal(error.message, 'TMDb request failed (HTTP 401)');
    assert.equal(error.stack?.includes(testKey), false);
    assert.equal(error.stack?.includes(testToken), false);
    return true;
  });
  assert.equal(requests, 1);
});

test('terminal network errors are redacted and maxRetries zero makes exactly one attempt', async () => {
  let requests = 0;
  const instance = client({ maxRetries: 0, fetch: fakeFetch(() => {
    requests++; throw new Error(`network exposed ${testKey}`);
  }) });
  await assert.rejects(() => instance.person(1), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /network request failed/);
    assert.equal(error.stack?.includes(testKey), false);
    return true;
  });
  assert.equal(requests, 1);
});

test('malformed successful JSON produces a safe failure instead of silently accepting data', async () => {
  const instance = client({ fetch: fakeFetch(() => new Response(`invalid ${testToken}`)) });
  await assert.rejects(() => instance.person(1), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /invalid JSON/);
    assert.equal(error.message.includes(testToken), false);
    return true;
  });
});

test('image requests use the configured CDN and never send API authentication', async () => {
  const instance = client({ apiKey: testKey, imageBaseUrl: 'https://media.example/images', fetch: fakeFetch((url, init) => {
    assert.equal(url.href, 'https://media.example/images/w300/poster-name.jpg');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    assert.equal(url.searchParams.has('api_key'), false);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
  }) });
  assert.deepEqual(await instance.image('/poster-name.jpg', 'w300'), new Uint8Array([1, 2, 3]));
});

test('non-image responses are rejected by the image downloader', async () => {
  const instance = client({ fetch: fakeFetch(() => json({ unexpected: true })) });
  await assert.rejects(() => instance.image('/poster.jpg'), /not an image/);
});

test('constructor rejects missing credentials, unsafe source bases, and invalid retry or concurrency limits', () => {
  assert.throws(() => new TmdbClient({ token: ' ', apiKey: '' }), /TMDB_READ_TOKEN or TMDB_API_KEY/);
  for (const baseUrl of ['http://source.example/', 'https://user:pass@source.example/', 'https://source.example/?key=x', 'https://source.example/#fragment']) {
    assert.throws(() => client({ baseUrl }), /HTTPS|credentials|query/);
    assert.throws(() => client({ imageBaseUrl: baseUrl }), /HTTPS|credentials|query/);
  }
  for (const concurrency of [0, 6, 1.5, NaN]) assert.throws(() => client({ concurrency }), /concurrency/);
  for (const maxRetries of [-1, 9, 1.5]) assert.throws(() => client({ maxRetries }), /maxRetries/);
  for (const timeoutMs of [0, -1, 1.5]) assert.throws(() => client({ timeoutMs }), /timeout/);
  assert.ok(tmdbFromEnv({ TMDB_READ_TOKEN: testToken }) instanceof TmdbClient);
});

test('invalid IDs, pagination, seasons, enums, dates, and image paths are rejected before fetching', async () => {
  let fetched = false;
  const instance = client({ fetch: fakeFetch(() => { fetched = true; return json({}); }) });
  for (const id of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(async () => instance.details('movie', id));
    await assert.rejects(async () => instance.person(id));
  }
  for (const page of [0, -1, 1.5]) await assert.rejects(async () => instance.discovery('trending', page));
  for (const season of [-1, 1.5]) await assert.rejects(async () => instance.season(1, season));
  await assert.rejects(async () => instance.details('person' as MediaType, 1));
  await assert.rejects(async () => instance.changes('invalid' as MediaType, '2026-11-08', '2026-11-09'));
  await assert.rejects(async () => instance.discovery('__proto__' as DiscoveryList));
  for (const date of ['2026/11/09', '2026-02-30']) await assert.rejects(async () => instance.changes('movie', date, '2026-11-09'));
  await assert.rejects(async () => instance.changes('movie', '2026-11-09', '2026-11-08'));
  for (const path of ['/../secret.jpg', '/image.svg', 'poster.jpg', '/poster.jpg?key=x']) await assert.rejects(() => instance.image(path));
  await assert.rejects(() => instance.image('/poster.jpg', '../..' as 'w500'));
  assert.equal(fetched, false);
});
