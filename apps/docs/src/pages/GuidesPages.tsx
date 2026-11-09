import { Code, Note, PageHeader, Section } from "../components/Docs.js";

const DB_EXAMPLE = `import { createPlatform, presets } from "allinone";
import { createPostgresAdapter } from "@allinone/database-postgres";

const db = createPostgresAdapter({ connectionString: process.env["DATABASE_URL"] });

const platform = createPlatform({
  preset: presets.saas(),
  database: { adapter: "postgres", instance: db },
});
await platform.initialize();
await platform.database.createTable("users");
await platform.database.insert("users", [{ name: "Ada" }], { tenantId: "t1" });
const rows = await platform.database.find("users", { tenantId: "t1" });`;

const CAPABILITIES = [
  ["Transactions", "✔ savepoints", "✘ (no replica set)", "✘"],
  ["Soft delete", "✔ deleted_at", "✔ deletedAt", "—"],
  ["Optimistic locking", "✔ version", "✔ _version", "—"],
  ["Tenant isolation", "✔ predicates + RLS", "✔ predicates", "✔ predicates"],
  ["Injection defense", "✔ param binding", "✔ primitives-only", "—"],
] as const;

export function DatabasePage() {
  return (
    <>
      <PageHeader
        eyebrow="Guides"
        title="Database"
        intro={
          <>
            Every adapter declares an explicit capability matrix. Unsupported features throw{" "}
            <code>UnsupportedCapabilityError</code> — never silently simulated. All queries are
            parameterized.
          </>
        }
      />
      <Code title="Postgres — shared-schema (default)">{DB_EXAMPLE}</Code>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Capability</th>
              <th>Postgres</th>
              <th>MongoDB</th>
              <th>Memory</th>
            </tr>
          </thead>
          <tbody>
            {CAPABILITIES.map(([cap, pg, mongo, mem]) => (
              <tr key={cap}>
                <td>{cap}</td>
                <td>{pg}</td>
                <td>{mongo}</td>
                <td>{mem}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>
        MongoDB rejects object filter values (<code>{"{ $gt: '' }"}</code>) locally —
        attacker-supplied operators never reach the driver. Postgres rejects unsafe table/field
        identifiers.
      </Note>
    </>
  );
}

const TENANCY_EXAMPLE = `// Shared-schema (default): tenant_id predicate on every query.
await db.insert("posts", [{ title: "Hello" }], { tenantId: "acme" });

// Separate-schema (Postgres): schemaProvider routes schema per tenant.
const db = createPostgresAdapter({
  connectionString: process.env["DATABASE_URL"],
  schemaProvider: (tenantId) => \`tenant_\${tenantId}\`,
});
await db.createTenantSchema("acme", ["posts"]); // once, at tenant signup

// Database-per-tenant (Mongo): dbProvider routes database per tenant.
const mongo = createMongoAdapter({
  connectionString: process.env["MONGO_URL"],
  dbProvider: (tenantId) => \`app_\${tenantId}\`,
});
await mongo.createTenantDatabase("acme", ["posts"]);`;

export function TenancyPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guides"
        title="Multi-tenancy"
        intro={
          <>
            Tenant context is explicit (<code>AsyncLocalStorage</code>) — never ambient globals.
            Tenant identity is validated against authenticated membership; a raw header ID is only a
            hint.
          </>
        }
      />
      <Code>{TENANCY_EXAMPLE}</Code>
      <div className="box-grid">
        <article className="box">
          <h3>Shared-schema</h3>
          <p>
            One tablespace, <code>tenant_id</code> predicate on every query. Default.
          </p>
        </article>
        <article className="box">
          <h3>Separate-schema (Postgres)</h3>
          <p>One database, per-tenant schema — fully qualified table refs.</p>
        </article>
        <article className="box">
          <h3>Database-per-tenant (Mongo)</h3>
          <p>One database per tenant — hard isolation, more ops cost.</p>
        </article>
        <article className="box">
          <h3>Hybrid</h3>
          <p>Mix strategies per tenant via the registry — configure per tenant.</p>
        </article>
      </div>
    </>
  );
}

const AUTH_EXAMPLE = `import { AuthService } from "@allinone/auth";

const auth = new AuthService();
await auth.register({ email, password, name });
const { session, refreshToken } = await auth.login({ email, password, tenantId });

// Refresh tokens rotate; reusing one revokes the whole session family.
const next = await auth.rotateRefresh(refreshToken);

// TOTP MFA (RFC 6238 — show otpauthUri as a QR code, then confirm).
const enrollment = auth.startTotpEnrollment(userId, { issuer: "my-app" });
const { recoveryCodes } = auth.confirmTotpEnrollment(userId, totpCode(secret));
auth.verifyTotp(userId, code);              // replay-protected
auth.useRecoveryCode(userId, recoveryCodes[0]); // single-use
auth.disableTotp(userId, code);`;

export function AuthPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guides"
        title="Authentication & MFA"
        intro={
          <>
            Passwords hashed with scrypt; refresh tokens stored as SHA-256 hashes with rotation.
            Reusing one revokes the whole session family.
          </>
        }
      />
      <Code>{AUTH_EXAMPLE}</Code>
      <Note>
        Totp codes are RFC 6238 verified (8 RFC vectors) and replay-proof per user. Recovery codes
        are single-use, stored hashed, shown once at enrollment.
      </Note>
      <Section eyebrow="Guides" title="Passkeys (WebAuthn)">
        <p>
          Phishing-resistant passkeys via <code>@simplewebauthn/server</code>. Challenges are
          single-use (5 min), sign-counts reject clones, and one credential maps to one user
          globally.
        </p>
        <Code>
          {`const { options, challenge } = await auth.beginPasskeyRegistration(userId);
const { credentialId } = await auth.finishPasskeyRegistration(userId, challenge, response);

const { challenge: authChallenge } = await auth.beginPasskeyAuthentication();
const { user } = await auth.finishPasskeyAuthentication(authChallenge, response);

auth.listPasskeys(userId);
auth.removePasskey(userId, credentialId);
// Configure RP via platform config:
// auth: { passkeys: { enabled: true, rpID: "app.example.com",
//                      rpName: "My App", origin: "https://app.example.com" } }`}
        </Code>
      </Section>
    </>
  );
}
const SSO_EXAMPLE = `import { createOidcProvider } from "@allinone/auth";

const provider = createOidcProvider({
  id: "google",
  issuer: "https://accounts.google.com",
  clientId: process.env["GOOGLE_CLIENT_ID"]!,
  clientSecret: process.env["GOOGLE_CLIENT_SECRET"]!,
  redirectUri: "https://app.example.com/auth/callback",
});

// 1. Redirect the browser (PKCE S256 + state + nonce).
const request = await provider.buildAuthorizationUrl();
// 2. On callback: check state, then exchange + link the local account.
const { user: oidcUser } = await provider.exchangeCode({
  code, codeVerifier: request.codeVerifier, nonce: request.nonce,
});
const { user } = await auth.linkExternalIdentity("google", oidcUser);`;

