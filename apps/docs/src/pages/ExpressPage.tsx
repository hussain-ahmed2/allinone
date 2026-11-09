import { Code, Note, PageHeader } from "../components/Docs.js";
import { Link } from "react-router";

export function ExpressPage() {
  return (
    <>
      <PageHeader
        eyebrow="Integrations"
        title="Express integration (detailed)"
        intro={
          <>
            allinone is framework-agnostic: Express is just a thin shell (HTTP + cookies) around the
            platform. This page documents the runnable <code>apps/example-express</code> integration
            end to end — middleware order, security boundaries, and the request lifecycle.
          </>
        }
      />
      <Code title="Run it">
        {`pnpm example:express   # http://localhost:3000
curl http://localhost:3000/health
curl http://localhost:3000/`}
      </Code>
      <h2>Architecture: where the framework ends and allinone begins</h2>
      <p>
        Express owns HTTP (routing, cookies, JSON). Everything else — config, lifecycle, tenancy,
        auth, authorization, CMS, audit — is allinone. The app factory keeps the boundary testable:
      </p>
      <Code title="apps/example-express/src/app.ts — factory">
        {`export async function createApp(): Promise<{ app: express.Express; platform: Platform }> {
  const platform = createPlatform({
    preset: presets.saas(),
    database: { adapter: "memory" },
    auth: { mfa: true },
    authorization: { mode: "rbac-abac", defaultDeny: true },
    cms: { enabled: true },
  });
  await platform.initialize();
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  // ... middleware + routes
  return { app, platform };
}`}
      </Code>
      <h2>Middleware order</h2>
      <p>
        Order is security-critical: identity → tenant → permission → CSRF → handler. Skipping or
        reordering weakens the model.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Middleware</th>
              <th>Guards</th>
              <th>Failure</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["1", "express.json({ limit: 256kb })", "Body size + JSON parse", "400 / 413"],
              ["2", "requestContext", "Attaches requestId (correlation)", "—"],
              ["3", "rateLimit (auth routes)", "platform.rateLimiter per IP", "429 + Retry-After"],
              ["4", "requireAuth", "Valid session cookie", "401 UNAUTHORIZED"],
              ["5", "requireTenant", "x-tenant-id ∈ memberships", "403 TENANT_FORBIDDEN"],
              [
                "6",
                "requirePermission(res, act)",
                "can() vs role permissions",
                "403 + policy reason",
              ],
              ["7", "requireCsrf", "Double-submit token on writes", "403 CSRF"],
              ["8", "route handlers", "Tenant-scoped data access", "400/404 → platform errors"],
              [
                "9",
                "error handler",
                "Stable { error: { code } } envelope",
                "500s never leak internals",
              ],
            ].map(([n, name, guards, failure]) => (
              <tr key={n}>
                <td>{n}</td>
                <td>
                  <code>{name}</code>
                </td>
                <td>{guards}</td>
                <td>{failure}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Authentication &amp; sessions</h2>
      <Code title="POST /api/auth/register — establishes the session">
        {`// Register also auto-provisions a personal workspace (tenant) with
// admin membership, then sets two cookies:
//   session=<opaque>; HttpOnly; SameSite=Lax; Path=/
//   csrf=<token>; SameSite=Lax; Path=/   (JS-readable double-submit token)
const user = await platform.auth.register({ email, password, name });`}
      </Code>
      <p>
        Registration/login are exempt from the CSRF check (there is no session yet). Every other
        state-changing call must send <code>x-csrf-token</code> matching the cookie. Logout revokes
        the server session and rotates cookies to empty.
      </p>
      <h2>Tenancy</h2>
      <Code title="tenancy guard">
        {`// requireTenant middleware — never trust the header blindly:
const effective = req.get("x-tenant-id") ?? session.tenantId;
if (!membershipsOf(session.userId).includes(effective)) {
  res.status(403).json(errorPayload("TENANT_FORBIDDEN", "..."));
  return;
}
req.tenantId = effective;`}
      </Code>
      <h2>Authorization</h2>
      <p>
        Roles live per tenant (<code>admin</code>, <code>editor</code>, <code>viewer</code>). The
        guard evaluates <code>can(actor, resource, action)</code> server-side with the platform's
        default-deny engine — a viewer trying to write gets{" "}
        <code>403 {`{ reason: "no-matching-permission" }`}</code>, never a leak.
      </p>
      <Code title="requirePermission">
        {`function requirePermission(resource: string, action: string) {
  return (req, res, next) => {
    const allowed = can(
      { actor: actorFrom(session, tenant), action, resource },
      ROLES,
    );
    if (!allowed) {
      audit(req, "authorization.check", resource + "." + action, "failure");
      res.status(403).json(errorPayload("FORBIDDEN", "...", "no-matching-permission"));
      return;
    }
    next();
  };
}`}
      </Code>
      <h2>Endpoints</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Method &amp; path</th>
              <th>Auth</th>
              <th>Permission</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["POST /api/auth/register", "—", "Creates user + personal tenant"],
              ["POST /api/auth/login", "—", "Sets session + CSRF cookies"],
              ["POST /api/auth/logout", "session", "Revokes session"],
              ["POST /api/tenants", "session", "Any signed-in user"],
              ["POST /api/tenants/:id/members", "session", "users.update (admin)"],
              ["GET /api/cms/posts", "session + tenant", "cms.posts.read"],
              ["POST /api/cms/posts", "session + tenant + CSRF", "cms.posts.create"],
              ["POST /api/cms/posts/:id/publish", "session + tenant + CSRF", "cms.posts.publish"],
              ["GET /api/admin/me", "session + tenant", "—"],
              ["POST /api/keys", "session + tenant + CSRF", "keys.manage implied"],
              ["GET /api/v1/status", "x-api-key", "status.read (scoped key)"],
            ].map(([route, auth, perm]) => (
              <tr key={route}>
                <td>
                  <code>{route}</code>
                </td>
                <td>{auth}</td>
                <td>{perm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>API keys</h2>
      <Code title="POST /api/keys → GET /api/v1/status">
        {`// Create an API key (returned once — stored hashed server-side).
const { record, secret } = platform.apiKeys.create({
  tenantId, name: "client", scopes: ["status.read"],
});
// Authenticated calls check the scope server-side:
const record = platform.apiKeys.verify(xApiKey, "status.read");
if (!record) res.status(403).json(...);`}
      </Code>
      <h2>Audit</h2>
      <p>
        Every privileged action appends a tenant-scoped audit event:
        <code>
          {" "}
          auth.register · auth.login · tenancy.create · cms.publish · api.keys.create ·
          authorization.check{" "}
        </code>
        with request correlation IDs. Secret material (passwords, keys, tokens) never appears in
        events.
      </p>
      <Note>
        This example uses the in-memory adapter + in-memory session map. In production, give
        sessions to your database (hash the token at rest) and swap <code>adapter: "memory"</code>{" "}
        for Postgres/Mongo — handlers stay the same.
      </Note>
      <div className="cta-row">
        <Link className="btn" to="/database">
          Swap the database
        </Link>
        <Link className="btn" to="/deployment">
          Production deployment
        </Link>
      </div>
    </>
  );
}
