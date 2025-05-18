/* cacheable.helper.ts
 * Service-level cache core with:
 * 1) deterministic key hashing via safe-stable-stringify
 * 2) watchdog timer for pendingMethodCallMap entries
 */

import { createHash } from 'crypto';
import stringify from 'safe-stable-stringify';
import { CacheKeyBuilder, CacheEvictKeyBuilder } from './cacheable.interface';
import { RedisCache } from 'cache-manager-ioredis-yet';

/* ─────────────── Serializer contract ──────────────────────────── */

export interface Serializer<T extends string | Buffer = string | Buffer> {
  serialize(data: unknown): T; // value written to Redis
  deserialize(raw: T): unknown; // raw bytes read from Redis
  storage: 'string' | 'buffer'; // which Redis API to use
}

/* default JSON (UTF-8 string) */
export const jsonSerializer: Serializer<string> = {
  storage: 'string',
  serialize: JSON.stringify,
  deserialize: (s) => JSON.parse(s),
};

let activeSerializer: Serializer = jsonSerializer;
export const setSerializer = (s?: Serializer) =>
  (activeSerializer = s ?? jsonSerializer);
export const getSerializer = () => activeSerializer;

/* ─────────────── Cache-manager holder ─────────────────────────── */

let cacheManager!: RedisCache;
let globalTTL = 0; // ms
export const setCacheManager = (m: RedisCache) => (cacheManager = m);
export const getCacheManager = () => cacheManager;
export const setGlobalTTL = (ttl: number) => (globalTTL = ttl);
export const getGlobalTTL = () => globalTTL;

/* ─────────────── Key helpers ──────────────────────────────────── */

type KeyType = string | string[] | CacheKeyBuilder | CacheEvictKeyBuilder;

const extract = (b: KeyType, a: unknown[]) =>
  Array.isArray(b instanceof Function ? (b as any)(...a) : b)
    ? (b as string[])
    : [b as any];

export function generateComposedKey(opts: {
  key?: string | CacheKeyBuilder | CacheEvictKeyBuilder;
  namespace?: string | CacheKeyBuilder;
  methodName: string;
  args: unknown[];
}): string[] {
  const keys = opts.key
    ? extract(opts.key, opts.args)
    : [
        `${opts.methodName}@${createHash('md5')
          .update(stringify(opts.args)) // deterministic & cycle-safe
          .digest('hex')}`,
      ];

  const ns = opts.namespace && extract(opts.namespace, opts.args);
  return keys.map((k) => (ns ? `${ns[0]}:${k}` : k));
}

/* ─────────────── Cache read helpers ───────────────────────────── */

const pendingCacheMap = new Map<string, Promise<unknown>>();

async function fetchCachedValue(key: string) {
  const useBuffer = activeSerializer.storage === 'buffer';

  let promise = pendingCacheMap.get(key);
  if (!promise) {
    promise = useBuffer
      ? cacheManager.store.client.getBuffer(key) // Buffer | null
      : cacheManager.store.client.get(key); // string  | null
    pendingCacheMap.set(key, promise);
  }

  let raw: string | Buffer | null;
  try {
    raw = (await promise) as any;
  } finally {
    pendingCacheMap.delete(key);
  }

  return raw !== null ? activeSerializer.deserialize(raw as any) : undefined;
}

/* ─────────────── Cache write helpers ──────────────────────────── */

/** entry with watchdog timer to auto-purge stale promises */
interface PendingEntry {
  promise: Promise<unknown>;
  timer: NodeJS.Timeout;
}

let pendingTimeout = 30_000; // 30 s by default
export const setPendingTimeout = (ms: number) => (pendingTimeout = ms);

const pendingMethodCallMap = new Map<string, PendingEntry>();

export async function cacheableHandle(
  key: string,
  method: () => Promise<unknown>,
  ttl?: number,
) {
  /* 1. cache lookup */
  try {
    const cached = await fetchCachedValue(key);
    if (cached !== undefined) return cached;
  } catch {
    /* ignore cache read errors */
  }

  /* 2. deduplicate parallel calls with watchdog */
  let entry = pendingMethodCallMap.get(key);
  if (!entry) {
    const promise = method();
    const timer = setTimeout(
      () => pendingMethodCallMap.delete(key), // auto-cleanup
      pendingTimeout,
    ).unref(); // does not keep event loop alive
    entry = { promise, timer };
    pendingMethodCallMap.set(key, entry);
  }

  let value: unknown;
  try {
    value = await entry.promise;
  } finally {
    clearTimeout(entry.timer);
    pendingMethodCallMap.delete(key);
  }

  /* 3. write back */
  const ttlSec =
    ttl !== undefined
      ? Math.ceil(ttl / 1000)
      : globalTTL > 0
        ? Math.ceil(globalTTL / 1000)
        : 0;

  const data = activeSerializer.serialize(value) as any;
  if (ttlSec > 0) {
    await cacheManager.store.client.set(key, data, 'EX', ttlSec);
  } else {
    await cacheManager.store.client.set(key, data);
  }

  return value;
}
