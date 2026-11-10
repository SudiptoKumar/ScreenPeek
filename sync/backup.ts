import { gzipSync, gunzipSync } from 'node:zlib';
import { AwsClient } from 'aws4fetch';
export interface BackupStore { put(key: string, bytes: Uint8Array): Promise<void>; list(): Promise<string[]>; delete(key: string): Promise<void>; }
export const backupKey = (date: Date) => `backups/${date.toISOString().replaceAll(':','-')}-${crypto.randomUUID()}.json.gz`;
const knownKey = (key: string) => /^backups\/\d{4}-\d{2}-\d{2}T[\w.-]+\.json\.gz$/.test(key);
export function encodeBackup(sql: string, config: Record<string, unknown>[], date = new Date()) {
  if (!sql.trim() || Buffer.byteLength(sql) > 512 * 1024 * 1024) throw new Error('SQL export is empty or exceeds the backup safety limit.');
  return gzipSync(JSON.stringify({ format: 'screenpeek-full', version: 1, created_at: date.toISOString(), sql, config }));
}
export function decodeBackup(bytes: Uint8Array) {
  const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8'));
  if (value.format !== 'screenpeek-full' || value.version !== 1 || typeof value.sql !== 'string' || !Array.isArray(value.config)) throw new Error('Unsupported backup format.');
  return value as { format: string; version: number; created_at: string; sql: string; config: Record<string, unknown>[] };
}
export async function saveBackup(store: BackupStore, sql: string, config: Record<string, unknown>[], date = new Date()) {
  const key = backupKey(date), bytes = encodeBackup(sql, config, date);
  // Retention happens only after the new private object is confirmed uploaded.
  await store.put(key, bytes);
  const keys = (await store.list()).filter(knownKey).sort().reverse();
  for (const stale of keys.slice(14)) await store.delete(stale);
  return { key, bytes: bytes.length, retained: Math.min(keys.length,14) };
}
export class PrivateBackupStore implements BackupStore {
  #base: string; #signer: AwsClient; #fetch: typeof fetch;
  constructor(input: { account: string; bucket: string; posterBucket?: string; privateConfirmed: boolean; accessKey: string; secretKey: string; fetch?: typeof fetch }) {
    if (!/^[a-f0-9]{32}$/i.test(input.account) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket) || input.bucket === (input.posterBucket || 'posters') || !input.privateConfirmed || !input.accessKey || !input.secretKey) throw new Error('Configure a separate private backup bucket and scoped S3 credentials; never use the public posters bucket.');
    this.#base = `https://${input.account}.r2.cloudflarestorage.com/${input.bucket}/`;
    this.#signer = new AwsClient({ accessKeyId: input.accessKey, secretAccessKey: input.secretKey, service: 's3', region: 'auto' }); this.#fetch = input.fetch || fetch;
  }
  async #request(method: string, key: string, bytes?: Uint8Array) {
    if (key && !knownKey(key)) throw new Error('Unsafe backup object key');
    const url = new URL(key || '?list-type=2&prefix=backups%2F&max-keys=1000', this.#base);
    const request = await this.#signer.sign(url, { method, body: bytes?.slice().buffer, headers: bytes ? { 'Content-Type': 'application/gzip', 'Cache-Control': 'private, no-store' } : {}, redirect: 'error', signal: AbortSignal.timeout(60000), aws: { allHeaders: true } });
    let response: Response; try { response = await this.#fetch(request); } catch { throw new Error('Private backup storage request failed'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Private backup storage returned HTTP ${response.status}`); }
    return response;
  }
  async put(key: string, bytes: Uint8Array) { const response = await this.#request('PUT',key,bytes); await response.body?.cancel(); }
  async list() {
    const response = await this.#request('GET',''); const xml = await response.text();
    if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) throw new Error('Backup listing exceeds its safety bound; retention was not truncated silently.');
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(match => match[1].replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'"));
  }
  async delete(key: string) { const response = await this.#request('DELETE',key); await response.body?.cancel(); }
}
