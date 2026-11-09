# @allinone/database-mysql

MySQL / MariaDB adapter for [`@allinone/database`](../database). Storage
model: one InnoDB table per collection — `(id VARCHAR PK, tenant_id VARCHAR,
data JSON, created_at, updated_at ON UPDATE, version, deleted_at)` —
document-flexible data with relational isolation/locking.

## Install

```bash
pnpm add @allinone/database-mysql
```

## Usage

```ts
import { createPlatform, presets } from "allinone";
import { createMysqlAdapter } from "@allinone/database-mysql";

const db = createMysqlAdapter({
  connectionString: process.env["DATABASE_URL"],
  // mysql://user:pass@host:3306/allinone
});

const platform = createPlatform({
  preset: presets.saas(),
  database: { adapter: "mysql", instance: db },
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
  jsonQueries: true,        // JSON columns ->> paths
  fullTextSearch: true,     // FULLTEXT indexes + query()
  schemaMigrations: true,
  optimisticLocking: true,  // version column + updateOptimistic()
  rowLevelSecurity: false,  // MySQL/MariaDB have no RLS — tenant predicates instead
  softDeletes: true,        // deleted_at; hardRemove() for GDPR erasure
}
```

## Security

Values are always bound with `?` placeholders (prepared statements);
table/field identifiers are whitelisted. LIMIT/OFFSET are validated
integers embedded as literals (portable across MySQL versions).

## Testing

- Unit tests run the SQL builder against golden expectations.
- Live tests run against real MariaDB when reachable
  (`MYSQL_TEST_URL` or Docker container below) — otherwise they skip.

```bash
docker run -d --name allinone-mysql-test \
  -e MARIADB_ROOT_PASSWORD=testpass -e MARIADB_DATABASE=allinone_test \
  -e MARIADB_USER=test -e MARIADB_PASSWORD=testpass \
  -p 3307:3306 --rm mariadb:11
MYSQL_TEST_URL=mysql://test:testpass@localhost:3307/allinone_test \
  pnpm --filter @allinone/database-mysql test
```
