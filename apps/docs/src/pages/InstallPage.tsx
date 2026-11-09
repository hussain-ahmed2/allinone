import { Code, Note, PageHeader } from "../components/Docs.js";

export function InstallPage() {
  return (
    <>
      <PageHeader
        eyebrow="Getting started"
        title="Install"
        intro={
          <>
            allinone is a pnpm monorepo. The published entry point is the <code>allinone</code>{" "}
            package; internals live in <code>@allinone/*</code> workspace packages. Requires Node ≥
            20 (pnpm 11 needs Node ≥ 22.13 — use Node 24 LTS).
          </>
        }
      />
      <Code title="Terminal">
        {`pnpm install        # then
pnpm build          # generates dist/ for every package
pnpm checks         # build + strict typecheck + typed lint + format + tests
pnpm docs:dev       # this site (Vite + React)
pnpm example        # runnable SaaS demo (memory adapter)`}
      </Code>
      <Note>
        VS Code users: after <code>pnpm build</code>, run <code>ESLint: Restart ESLint Server</code>{" "}
        + <code>TypeScript: Restart TS Server</code> to pick up the new <code>dist/</code> types.
        Repo workdir is pinned in <code>.vscode/settings.json</code>.
      </Note>
      <h2>Local datastore stack</h2>
      <Code title="docker-compose.yml (dev only)">
        {`docker compose up -d postgres mongo    # Postgres 17 + Mongo 8
docker compose down                     # stop (data persists)`}
      </Code>
      <p>
        Copy <code>.env.example</code> to <code>.env</code> for connection strings, test targets,
        and SSO secrets. See <code>docs/DEPLOYMENT.md</code> for the production checklist.
      </p>
    </>
  );
}
