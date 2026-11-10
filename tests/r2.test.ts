import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { R2Store } from '../sync/r2.ts';
import type { R2StoreOptions } from '../sync/r2.ts';

const accountId = '0123456789abcdef'.repeat(2);
const accessKeyId = 'test-only-access-id';
const secretAccessKey = 'test-only-secret-key';
const cacheControl = 'public, max-age=31536000, immutable';

const store = (fetcher: typeof fetch, options: Partial<R2StoreOptions> = {}) => new R2Store({
  accountId, bucket: 'posters', accessKeyId, secretAccessKey, fetch: fetcher, ...options,
});
const receive = (handler: (request: Request) => Response | Promise<Response>): typeof fetch => async input => {
  assert.ok(input instanceof Request, 'the transport must receive the signed Request');
  return handler(input);
};

// Independently verify the AWS4 HMAC instead of accepting a signature-shaped string.
function verifySignature(request: Request) {
  const authorization = request.headers.get('Authorization') || '';
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(authorization);
  assert.ok(match);
  assert.equal(match[1], accessKeyId);
  const [, , scope, signedHeaders, signature] = match;
  const url = new URL(request.url);
  const canonicalHeaders = signedHeaders.split(';').map(name =>
    `${name}:${(name === 'host' ? url.host : request.headers.get(name) || '').replace(/\s+/g, ' ')}`,
  ).join('\n');
  const canonicalRequest = [request.method, url.pathname, url.searchParams.toString(),
    `${canonicalHeaders}\n`, signedHeaders, request.headers.get('X-Amz-Content-Sha256')].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', request.headers.get('X-Amz-Date'), scope,
    createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  let signingKey: Uint8Array = new TextEncoder().encode(`AWS4${secretAccessKey}`);
  for (const component of scope.split('/')) signingKey = createHmac('sha256', signingKey).update(component).digest();
  assert.equal(signature, createHmac('sha256', signingKey).update(stringToSign).digest('hex'));
}

test('HEAD signs for the fixed R2 S3 endpoint and distinguishes an existing object', async () => {
  const instance = store(receive(request => {
    assert.equal(request.method, 'HEAD');
    assert.equal(request.url, `https://${accountId}.r2.cloudflarestorage.com/posters/poster/movie_42_w185.webp`);
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    const signature = request.headers.get('Authorization') || '';
    assert.match(signature, /^AWS4-HMAC-SHA256 /);
    assert.ok(signature.includes(`Credential=${accessKeyId}/`));
    assert.match(signature, /\/auto\/s3\/aws4_request/);
    assert.match(signature, /Signature=[a-f0-9]{64}$/);
    assert.match(request.headers.get('X-Amz-Date') || '', /^\d{8}T\d{6}Z$/);
    assert.equal(signature.includes(secretAccessKey), false);
    assert.equal(new URL(request.url).search, '');
    verifySignature(request);
    return new Response(null, { status: 200 });
  }));
  assert.equal(await instance.head('poster/movie_42_w185.webp'), true);
});

test('HEAD 404 returns false, while permission or service failures remain failures', async () => {
  for (const status of [404, 403, 500]) {
    const instance = store(receive(() => new Response(`provider echoed ${secretAccessKey}`, { status })));
    if (status === 404) assert.equal(await instance.head('poster/42.webp'), false);
    else await assert.rejects(() => instance.head('poster/42.webp'), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `R2 HEAD request failed (HTTP ${status})`);
      assert.equal(error.stack?.includes(secretAccessKey), false);
      return true;
    });
  }
});

test('PUT preserves bytes, image metadata, and immutable cache headers in a signed request', async () => {
  const bytes = new Uint8Array([1, 2, 3, 255]);
  const instance = store(receive(async request => {
    assert.equal(request.method, 'PUT');
    assert.equal(request.headers.get('Content-Type'), 'image/webp');
    assert.equal(request.headers.get('Cache-Control'), cacheControl);
    assert.match(request.headers.get('Authorization') || '', /SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date/);
    verifySignature(request);
    assert.deepEqual(new Uint8Array(await request.arrayBuffer()), bytes);
    return new Response(null, { status: 200 });
  }));
  await instance.put('poster/42_w185.webp', bytes, 'image/webp', cacheControl);
});

test('object path segments are encoded without changing the destination hostname', async () => {
  const instance = store(receive(request => {
    const url = new URL(request.url);
    assert.equal(url.hostname, `${accountId}.r2.cloudflarestorage.com`);
    assert.equal(url.pathname, '/posters/poster/title%20%23%3F%25%21.webp');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    return new Response(null, { status: 404 });
  }));
  assert.equal(await instance.head('poster/title #?%!.webp'), false);
});

test('unsafe account, bucket, and object paths are rejected before any request is signed or sent', async () => {
  let calls = 0;
  const fetcher = receive(() => { calls++; return new Response(null, { status: 200 }); });
  for (const id of ['bad', `${accountId}.evil.example`, `https://${accountId}`, '../account']) {
    assert.throws(() => store(fetcher, { accountId: id }), /account ID/);
  }
  for (const bucket of ['ab', '../posters', 'Posters', 'posters/other', 'posters.example', '-posters']) {
    assert.throws(() => store(fetcher, { bucket }), /bucket/);
  }
  assert.throws(() => store(fetcher, { accessKeyId: '' }), /R2_ACCESS_KEY_ID/);
  assert.throws(() => store(fetcher, { secretAccessKey: ' ' }), /R2_SECRET_ACCESS_KEY/);
  const instance = store(fetcher);
  for (const key of ['', '../poster.webp', 'poster/../secret', './poster.webp', '/poster.webp',
    'poster//file.webp', 'poster\\file.webp', 'poster/\u0000.webp', 'x'.repeat(1025)]) {
    await assert.rejects(() => instance.head(key), /object key/);
  }
  assert.equal(calls, 0);
});

test('transport exceptions and PUT errors never expose credentials or provider bodies', async () => {
  const offline = store(receive(() => { throw new Error(`Authorization ${accessKeyId} ${secretAccessKey}`); }));
  for (const operation of [() => offline.head('poster/42.webp'),
    () => offline.put('poster/42.webp', new Uint8Array([1]), 'image/webp', cacheControl)]) {
    await assert.rejects(operation, error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^R2 (HEAD|PUT) request failed before receiving a response$/);
      assert.equal(error.stack?.includes(accessKeyId), false);
      assert.equal(error.stack?.includes(secretAccessKey), false);
      return true;
    });
  }
  const rejected = store(receive(() => new Response(`provider echoed ${secretAccessKey}`, { status: 403 })));
  await assert.rejects(() => rejected.put('poster/42.webp', new Uint8Array([1]), 'image/webp', cacheControl),
    { message: 'R2 PUT request failed (HTTP 403)' });
});