export function SsoPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guides"
        title="SSO / OIDC"
        intro={
          <>
            OAuth 2.0 + OpenID Connect, authorization-code + PKCE (S256), dependency-free (
            <code>fetch</code> + <code>node:crypto</code>). ID tokens verified RS256/ES256 against
            issuer JWKS.
          </>
        }
      />
      <Code>{SSO_EXAMPLE}</Code>
    </>
  );
}

const AUTHZ_EXAMPLE = `import { can } from "@allinone/auth";

const roles = new Map([
  ["admin", { id: "admin", name: "Admin", permissions: ["users.*"] }],
  ["editor", { id: "editor", name: "Editor", permissions: ["posts.update"] }],
]);

// RBAC — wildcard permissions, default-deny everywhere else.
can(
  { actor: { id: "u1", roles: ["admin"], attributes: {} }, action: "read", resource: "users" },
  roles,
); // true

// ABAC — a condition can deny even a granted permission (explicit deny wins).
can(
  {
    actor: { id: "u1", roles: ["editor"], attributes: { ownerId: "u1" } },
    action: "update",
    resource: "posts",
    resourceAttributes: { ownerId: "other" },
  },
  roles,
  [{ permission: "posts.update", condition: (q) => q.actor.attributes["ownerId"] === q.resourceAttributes?.["ownerId"] }],
); // false`;

