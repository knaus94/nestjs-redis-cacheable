import * as serialize from 'serialize-javascript'; // <-- ОСТАВЛЯЕМ ТОЛЬКО ДЛЯ generateComposedKey
import { createHash } from 'crypto';
import { CacheEvictKeyBuilder, CacheKeyBuilder } from './cacheable.interface';

// ---------- 1) ПОДКЛЮЧАЕМ msgpack5 И РЕГИСТРИРУЕМ КАСТОМНЫЕ ТИПЫ ----------
import msgpack5 from 'msgpack5';
import { Decimal } from '@prisma/client/runtime/library';
import { RedisCache } from 'cache-manager-ioredis-yet';

const mp = msgpack5();

// Уникальные коды (type) для регистрации пользовательских типов в MessagePack
const TYPE_DATE = 0x01;
const TYPE_DECIMAL = 0x02;

/**
 * Регистрируем тип `Date`.
 * - При кодировании превращаем Date в ISO-строку
 * - При декодировании восстанавливаем Date из строки
 */
mp.register(
  TYPE_DATE,
  Date,
  (date: Date) => Buffer.from(date.toISOString()),
  (buf: Buffer) => new Date(buf.toString()),
);

/**
 * Регистрируем тип `Decimal`.
 * - При кодировании превращаем Decimal в строку
 * - При декодировании восстанавливаем Decimal из строки
 */
mp.register(
  TYPE_DECIMAL,
  Decimal,
  (decimal: Decimal) => Buffer.from(decimal.toString()),
  (buf: Buffer) => new Decimal(buf.toString()),
);

// ---------- 2) CACHE-MANAGER УПРАВЛЕНИЕ ----------
let cacheManager: RedisCache | undefined;
let globalTTL = 0;
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

// ---------- 3) (ДЕ)СЕРИАЛИЗАЦИЯ РЕЗУЛЬТАТОВ ЧЕРЕЗ msgpack5 ----------
function serialize(data: any): Buffer {
  return mp.encode(data).slice();
}

function deserialize(buf: Buffer): any {
  return mp.decode(buf);
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
    // Берём из кэша
    // Если реализация cache-manager/redis умеет отдавать Buffer напрямую — ок.
    // Иначе может вернуть string, тогда придётся конвертировать,
    // но пока считаем, что возвращается Buffer "как есть".
    pendingCachePromise = getCacheManager().get(key);
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

  if (ttl > 0) {
    await cacheManager.store.client.set(
      key,
      serialize(value),
      'EX',
      ttl / 1000,
    );
  } else {
    await cacheManager.store.client.set(key, serialize(value));
  }
  return value;
}
