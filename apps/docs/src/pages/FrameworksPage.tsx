import { Code, Note, PageHeader } from "../components/Docs.js";
import { Link } from "react-router";

export function FrameworksPage() {
  return (
    <>
      <PageHeader
        eyebrow="Integrations"
        title="Framework integrations"
        intro={
          <>
            allinone is framework-agnostic: any HTTP stack can mount it by mapping requests to{" "}
            <code>RequestContext</code> and calling platform services. Runnable examples:{" "}
            <code>apps/example-express</code> and <code>apps/example-fastify</code> (the latter with{" "}
            <code>fastify.inject()</code> — no sockets in tests).
          </>
        }
      />
      <h2>Contract every integration implements</h2>
      <p>Four seams, the same in Express, Fastify, Next.js, Router, or Astro:</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Seam</th>
              <th>Responsibility</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["Request context", "Map framework request → { requestId, tenantId, userId, ip }"],
              ["Tenant resolution", "Validate membership — never trust a raw tenant id"],
              ["Authorization", "can() server-side · default-deny · audit denials"],
              ["Lifecycle", "platform.initialize() ×1 · platform.shutdown() on SIGTERM"],
            ].map(([seam, job]) => (
              <tr key={seam}>
                <td>
                  <code>{seam}</code>
                </td>
                <td>{job}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Express (runnable)</h2>
      <Code title="Run it">{`pnpm example:express   # http://localhost:3000
curl http://localhost:3000/health`}</Code>

      <h2>Fastify (runnable)</h2>
      <Code title="Hook-based integration — apps/example-fastify">
        {`import { createApp } from "./app.js";
import { createPlatform, presets } from "allinone";

const platform = createPlatform({
  preset: presets.saas(),
  database: { adapter: "memory" },
  auth: { mfa: true },
  authorization: { mode: "rbac-abac", defaultDeny: true },
  cms: { enabled: true },
});
await platform.initialize();

const fastify = Fastify();
fastify.addHook("onRequest", async (req) => {
  // req.requestId = "req_" + generateToken(8); // correlation id
});
fastify.get("/health", async () => {
  const database = await platform.database.healthCheck();
  return { ok: database.ok, database };
});
// app.use / app.post(...) equivalents go through preHandler chains:
//   requireAuth → requireTenant → requirePermission → requireCsrf`}
      </Code>
      <Note>
        Tests exist for both runnable apps (401 guards, RBAC deny, cross-tenant 403, scoped API
        keys, manifest filtering).
      </Note>

      <h2>Next.js (App Router route handlers)</h2>
      <Code title="app/api/v1/status/route.ts">
        {`import { NextRequest, NextResponse } from "next/server";
import { createPlatform, presets } from "allinone";
import { createPostgresAdapter } from "@allinone/database-postgres";

const platform = createPlatform({
  preset: presets.saas(),
  database: {
    adapter: "postgres",
    instance: createPostgresAdapter({ connectionString: process.env["DATABASE_URL"]! }),
  },
});
let initialized = false;
async function ensure() {
  if (!initialized) {
    await platform.initialize();
    initialized = true;
  }
}

export async function GET(req: NextRequest) {
  await ensure();
  const apiKey = req.headers.get("x-api-key");
  const record = apiKey ? platform.apiKeys.verify(apiKey, "status.read") : null;
  if (!record) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Invalid API key" } }, { status: 403 });
  }
  return NextResponse.json({ ok: true, tenantId: record.tenantId });
}`}
      </Code>
      <p>
        Keep `createPlatform()` at module scope so the pool + lifecycle start once per server
        instance.
      </p>

      <h2>React Router v7 (this docs site is the reference)</h2>
      <Code title="Loader-side usage">
        {`// app/routes/admin.tsx (server loader)
import { createAdminManifest } from "@allinone/infra";

export const loader = async ({ request }: { request: Request }) => {
  const platform = getPlatform(); // singleton in server entry
  const actor = sessionFrom(request.cookies);
  const roles = membershipRoles(platform, actor, tenantId);
  return buildAdminManifest({ actor, tenantId, rolesById: ROLES });
};`}
      </Code>
      <p>Client components never see enforcement logic — they render what the loaders return.</p>

      <h2>TanStack Start (server functions)</h2>
      <Code title="Server function">
        {`import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start/server";

const getManifest = createServerFn().handler(async () => {
  const platform = getServerPlatform();      // singleton, server-only
  const { actor, tenantId } = requireSession(); // cookie → session → user
  return buildAdminManifest({ actor, tenantId, rolesById: ROLES });
});

export const Route = createFileRoute("/admin")({
  loader: () => getManifest(),
  component: AdminPage,
});`}
      </Code>
      <Note>
        TanStack Start runs on Nitro; treat the server functions as your trust boundary. Call{" "}
        <code>platform.initialize()</code> once at server startup and <code>shutdown()</code> on
        SIGTERM.
      </Note>

      <h2>Astro (SSG/SSR)</h2>
      <Code title="src/pages/api/status.astro / endpoint">
        {`---
import { createPlatform, presets } from "allinone";

const platform = createPlatform({
  preset: presets.cms(),
  database: { adapter: "memory" },
});
await platform.initialize(); // module scope in SSR builds

export async function GET({ request }: AstroGlobal) {
  const key = request.headers.get("x-api-key");
  const record = key ? platform.apiKeys.verify(key, "status.read") : null;
  return new Response(
    JSON.stringify(record ? { ok: true, tenantId: record.tenantId } : { error: { code: "FORBIDDEN" } }),
    { status: record ? 200 : 403, headers: { "content-type": "application/json" } },
  );
}
---`}
      </Code>
      <p>
        Static (SSG) pages can call the platform at build time to render content; dynamic (SSR)
        endpoints handle requests at runtime — the contract is identical.
      </p>

      <div className="cta-row">
        <Link className="btn" to="/express">
          Detailed Express guide
        </Link>
        <Link className="btn" to="/deployment">
          Production deployment
        </Link>
      </div>
    </>
  );
}
