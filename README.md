# nestjs-cacheable

> Service-level caching for NestJS with pluggable serializers.

`@knaus94/nestjs-cacheable` extends the standard `CacheModule` so you can cache **service method** calls—not only controller responses—using two simple decorators:

| Decorator       | Purpose                                                         |
|-----------------|-----------------------------------------------------------------|
| `@Cacheable`    | Stores the method’s return value under a generated key & TTL.   |
| `@CacheEvict`   | Removes one or many keys after the method finishes successfully.|

---

## Installation

```bash
npm i @knaus94/nestjs-cacheable          # or
yarn add @knaus94/nestjs-cacheable
```

## Quick Start

```typescript
// app.module.ts
import { Module, CacheModule } from '@nestjs/common';
import { CacheableModule } from '@knaus94/nestjs-cacheable';

@Module({
  imports: [
    CacheModule.register({ isGlobal: true }), // any cache-manager store
    CacheableModule.register(),               // default JSON serializer
  ],
})
export class AppModule {}
```

```typescript
// user.service.ts
@Injectable()
export class UserService {
  /** Result is cached for 5 seconds */
  @Cacheable({
    key: (id: number) => `username-${id}`,
    namespace: 'user',
    ttl: 5000,              // milliseconds
  })
  async getUserName(id: number) {
    return this.db.query(/* … */);
  }

  /** Cache entry is removed after deletion */
  @CacheEvict({
    key: (id: number) => `username-${id}`,
    namespace: 'user',
  })
  async deleteUser(id: number) {
    await this.db.delete(/* … */);
  }
}
```

## Switching to MsgPack
Any storage format can be plugged in via the Serializer interface.
Below is a ready-to-use MsgPack serializer (binary, no Base64) with custom support for Decimal and Date.

```typescript
// msgpack.serializer.ts
import { encode, decode, createCodec } from 'msgpack-lite';
import { Decimal } from '@prisma/client/runtime/library';
import { Serializer } from '@knaus94/nestjs-redis-cacheable';

const codec = createCodec();
codec.addExtPacker(0x3f, Decimal, d => encode(d.toString()));
codec.addExtUnpacker(0x3f, b => new Decimal(decode(b)));
codec.addExtPacker(0x0d, Date,    d => encode(d.toISOString()));
codec.addExtUnpacker(0x0d, b => new Date(decode(b)));

export const msgPackSerializer: Serializer<Buffer> = {
  storage: 'buffer',                       // tells the module to use Buffer I/O
  serialize: data => encode(data, { codec }),
  deserialize: buf => decode(buf, { codec }),
};
```

# Register it:
```typescript
// app.module.ts
import { Module, CacheModule } from '@nestjs/common';
import { CacheableModule } from '@knaus94/nestjs-cacheable';
import { msgPackSerializer } from './msgpack.serializer';

@Module({
  imports: [
    CacheModule.register({ isGlobal: true }),
    CacheableModule.register({
      defaultTTL: 60_000,       // optional global TTL
      serializer: msgPackSerializer,
    }),
  ],
})
export class AppModule {}
```
Now every cached value is stored in Redis as raw MsgPack bytes; switch back to JSON at any time by omitting the serializer option.

| Item                                | Description                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **`Cacheable(options)`**            | Caches the method result. <br>Options: `key`, `namespace`, `ttl`.                                                               |
| **`CacheEvict(options)`**           | Deletes keys after the method succeeds.                                                                                         |
| **`CacheableModule.register(cfg)`** | Enables service-level caching.<br>`cfg.defaultTTL` (ms) sets a fallback TTL.<br>`cfg.serializer` injects a custom `Serializer`. |

## License

[MIT licensed](LICENSE).