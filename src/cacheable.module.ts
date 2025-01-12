import { DynamicModule, Inject, Module } from '@nestjs/common';
import { setCacheManager, setGlobalTTL } from './cacheable.helper';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { RedisCache } from 'cache-manager-ioredis-yet';

@Module({})
export class CacheableModule {
  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: RedisCache,
  ) {
    setCacheManager(this.cacheManager);
  }
  static register(defaultTTL?: number): DynamicModule {
    setGlobalTTL(defaultTTL || 0);

    return {
      module: CacheableModule,
    };
  }
}
