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

export interface Serializer<T extends string | Buffer = string | Buffer> {
  serialize(data: unknown): T; // value written to Redis
  deserialize(raw: T): unknown; // raw bytes from Redis
  storage: 'string' | 'buffer'; // choose get / getBuffer
}
