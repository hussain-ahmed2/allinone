# Production deployment guide

## Topology

```
               ┌─────────────┐
     users ──► │ your framework app (allinone + your UI) │
               └──────┬──────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   Postgres 17    MongoDB 8    MySQL 8      Redis 7 (optional KV/cache)
   (private)      (private)    (private)
```

Datastores stay **private** (no external port binding); only the app opens
HTTPS. Redis/NATS are not bundled — wire your own via the adapter interfaces
(`CacheProvider`, `StorageProvider`, …) when you need them.

## Environments

```bash
cp .env.example .env   # fill in — never commit .env
pnpm install --frozen-lockfile
pnpm build             # tsc → dist/ (tests excluded)
node dist/index.js     # your framework entry — wire createPlatform() there
```

Reproduce `pnpm checks` (Vite build + strict typecheck + typed lint +
Prettier + tests) in CI before every deploy.

## Datastore provisioning

```ts
import { createPostgresAdapter } from "@allinone/database-postgres";
import { createMongoAdapter } from "@allinone/database-mongodb";
import { createMysqlAdapter } from "@allinone/database-mysql";
import { createSqliteAdapter } from "@allinone/database-sqlite";
import { createRedisAdapter } from "@allinone/database-redis";

// Postgres (shared-schema default)
const db = createPostgresAdapter({ connectionString: process.env["DATABASE_URL"] });
await db.connect();
await db.createTable("users");

// Separate-schema: provision per tenant at registration
const db = createPostgresAdapter({
  connectionString: process.env["DATABASE_URL"],
  schemaProvider: (tenantId) => `tenant_${tenantId}`,
});
await db.createTenantSchema("acme", ["users", "posts"]);

// Mongo (shared-schema default; transactions need a replica set)
const db = createMongoAdapter({ connectionString: process.env["MONGO_URL"] });

// MySQL / MariaDB (InnoDB, prepared statements, savepoints)
const db = createMysqlAdapter({
  connectionString: "mysql://user:pass@host:3306/allinone",
});

// SQLite (embedded; :memory: for tests, file for persistence)
const db = createSqliteAdapter({ path: "./data/app.db" });

// Redis KV documents + cache (transactions honestly unavailable)
const db = createRedisAdapter({ url: process.env["REDIS_URL"] });
await db.connect();

// Database-per-tenant
const db = createMongoAdapter({
  connectionString: process.env["MONGO_URL"],
  dbProvider: (tenantId) => `app_${tenantId}`,
});
await db.createTenantDatabase("acme", ["users"]);
```

## Security checklist

- [ ] `dangerouslyAllowInsecure` NOT used (cookies httpOnly + secure).
- [ ] `authorization.defaultDeny` stays `true`; `tenancy.enforceIsolation` stays `true`.
- [ ] Refresh tokens hashed out of the box; MFA (`auth.mfa: true`) for admins.
- [ ] Tenant data scoped through the adapter (`tenantId` in context) — never
      trust a client-supplied tenant ID; validate membership first.
- [ ] Audit retention configured (`audit.retentionDays`).
- [ ] SSO providers use a vault for `clientSecret` (env only as fallback).
- [ ] Webhook secrets rotated; signature verification enforced.
- [ ] `pnpm checks` green in CI; Pages/docs deployed via the Docs workflow.

## Performance notes

- `pnpm build && node benchmarks/bench.mjs` measures auth/tenancy/DB
  overhead — scrypt dominates auth cost **by design** (tune
  `N` in your hasher if needed).
- For load testing: run k6/autocannon against the deployed app; targets in
  the spec (auth, authz, tenant resolution, query overhead, CMS,
  permission cache) map to the benchmark script's sections before you
  scale infra.

## Docs site (GitHub Pages)

`.github/workflows/docs.yml` builds `apps/docs` and deploys on `main`.
Enable once in **Settings → Pages → Source: "GitHub Actions"**.
URL: `https://hussain-ahmed2.github.io/allinone/`
