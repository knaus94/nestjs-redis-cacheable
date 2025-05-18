import { createHash } from 'crypto';
import { CacheKeyBuilder, CacheEvictKeyBuilder } from './cacheable.interface';
import { RedisCache } from 'cache-manager-ioredis-yet';

/* ─────────────── Serializer contract ──────────────────────────── */

export interface Serializer<T extends string | Buffer = string | Buffer> {
  /** value written to Redis (string or Buffer) */
  serialize(data: unknown): T;
  /** raw bytes read from Redis  */
  deserialize(raw: T): unknown;
  /** hints module which Redis API to use */
  storage: 'string' | 'buffer';
}

/* JSON as default (stores UTF-8 string) */
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

let cacheManager: RedisCache;
let globalTTL: number = 0;

export const setCacheManager = (m: RedisCache) => (cacheManager = m);
export const getCacheManager = () => cacheManager;

export const setGlobalTTL = (ttl: number) => (globalTTL = ttl);
export const getGlobalTTL = () => globalTTL;

/* ─────────────── Key helpers ──────────────────────────────────── */

type KeyType = string | string[] | CacheKeyBuilder | CacheEvictKeyBuilder;

function extract(builder: KeyType, args: unknown[]): string[] {
  const v = builder instanceof Function ? (builder as any)(...args) : builder;
  return Array.isArray(v) ? v : [v];
}

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
          .update(JSON.stringify(opts.args))
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
      ? getCacheManager().store.client.getBuffer(key) // Buffer | null
      : getCacheManager().store.client.get(key); // string | null
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

const pendingMethodCallMap = new Map<string, Promise<unknown>>();

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
    /* ignore read errors */
  }

  /* 2. de-duplicate parallel calls */
  let running = pendingMethodCallMap.get(key);
  if (!running) {
    running = method();
    pendingMethodCallMap.set(key, running);
  }

  let value: unknown;
  try {
    value = await running;
  } finally {
    pendingMethodCallMap.delete(key);
  }

  /* 3. write back */
  const ttlSec =
    ttl !== undefined
      ? Math.ceil(ttl / 1000)
      : globalTTL !== undefined
        ? Math.ceil(globalTTL / 1000)
        : 0;

  const data = activeSerializer.serialize(value) as any;
  if (ttlSec > 0) {
    await getCacheManager().store.client.set(key, data, 'EX', ttlSec);
  } else {
    await getCacheManager().store.client.set(key, data);
  }

  return value;
}
