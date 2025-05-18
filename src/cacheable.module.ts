import { DynamicModule, Inject, Module } from '@nestjs/common';
import {
  setCacheManager,
  setGlobalTTL,
  setSerializer,
  Serializer,
} from './cacheable.helper';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { RedisCache } from 'cache-manager-ioredis-yet';

export interface CacheableModuleOptions {
  defaultTTL?: number; // ms
  serializer?: Serializer; // custom serializer
}

@Module({})
export class CacheableModule {
  constructor(@Inject(CACHE_MANAGER) private readonly cache: RedisCache) {
    setCacheManager(this.cache);
  }

  static register(opts: CacheableModuleOptions = {}): DynamicModule {
    if (opts.defaultTTL !== undefined) setGlobalTTL(opts.defaultTTL);
    setSerializer(opts.serializer);
    return { module: CacheableModule };
  }
}
