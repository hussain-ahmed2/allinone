# @allinone/database-sqlite

SQLite adapter for [`@allinone/database`](../database). Built on Node's
built-in `node:sqlite` (Node ≥ 22.5) — zero native dependencies. Storage
model: one table per collection — `(id TEXT PK, tenant_id TEXT, data
TEXT-JSON, created_at, updated_at, version, deleted_at)`.
`:memory:` for tests + short-lived apps; file paths persist.

## Install

```bash
pnpm add @allinone/database-sqlite
```

Node ≥ 22.5 required (`engines`). Also beware the
`ExperimentalWarning: SQLite is an experimental feature` from
`node:sqlite` — harmless, but expected.

## Usage

```ts
import { createPlatform, presets } from "allinone";
import { createSqliteAdapter } from "@allinone/database-sqlite";

const platform = createPlatform({
  preset: presets.starter(),
  database: {
    adapter: "sqlite",
    instance: createSqliteAdapter({ path: "./data/app.db" }), // or ":memory:"
  },
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
  jsonQueries: true,        // json_extract paths
  fullTextSearch: true,     // FTS5 + query()
  schemaMigrations: true,   // allinone_migrations table
  optimisticLocking: true,  // version column + updateOptimistic()
  rowLevelSecurity: false,  // SQLite has no RLS — tenant predicates instead
  softDeletes: true,        // deleted_at; hardRemove() for GDPR erasure
}
```

## Security

Values always bound with `?` placeholders; the JSON path parameter is bound
(not interpolated) so attacker field names can't break out. Identifiers
whitelisted.

## Testing

Tests run against `:memory:` — no infrastructure needed:

```bash
pnpm --filter @allinone/database-sqlite test
```
