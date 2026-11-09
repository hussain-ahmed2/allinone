/**
 * @allinone/example — runnable example SaaS flow.
 *
 * Demonstrates: org registration → tenant creation → invitation intent →
 * user registration → login (tenant-scoped) → CMS publish → audit trail →
 * API key issuance + scoped verification → graceful shutdown.
 *
 * Run: `pnpm example` (uses the in-memory adapter — no external services).
 */
import { createPlatform, presets } from "allinone";

async function main(): Promise<void> {
  const platform = createPlatform({
    preset: presets.saas(),
    database: { adapter: "memory" },
    auth: { mfa: true },
    cms: { enabled: true },
  });

  await platform.initialize();
  console.log("[example] platform initialized");

  // 1 — Create a tenant (organization workspace).
  const tenant = platform.tenants.create({
    id: "tenant_acme",
    name: "Acme Inc.",
    slug: "acme",
    strategy: "shared-schema",
    domains: ["acme.example.com"],
  });
  console.log(`[example] tenant created: ${tenant.id}`);

  // 2 — Register + log in a user (tenant-scoped session).
  await platform.auth.register({
    email: "ada@acme.example.com",
    password: "correct horse battery",
    name: "Ada",
  });
  const { session, refreshToken } = await platform.auth.login({
    email: "ada@acme.example.com",
    password: "correct horse battery",
    tenantId: tenant.id,
  });
  console.log(`[example] session created: ${session.id} (refresh token issued, stored hashed)`);

  await platform.auth.rotateRefresh(refreshToken);
  console.log("[example] refresh token rotated");

  // 3 — CMS: draft → review → publish.
  const entry = platform.cms.create({
    collection: "posts",
    data: { title: "Welcome to Acme" },
    slug: "welcome-to-acme",
    createdBy: session.userId,
  });
  platform.cms.submitForReview(entry.id);
  const published = platform.cms.publish(entry.id);
  console.log(`[example] CMS entry published: ${published.id} (${published.status})`);

  // 4 — Audit event (tenant-scoped, append-only).
  platform.audit.append({
    actorId: session.userId,
    tenantId: tenant.id,
    action: "cms.publish",
    resource: "posts",
    outcome: "success",
    correlationId: "example-1",
    metadata: { entryId: published.id },
  });
  const auditValid = platform.audit.verifyChain();
  const auditCount = platform.audit.listForTenant(tenant.id).length;
  console.log(
    `[example] audit chain valid: ${String(auditValid)}, events for tenant: ${String(auditCount)}`,
  );

  // 5 — API key with scoped permissions.
  const { record, secret } = platform.apiKeys.create({
    tenantId: tenant.id,
    name: "example-key",
    scopes: ["posts.read"],
  });
  const verified = platform.apiKeys.verify(secret, "posts.read");
  console.log(
    `[example] API key ${record.id} verifies for posts.read: ${String(verified !== null)}`,
  );

  // 6 — Database round-trip with tenant isolation.
  await platform.database.insert("users", [{ name: "Ada" }], { tenantId: tenant.id });
  const own = await platform.database.find("users", { tenantId: tenant.id });
  const other = await platform.database.find("users", { tenantId: "tenant_other" });
  console.log(
    `[example] tenant isolation: own=${String(own.length)} other=${String(other.length)}`,
  );

  await platform.shutdown();
  console.log("[example] shutdown complete");
}

main().catch((error: unknown) => {
  console.error("[example] failed:", error);
  process.exit(1);
});
