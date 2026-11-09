# @allinone/database-redis

Redis adapter for [`@allinone/database`](../database) — key-value
documents plus the infra `CacheProvider`.

## Install

```bash
pnpm add @allinone/database-redis
```

## Usage

```ts
import { createPlatform, presets } from "allinone";
import { createRedisAdapter } from "@allinone/database-redis";

const db = createRedisAdapter({ url: process.env["REDIS_URL"] });

const platform = createPlatform({
  preset: presets.starter(),
  database: { adapter: "redis", instance: db },
});

// Cache provider over a separate namespace (tenant-safe via caller keys).
const cache = db.asCacheProvider();
await cache.set("t:tenant:k", "value", 60);
```

Documents live at `{namespace}:{collection}:{id}` as JSON. `find` SCANs
the prefix and filters in memory — fine for KV sizes; use Postgres/Mongo
for relational workloads.

## Capabilities (honest)

```ts
{
  transactions: false,        // not modeled — `transaction()` throws
  nestedTransactions: false,
  foreignKeys: false,
  joins: false,
  jsonQueries: true,          // JSON document reads + in-memory filters
  fullTextSearch: false,
  schemaMigrations: false,    // schemaless — `migrate()` throws
  optimisticLocking: true,    // atomic Lua compare-and-set on _version
  rowLevelSecurity: false,    // tenant predicates instead
  softDeletes: true,          // deletedAt marker; hardRemove() for GDPR erasure
}
```

## Testing

Live tests run against Redis when reachable (`REDIS_TEST_URL`):

```bash
docker run -d --name allinone-redis-test -p 6380:6379 --rm redis:7
REDIS_TEST_URL=redis://127.0.0.1:6380 pnpm --filter @allinone/database-redis test
```
