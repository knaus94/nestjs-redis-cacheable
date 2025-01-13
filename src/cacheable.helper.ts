import { createHash } from 'crypto';
import { CacheEvictKeyBuilder, CacheKeyBuilder } from './cacheable.interface';
import { Decimal } from '@prisma/client/runtime/library';
import { RedisCache } from 'cache-manager-ioredis-yet';
import { createCodec, encode, decode } from 'msgpack-lite';

const codec = createCodec();

// Уникальные коды (type) для регистрации пользовательских типов в MessagePack
const TYPE_DECIMAL = 0x07;
const TYPE_DATE = 0x0d;

/**
 * Регистрируем тип `Decimal`.
 * - При кодировании превращаем `Decimal` в строку.
 * - При декодировании восстанавливаем обратно в `Decimal`.
 */
codec.addExtPacker(TYPE_DECIMAL, Decimal, (decimal) => {
  return Buffer.from(decimal.toString());
});
codec.addExtUnpacker(TYPE_DECIMAL, (buffer) => {
  return new Decimal(buffer.toString());
});

/**
 * Регистрируем тип `Date`.
 * - При кодировании превращаем `Date` в строку.
 * - При декодировании восстанавливаем обратно в `Date`.
 */
codec.addExtPacker(TYPE_DATE, Date, (date) => {
  return Buffer.from(date.toISOString());
});
codec.addExtUnpacker(TYPE_DATE, (buffer) => {
  return new Date(buffer.toString());
});

// ---------- 2) CACHE-MANAGER УПРАВЛЕНИЕ ----------
let cacheManager: RedisCache | undefined;
let globalTTL: number | undefined;
export function setCacheManager(m: RedisCache) {
  cacheManager = m;
}
export function getCacheManager() {
  return cacheManager;
}
export function setGlobalTTL(ttl: number) {
  globalTTL = ttl;
}
export function getGlobalTTL() {
  return globalTTL;
}

/**
 * Сериализация данных
 */
function serialize(data) {
  return encode(data, { codec });
}

/**
 * Десериализация данных
 */
function deserialize(buffer: Buffer) {
  return decode(buffer, { codec });
}

// ---------- 4) ТИПЫ ДЛЯ ГЕНЕРАЦИИ КЛЮЧЕЙ ----------
type KeyType = string | string[] | CacheKeyBuilder | CacheEvictKeyBuilder;

/**
 * try extract valid key from build function or fixed string
 */
function extract(keyBuilder: KeyType, args: any[]): string[] {
  const keys =
    keyBuilder instanceof Function ? keyBuilder(...args) : keyBuilder;
  return Array.isArray(keys) ? keys : [keys];
}

/**
 * generateComposedKey
 * generate the final cache key, compose of use key and namespace(option), like 'namespace:key'
 */
export function generateComposedKey(options: {
  key?: string | CacheKeyBuilder | CacheEvictKeyBuilder;
  namespace?: string | CacheKeyBuilder;
  methodName: string;
  args: any[];
}): string[] {
  let keys: string[];
  if (options.key) {
    keys = extract(options.key, options.args);
  } else {
    // Тут можно оставить serialize(...) от 'serialize-javascript',
    // либо заменить на JSON.stringify — это не влияет на хранение результата,
    // а только на генерацию ключа.
    const hash = createHash('md5')
      .update(serialize(options.args))
      .digest('hex');
    keys = [`${options.methodName}@${hash}`];
  }
  const namespace =
    options.namespace && extract(options.namespace, options.args);
  return keys.map((it) => (namespace ? `${namespace[0]}:${it}` : it));
}

// ---------- 5) ВОТ ВАШ pendingCacheMap ДЛЯ ЧТЕНИЯ ----------
const pendingCacheMap = new Map<string, Promise<any>>();
async function fetchCachedValue(key: string) {
  let pendingCachePromise = pendingCacheMap.get(key);
  if (!pendingCachePromise) {
    pendingCachePromise = getCacheManager().store.client.getBuffer(key);
    pendingCacheMap.set(key, pendingCachePromise);
  }
  let value;
  try {
    value = await pendingCachePromise;
  } catch (e) {
    throw e;
  } finally {
    pendingCacheMap.delete(key);
  }
  if (!value) {
    return undefined;
  }

  // Предполагаем, что value — это Buffer, тогда десериализуем
  return deserialize(value as Buffer);
}

// ---------- 6) pendingMethodCallMap для предотвращения повторных запросов ----------
const pendingMethodCallMap = new Map<string, Promise<any>>();

/**
 * cacheableHandle
 * 1) Сначала проверяем, есть ли в кэше
 * 2) Если нет, вызываем method()
 * 3) Сохраняем результат в кэше
 */
export async function cacheableHandle(
  key: string,
  method: () => Promise<any>,
  ttl?: number,
) {
  // 1) Пробуем взять из кэша
  try {
    const cachedValue = await fetchCachedValue(key);
    if (cachedValue !== undefined) return cachedValue;
  } catch {
    // игнорируем ошибки при чтении кэша
  }

  // 2) Если нет, вызываем method(),
  //    но храним промис, чтобы избежать параллельных запросов
  let pendingMethodCallPromise = pendingMethodCallMap.get(key);
  if (!pendingMethodCallPromise) {
    pendingMethodCallPromise = method();
    pendingMethodCallMap.set(key, pendingMethodCallPromise);
  }
  let value;
  try {
    value = await pendingMethodCallPromise;
  } catch (e) {
    throw e;
  } finally {
    pendingMethodCallMap.delete(key);
  }

  // 3) Сохраняем результат в кэше, используя msgpack5
  if (ttl === undefined) {
    ttl = getGlobalTTL();
  }

  if (ttl) {
    ttl = Math.ceil(ttl);
  }

  await (ttl && ttl > 0
    ? cacheManager.store.client.set(key, serialize(value), 'EX', ttl / 1000)
    : cacheManager.store.client.set(key, serialize(value)));
  return value;
}
