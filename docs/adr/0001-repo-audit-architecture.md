# ADR-0001 — Repository Audit + Architecture (Phase 0)

## Context

The framework repository was **empty** at audit time (initial commit only,
README deleted, no framework code, no package.json). There is therefore no
existing request lifecycle, router, DI container, or rendering engine to
integrate with — integration is defined against a stable public contract
(`RequestContext` + lifecycle hooks + provider interfaces) instead of an
assumed framework API.

## Decisions

1. **Package name:** root `allinone`; public entry `allinone` (package
   `packages/platform`) re-exports `@allinone/*` internals. Internal
   packages stay namespaced `@allinone/*` for independent versioning.
2. **Monorepo:** pnpm workspaces, strict TypeScript, Vitest. No Turborepo
   yet (single-machine builds are fast enough; add when CI warrants).
3. **Framework-agnostic core:** zero runtime dependencies in core/config/
   database/tenancy/auth/cms/infra. HTTP + rendering stay in the custom
   framework. Core only knows `RequestContext` / provider interfaces.
4. **Runtime:** Node ≥20 (ships `AsyncLocalStorage`, stable Web Crypto,
   `performance`, `fetch`). No native deps anywhere (scrypt via `node:crypto`).
5. **Database strategy:** capability-matrix contract + conformance suite.
   Only `memory` ships in-repo (tests/examples). Postgres/Mongo/etc.
   adapters are new packages that must pass `runAdapterConformance()`.
6. **Security posture:** fail-closed everywhere — default-deny authz,
   hashed tokens, tenant isolation enforced at query time, invariants
   checked in `assertSecure()` (see ADR-0002).

## Roadmap (milestones)

| Milestone | Scope                                                  | Status                                                             |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Phase 0   | Audit + ADR + roadmap                                  | ✅ done (this doc)                                                 |
| Phase 1   | Core, config, presets, lifecycle, plugins              | ✅ done                                                            |
| Phase 2   | Database abstraction + memory adapter + conformance    | ✅ done (memory, Postgres, Mongo, MySQL, SQLite, Redis)            |
| Phase 3   | Identity + RBAC/ABAC + audit                           | ✅ done (in-memory); DB persistence next                           |
| Phase 4   | Multi-tenancy (registry, context, isolation)           | ✅ done (shared-schema + separate-schema PG + DB-per-tenant Mongo) |
| Phase 5   | CMS + revisions                                        | ✅ done (core store)                                               |
| Phase 6   | Infra (cache/api-keys/webhooks/subs/rate-limit/health) | ✅ done                                                            |
| Phase 7a  | PostgreSQL adapter (conformance + live PG17)           | ✅ done                                                            |
| Phase 7b  | MongoDB adapter (conformance + local mongod)           | ✅ done                                                            |
| Phase 7c  | SSO/OIDC + TOTP MFA + recovery codes                   | ✅ done                                                            |
| Phase 7d  | Separate-schema tenancy (schema-per-tenant PG)         | ✅ done                                                            |
| Phase 7e  | Deployment guide + examples                            | ✅ done (docs/DEPLOYMENT, docker stack)                            |
| Phase 7f  | Load/security benchmarking                             | ✅ done (smoke bench script; k6 for full load tests)               |
| Phase 7g  | MySQL/MariaDB adapter                                  | ✅ done (conformance + Docker MariaDB 11)                          |
| Phase 7h  | SQLite + Redis adapters                                | ✅ done                                                            |
| Phase 7i  | Storage providers (local FS + S3), media library       | ✅ done                                                            |
| Phase 7j+ | Passkeys/WebAuthn, MSSQL, admin metadata APIs          | ⬜ next (passkeys done)                                            |

## Threat model (summary)

| Threat                                   | Mitigation                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Client-supplied tenant ID forgery        | `createHeaderResolver()` validates membership; never trust raw IDs     |
| Cross-tenant data leak                   | Query-time tenant filter + TS-typed tenant context + cache namespacing |
| Token theft/reuse                        | SHA-256 hashed refresh tokens, rotation, reuse → family revocation     |
| Account enumeration                      | Generic "Invalid credentials" + lockout backoff                        |
| Authz bypass via UI                      | Server-side `evaluatePolicy()` is the only boundary; default-deny      |
| Unsupported DB capability silently faked | `UnsupportedCapabilityError` — fail loud, never simulate               |
| Audit tampering                          | Append-only + SHA-256 hash chain (`AuditLog.verifyChain()`)            |

## Open questions for framework owners

1. Confirm target TS version (currently pinned to 5.7; TS 7 when adopted).
2. Confirm Node version floor (currently ≥20).
3. Decide where Postgres/Mongo adapters live (in-repo vs. separate repos).
4. Provide the framework's `RequestContext` shape so we can ship a 20-line
   adapter (see `packages/platform/src/platform.ts`).
