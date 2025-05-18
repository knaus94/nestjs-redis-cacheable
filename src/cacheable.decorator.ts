import {
  cacheableHandle,
  generateComposedKey,
  getCacheManager,
} from './cacheable.helper';
import {
  CacheableRegisterOptions,
  CacheEvictRegisterOptions,
} from './cacheable.interface';

/* ─── @Cacheable ───────────────────────────────────────────────── */

export function Cacheable(opts: CacheableRegisterOptions): MethodDecorator {
  return (t, p, d) => {
    const original = d.value as (...a: any[]) => Promise<unknown>;

    (d as any).value = async function (...args: unknown[]) {
      const cm = getCacheManager();
      if (!cm) return original.apply(this, args);

      const key = generateComposedKey({
        methodName: String(p),
        key: opts.key,
        namespace: opts.namespace,
        args,
      })[0];

      return cacheableHandle(key, () => original.apply(this, args), opts.ttl);
    };

    return d;
  };
}

/* ─── @CacheEvict ──────────────────────────────────────────────── */

export function CacheEvict(
  ...opts: CacheEvictRegisterOptions[]
): MethodDecorator {
  return (t, p, d) => {
    const original = d.value as (...a: any[]) => Promise<unknown>;

    (d as any).value = async function (...args: unknown[]) {
      let result: unknown;
      try {
        result = await original.apply(this, args);
      } finally {
        try {
          await Promise.all(
            opts.map((o) => {
              const keys = generateComposedKey({
                ...o,
                methodName: String(p),
                args,
              });
              return getCacheManager().store.mdel(...keys);
            }),
          );
        } catch {
          /* ignore eviction errors */
        }
      }
      return result;
    };

    return d;
  };
}
