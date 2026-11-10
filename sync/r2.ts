import { AwsClient } from 'aws4fetch';
import type { ImageStore } from './posters.ts';

export interface R2StoreOptions {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof globalThis.fetch;
}

/** Sync-only S3 client. Credentials are signed for one fixed R2 account host. */
export class R2Store implements ImageStore {
  private readonly endpoint: string;
  private readonly signer: AwsClient;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: R2StoreOptions) {
    if (!/^[a-f0-9]{32}$/i.test(options.accountId)) throw new Error('R2 account ID must be 32 hexadecimal characters');
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error('Invalid R2 bucket name');
    if (typeof options.accessKeyId !== 'string' || !options.accessKeyId.trim() ||
        typeof options.secretAccessKey !== 'string' || !options.secretAccessKey.trim()) {
      throw new Error('Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY for sync');
    }
    this.endpoint = `https://${options.accountId.toLowerCase()}.r2.cloudflarestorage.com/${options.bucket}/`;
    this.signer = new AwsClient({
      accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey,
      service: 's3', region: 'auto',
    });
    this.fetcher = options.fetch || globalThis.fetch;
  }

  private objectUrl(key: string) {
    if (typeof key !== 'string' || !key || /[\\\u0000-\u001f\u007f]/.test(key) ||
        new TextEncoder().encode(key).length > 1024 ||
        key.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('Invalid R2 object key');
    }
    try {
      const path = key.split('/').map(segment => encodeURIComponent(segment)
        .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
      return new URL(path, this.endpoint);
    } catch {
      throw new Error('Invalid R2 object key');
    }
  }

  private async request(method: 'HEAD' | 'PUT' | 'GET', key: string, body?: Uint8Array, headers?: HeadersInit) {
    const url = this.objectUrl(key);
    try {
      // Sign explicitly so tests and the sync transport share the injected fetch.
      // Redirects must never forward the signed Authorization header elsewhere.
      const request = await this.signer.sign(url, {
        method, headers, body: body?.slice().buffer,
        redirect: 'error', signal: AbortSignal.timeout(30_000),
        aws: { allHeaders: true },
      });
      return await this.fetcher(request);
    } catch {
      // Network/provider errors can contain URLs or echo authentication headers.
      throw new Error(`R2 ${method} request failed before receiving a response`);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.request('GET', key);
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 10_000_000) { await response.body?.cancel(); throw new Error('R2 image read failed or exceeds its size bound'); }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 10_000_000) throw new Error('R2 image exceeds its size bound');
    return bytes;
  }

  async head(key: string): Promise<boolean> {
    const response = await this.request('HEAD', key);
    await response.body?.cancel().catch(() => {});
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw new Error(`R2 HEAD request failed (HTTP ${response.status})`);
  }

  async put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string): Promise<void> {
    const response = await this.request('PUT', key, bytes, {
      'Content-Type': contentType, 'Cache-Control': cacheControl,
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`R2 PUT request failed (HTTP ${response.status})`);
  }
}
