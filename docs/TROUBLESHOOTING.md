# Troubleshooting

## `pnpm install` then `Cannot find module 'allinone'` in apps

`apps/example` (and any consumer) resolves workspace packages from `dist/`,
which is gitignored. Build first:

```bash
pnpm install && pnpm build
```

Chain it: `pnpm example` and `pnpm bench` already run `pnpm build`.

## VS Code shows `Unsafe assignment of an error typed value` / `... .operator on a type that cannot be resolved` everywhere

The VS Code ESLint server could not resolve `@allinone/*` types (they live
in `dist/`). Fresh build + restarts:

```bash
pnpm install && pnpm build
```

Then in VS Code:

1. `ESLint: Restart ESLint Server` (Command Palette)
2. `TypeScript: Restart TS Server`

Repo workdir is pinned in `.vscode/settings.json`
(`eslint.workingDirectories: ["./"]`); terminal `pnpm lint` passing while
the editor complains is the classic stale-server symptom.

## `pnpm lint` fails with `tsconfig... does not include this file`

Typed lint requires every linted file to be in a TS program. Tests are
intentionally included by `packages/*/tsconfig.json` (emit uses
`tsconfig.build.json` instead — tests stay type-checked but unshipped).
Don't add `exclude` for tests to `tsconfig.json`; edit
`tsconfig.build.json` for emit exclusions only.

## `ERR_PNPM_IGNORED_BUILDS` for esbuild after install

Run `pnpm approve-builds esbuild` (once; required for Vite/Vitest).

## Postgres live tests fail / skip silently

`postgres-live.test.ts` needs a Postgres 17 reachable at
`POSTGRES_TEST_URL` (default `postgres://postgres:testpass@localhost:5433/allinone_test`).
Start it:

```bash
docker run -d --name allinone-pg-test -e POSTGRES_PASSWORD=testpass \
  -e POSTGRES_DB=allinone_test -p 5433:5432 --rm postgres:17
```

Unreachable servers → tests skip (still pass). CI provides them as services.

## Mongo tests connection refused

Local `mongod` required on `127.0.0.1:27017` (or set `MONGO_TEST_URL`).
`docker compose up -d mongo` works. Standalone mongod intentionally lacks
transactions — the adapter declares `transactions: false` and would fail
loudly if you tried (use a replica set + migrate to `createMongoAdapter`
with a replica-set URI for tx support later).

## OIDC `discovery failed` / `Unknown signing key`

Check `issuer` ends without a trailing path (no `/auth` suffix mistakes),
`clientId` matches the registered one (`aud` check), and `jwks_uri` is
reachable from the server (not only from your browser). `none` algorithms
are rejected by design — use an RS256/ES256 issuer.

## `duplicate key` planting ghost rows in live tests

Live tests use per-run unique tables/DBs; leftover state points at a
stray running server on the same port. Check `docker ps` /
`mongosh --eval db.adminCommand('ping')` and drop stale containers/DBs.

## Pages blank on GitHub Pages (docs)

Base path is `/allinone/` in CI mode (`GITHUB_PAGES=true`). Local
`pnpm docs:dev` uses `/`. Verify `index.html` references `/allinone/assets/`
in the deployed bundle and that Settings → Pages → Source is
"GitHub Actions".
