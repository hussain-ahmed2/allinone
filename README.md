# allinone

> Universal application platform — secure by default, database-agnostic, framework-native.

Build SaaS, multi-tenant, CMS, e-commerce, and enterprise applications without
re-implementing authentication, authorization, multi-tenancy, audit logging,
or other common application infrastructure. The platform is a modular package
ecosystem — install only the modules you need.

```ts
import { createPlatform, presets, fields } from "allinone";

const platform = createPlatform({
  preset: presets.saas(),
  database: { adapter: "memory" }, // swap for postgres/mongo adapters
  auth: { mfa: true },
  cms: { enabled: true },
});

await platform.initialize();

// Typed collections (database-agnostic schema DSL)
const User = platform.database; // typed helpers live in @allinone/database
void fields;
await platform.shutdown();
```

## Packages

| Package | Purpose |
|---------|---------|
| `allinone` (`packages/platform`) | Public entry: `createPlatform()`, lifecycle, DI container, extensions |
| `@allinone/config` | Strongly-typed config + security invariants |
| `@allinone/presets` | starter / saas / enterprise / cms / ecommerce presets |
| `@allinone/database` | Database-agnostic adapter contract, typed fields, conformance suite |
| `@allinone/database-postgres` | PostgreSQL adapter — transactions, migrations, RLS, soft deletes |
| `@allinone/tenancy` | Multi-tenancy: registry, explicit context, safe resolvers |
| `@allinone/auth` | Identity, sessions, RBAC + ABAC (default-deny) |
| `@allinone/cms` | Headless CMS: collections, revisions, publishing |
| `@allinone/infra` | Audit, API keys, webhooks, cache, subscriptions, rate limiting |
| `@allinone/testing` | Shared test helpers |

## Highlights

- **Secure by default** — default-deny authorization, hashed refresh tokens
  with rotation + reuse detection, tenant isolation enforced at query time,
  append-only audit with hash-chain tamper detection.
- **Explicit capabilities** — adapters declare what they support; unsupported
  features throw loudly instead of being silently faked.
- **Preset-driven** — SaaS / Enterprise / CMS / E-commerce presets, composable,
  override-friendly, with security invariants that cannot be silently disabled.
- **Framework-agnostic** — no React/Next/Express. Your custom framework stays
  in charge of HTTP + rendering; allinone plugs in via providers + lifecycle
  hooks.
- **Strict TypeScript** — inferred model types, typed config, typed policies.

## Docs

- Developer guide: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)
- Architecture & roadmap: [`docs/adr/0001-repo-audit-architecture.md`](docs/adr/0001-repo-audit-architecture.md)
- Documentation site: `apps/docs` (Vite + React)

```bash
pnpm install
pnpm build
pnpm test
pnpm docs:dev     # documentation site
pnpm example      # runnable example app
```

## Status

Phase 0–6 milestones are implemented with tests. The PostgreSQL adapter
(`@allinone/database-postgres`) is conformance-tested (pg-mem unit +
live Postgres 17 integration). MongoDB adapters, SSO/TOTP MFA, and
deployment examples are the next milestones — see the architecture
roadmap. No payment provider is hard-coupled; billing is adapter-based.

Run live tests against Docker Postgres:

```bash
docker run -d --name allinone-pg-test -e POSTGRES_PASSWORD=testpass \
  -e POSTGRES_DB=allinone_test -p 5433:5432 --rm postgres:17
POSTGRES_TEST_URL=postgres://postgres:testpass@localhost:5433/allinone_test \
  pnpm --filter @allinone/database-postgres test
```

## License

MIT
