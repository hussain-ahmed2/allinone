# @allinone/database-mssql

Microsoft SQL Server adapter for [`@allinone/database`](../database).
Storage model: one table per collection — `(id NVARCHAR PK, tenant_id
NVARCHAR, data NVARCHAR(MAX) JSON, created_at DATETIME2, updated_at,
version, deleted_at)` — T-SQL `JSON_VALUE` queries + `SYSUTCDATETIME`
defaults (no `ON UPDATE` keyword in SQL Server; `updated_at` is written
explicitly on updates).

## Install

```bash
pnpm add @allinone/database-mssql
```

## Usage

```ts
import { createPlatform, presets } from "allinone";
import { createMssqlAdapter } from "@allinone/database-mssql";

const platform = createPlatform({
  preset: presets.saas(),
  database: {
    adapter: "mssql",
    instance: createMssqlAdapter({ connectionString: "mssql://sa:***@host:1433/db" }),
  },
});
await platform.initialize();
```

## Capabilities

```ts
{
  transactions: true,
  nestedTransactions: true, // SAVE TRANSACTION savepoints
  foreignKeys: true,
  joins: true,              // via query()
  jsonQueries: true,        // JSON_VALUE paths
  fullTextSearch: true,     // FULLTEXT indexes + query()
  schemaMigrations: true,   // allinone_migrations table
  optimisticLocking: true,  // version column + updateOptimistic()
  rowLevelSecurity: true,   // predicates + SESSION_CONTEXT (see withTenantSetting)
  softDeletes: true,        // deleted_at; hardRemove() for GDPR erasure
}
```

## Security

Values bound via node-mssql's parameterized `request.input(...)`
(`@p0, @p1, ...`); table/field identifiers whitelisted. `updated_at`
uses `SYSUTCDATETIME()` in the same statement as the data write
(always fresh — SQL Server defaults don't auto-refresh).

## Testing

CI-only live tests (no local pulls needed):

```bash
MSSQL_TEST_URL=mssql://sa:TestPass1!@127.0.0.1:1433/allinone_test \
  pnpm --filter @allinone/database-mssql test
```

CI starts SQL Server 2022 via Docker (`.github/workflows/ci.yml`).