export function AuthzPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guides"
        title="Authorization (RBAC + ABAC)"
        intro={
          <>
            Default-deny, server-side only. Granular permissions (<code>users.read</code>),
            wildcards (<code>users.*</code>), role inheritance, and ABAC conditions that can deny.
          </>
        }
      />
      <Code>{AUTHZ_EXAMPLE}</Code>
      <Note>Authorization is enforced on the server — never merely hidden in an admin UI.</Note>
      <Code title="Permission cache (Redis/Memory)">
        {`import { createPermissionCache } from "@allinone/auth";
const permissions = createPermissionCache({ cache, ttlSeconds: 300 });
const allowed = await permissions.can(query, rolesById, tenantId);
await permissions.invalidateActor(userId);   // role change
await permissions.invalidateTenant(tenantId); // bulk change`}
      </Code>
    </>
  );
}

const CMS_EXAMPLE = `import { CmsStore, slugify } from "@allinone/cms";

const cms = platform.cms;
const entry = cms.create({
  collection: "posts",
  data: { title: "Hello world" },
  slug: slugify("Hello world"),
  createdBy: sessionUserId,
});
cms.submitForReview(entry.id);   // draft → in-review
cms.publish(entry.id);           // in-review → published (revisions recorded)
cms.update(entry.id, { title: "Hello v2" });
const revisions = cms.revisionsFor(entry.id);
cms.restoreRevision(entry.id, revisions[0]!.id); // rollback to v1
cms.unpublish(entry.id);         // published → archived`;

export function CmsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guides"
        title="CMS"
        intro={
          <>
            Headless content with dynamic collections, revisions, and a strict publishing state
            machine: <code>draft → in-review → published → archived</code>.
          </>
        }
      />
      <Code>{CMS_EXAMPLE}</Code>
    </>
  );
}

const INFRA_EXAMPLE = `// Audit — append-only, hash-chained, tenant-scoped.
platform.audit.append({
  actorId, tenantId, action: "cms.publish", resource: "posts",
  outcome: "success", correlationId, metadata: { entryId },
});
platform.audit.listForTenant(tenantId);
platform.audit.verifyChain(); // tamper detection

// API keys — stored hashed, scoped, timing-safe verify.
const { record, secret } = platform.apiKeys.create({
  tenantId, name: "ci", scopes: ["posts.read"],
});
platform.apiKeys.verify(secret, "posts.read"); // null when out of scope

// Rate limiting — sliding window, per-tenant keys.
platform.rateLimiter.allow(\`t:\${tenantId}:\${userId}\`);`;

export function InfraPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guides"
        title="Audit logs & infra"
        intro={
          <>
            Append-only, hash-chained audit events; hashed + scoped API keys; signed webhooks with
            backoff; sliding-window rate limiting; plan entitlements that fail closed.
          </>
        }
      />
      <Code>{INFRA_EXAMPLE}</Code>
      <Code title="Workflows — approval gate + retries">
        {`engine.register("notify", async (input) => sendEmail(input));
engine.define({
  id: "onboard",
  name: "Onboarding",
  steps: [
    { id: "review", type: "approval", label: "Manager review" },
    { id: "notify", type: "task", action: "notify",
      retry: { maxAttempts: 3, backoffMs: 100 } },
  ],
});
const run = engine.start("onboard", { tenantId });
await engine.execute(run.id);   // pauses at waiting-approval
await engine.approve(run.id);   // resumes → completes
await engine.reject(run.id);    // or cancels terminally`}
      </Code>
      <Note>
        Email: <code>{"createSmtpMailer({ host, user, pass, from })"}</code> implements the shared{" "}
        <code>NotificationProvider</code> interface — inject a fake <code>sendMail</code> for tests.
        Templates escape user values by default.
      </Note>
    </>
  );
}

export function SharedPages() {
  return null;
}

export { Section };
