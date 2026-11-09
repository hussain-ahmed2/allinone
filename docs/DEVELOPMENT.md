# Developer Guide

## Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9

## Bootstrap

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## Workspace layout

| Path | Package | Purpose |
|------|---------|---------|
| `packages/platform` | `allinone` | Public entry — `createPlatform()`, lifecycle, container |
| `packages/config` | `@allinone/config` | Typed config, defaults, security invariants |
| `packages/presets` | `@allinone/presets` | starter / saas / enterprise / cms / ecommerce |
| `packages/database` | `@allinone/database` | Adapter contract, typed fields, memory adapter |
| `packages/database-postgres` | `@allinone/database-postgres` | PostgreSQL adapter (pg-mem unit + live PG17 tests) |
| `packages/tenancy` | `@allinone/tenancy` | Tenant registry, explicit context, resolvers |
| `packages/auth` | `@allinone/auth` | Identity, sessions, RBAC/ABAC |
| `packages/cms` | `@allinone/cms` | Collections, revisions, publishing |
| `packages/infra` | `@allinone/infra` | Audit, API keys, webhooks, cache, subscriptions |
| `packages/testing` | `@allinone/testing` | Shared test helpers |
| `apps/docs` | `@allinone/docs` | Documentation site (Vite + React) |
| `apps/example` | `@allinone/example` | Runnable example SaaS app |

## Conventions

- **Strict TypeScript everywhere** — `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. No `any` without an eslint-disable + reason.
- **JSDoc on every public export** — purpose, security notes, error behaviour.
- **Zero runtime deps in core** — check the package's `dependencies` before
  adding one. If it is needed, document why in the PR (maintenance,
  security, licensing, bundle cost).
- **Fail loudly** — throw `PlatformError` (core) or
  `UnsupportedCapabilityError` (database) instead of silent fallbacks.
- **Tests next to source** (`*.test.ts`), Vitest. Security tests
  (cross-tenant, privilege escalation, reuse detection) are first-class.
- **Build with plain `tsc`** — no bundler magic; `dist/` is plain ESM + types.

**Postgres live tests** (optional, real DB):

```bash
docker run -d --name allinone-pg-test -e POSTGRES_PASSWORD=testpass \
  -e POSTGRES_DB=allinone_test -p 5433:5432 --rm postgres:17
POSTGRES_TEST_URL=postgres://postgres:testpass@localhost:5433/allinone_test \
  pnpm --filter @allinone/database-postgres test
```

## Adding a database adapter

1. Implement `DatabaseAdapter` with honest `capabilities`.
2. Call `runAdapterConformance(adapter)` in your package's tests.
3. Document capability exceptions; never simulate unsupported features.

## Adding a platform module

```ts
platform.extend({
  name: "my-module",
  async initialize(platform) { /* wire services */ },
  async shutdown() { /* release resources */ },
});
```

## Security checklist for PRs

- No secrets in code/logs/tests.
- Default-deny preserved after the change.
- Tenant scoping preserved on every new query path.
- `pnpm test && pnpm typecheck && pnpm lint` all green.
