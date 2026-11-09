# @allinone/database-postgres

PostgreSQL adapter for [`@allinone/database`](../database). Storage model: one
table per collection — `(id TEXT PK, tenant_id TEXT, data JSONB, created_at,
updated_at, version, deleted_at)` — so tenant isolation, soft delete, and
optimistic locking are relational while application data stays document-flexible.

## Install

```bash
pnpm add @allinone/database-postgres
```

## Usage

```ts
import { createPlatform, presets } from "allinone";
import { createPostgresAdapter } from "@allinone/database-postgres";

const db = createPostgresAdapter({
  connectionString: process.env["DATABASE_URL"],
});

const platform = createPlatform({
  preset: presets.saas(),
  database: { adapter: "postgres", instance: db },
});
await platform.initialize();
```

## Capabilities

```ts
{
  transactions: true,
  nestedTransactions: true, // savepoints
  foreignKeys: true,
  joins: true,              // via query()
  jsonQueries: true,        // JSONB
  fullTextSearch: true,     // via query() (tsvector)
  schemaMigrations: true,
  optimisticLocking: true,  // version column + updateOptimistic()
  rowLevelSecurity: true,   // enableTenantRowLevelSecurity() + withTenantSetting()
  softDeletes: true,        // deleted_at; hardRemove() for GDPR erasure
}
```

## Security

Values are always parameterized (`$1, $2, ...`); table/field identifiers are
whitelisted against `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/` because identifiers
cannot be bound as parameters. `query()` is the escape hatch for joins,
full-text search, and RLS — always pass values via `params`, never interpolate.

## Migrations

```ts
await db.migrate([
  { id: "001_init", async up(tx) { await tx.createTable("users"); } },
]);
```

Migrations run each in its own transaction and record in
`allinone_migrations`; re-runs are idempotent.

## Testing

- Unit tests run against `pg-mem` (no infrastructure needed):
  `pnpm --filter @allinone/database-postgres test`
- Live integration tests run against real Postgres when reachable
  (default: `postgres://postgres:testpass@localhost:5433/allinone_test`,
  or set `POSTGRES_TEST_URL`). All pass against Postgres 17.

```bash
docker run -d --name allinone-pg-test -e POSTGRES_PASSWORD=testpass \
  -e POSTGRES_DB=allinone_test -p 5433:5432 --rm postgres:17
```
