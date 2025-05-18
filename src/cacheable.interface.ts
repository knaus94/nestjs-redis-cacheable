export type CacheKeyBuilder = (...args: unknown[]) => string;
export type CacheEvictKeyBuilder = (...args: unknown[]) => string | string[];

export interface CacheableRegisterOptions {
  key?: string | CacheKeyBuilder;
  namespace?: string | CacheKeyBuilder;
  ttl?: number; // ms
}

export interface CacheEvictRegisterOptions {
  key?: string | CacheEvictKeyBuilder;
  namespace?: string | CacheKeyBuilder;
}
