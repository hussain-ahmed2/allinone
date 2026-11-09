# @allinone/database-mongodb

MongoDB adapter for [`@allinone/database`](../database). Document-native:
application fields live at top level alongside `_id`, `tenantId`,
`_createdAt`, `_updatedAt`, `_version`, and `deletedAt`.

## Install

```bash
pnpm add @allinone/database-mongodb
```

## Usage

```ts
import { createPlatform, presets } from "allinone";
import { createMongoAdapter } from "@allinone/database-mongodb";

const platform = createPlatform({
  preset: presets.saas(),
  database: {
    adapter: "mongodb",
    instance: createMongoAdapter({
      connectionString: process.env["MONGO_URL"],
      dbName: "allinone",
    }),
  },
});
```

## Capabilities (honest)

```ts
{
  transactions: false,        // require a replica set — throws, never faked
  nestedTransactions: false,
  foreignKeys: false,
  joins: false,
  jsonQueries: false,
  fullTextSearch: true,       // text indexes + aggregate() pipelines
  schemaMigrations: false,    // schemaless; migrate() runs data migrations
  optimisticLocking: true,    // _version
  rowLevelSecurity: false,    // MongoDB has no RLS
  softDeletes: true,          // deletedAt; hardRemove() for GDPR erasure
}
```

`transaction()` throws `UnsupportedCapabilityError`. To enable transactions,
run a replica set and use a future opt-in — do not downgrade the declaration
silently.

## NoSQL injection safety

Filter values must be primitives — an attacker-supplied object such as
`{ $gt: "" }` is **rejected, never executed**. Field names are whitelisted
(no `$` prefix, no leading `_` internals).

```ts
await db.find("users", {
  filters: [{ field: "name", operator: "eq", value: { $gt: "" } }],
});
// → [allinone/database-mongodb] Operator "eq" requires a primitive value
```

## Multi-tenancy strategies

- **Shared-schema** (default): every query carries a `tenantId`
  predicate.
- **Database-per-tenant**: pass `dbProvider` mapping tenant →
  database name; queries route to that tenant's database (validated
  names). Provision at registration time:

```ts
const db = createMongoAdapter({
  connectionString: process.env["MONGO_URL"],
  dbName: "allinone",
  dbProvider: (tenantId) => tenantDbName(tenantId), // app_<tenant>
});
await db.createTenantDatabase("acme", ["users", "posts"]);
```

## Testing

Tests run against local `mongod` (`mongodb://127.0.0.1:27017` by default,
override with `MONGO_TEST_URL`). No transactions in tests (standalone).

```bash
mongod --dbpath ~/.allinone-mongo --bind_ip 127.0.0.1 --fork --logpath /tmp/mongod.log
pnpm --filter @allinone/database-mongodb test
```
