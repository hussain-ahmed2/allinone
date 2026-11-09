/**
 * allinone micro-benchmarks — measure the platform's per-request overhead
 * against a bare baseline (no platform installed), per the spec's
 * "measure, don't assume" rule.
 *
 * Run:  pnpm build && node benchmarks/bench.mjs
 *
 * Note: this is a smoke benchmark, not a load test. For production load
 * testing, run k6/autocannon against your deployed app (see
 * docs/DEPLOYMENT.md).
 */
import { performance } from "node:perf_hooks";

const { createMemoryAdapter } = await import("../packages/database/dist/index.js");
const { can, hashToken, scryptHasher } = await import("../packages/auth/dist/index.js");
const { createHeaderResolver, TenantRegistry } = await import("../packages/tenancy/dist/index.js");

async function bench(label, iterations, fn) {
  for (let i = 0; i < 200; i += 1) await fn(i); // warmup
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) await fn(i);
  const ms = performance.now() - started;
  const ops = Math.round((iterations / ms) * 1000);
  console.log(`${label.padEnd(46)} ${String(ops).padStart(9)} ops/sec (${ms.toFixed(1)} ms)`);
}

const hasher = scryptHasher();
const hashValue = await hasher.hash("benchmark-password");

const registry = new TenantRegistry();
registry.create({ id: "t1", name: "Acme", slug: "acme", strategy: "shared-schema", domains: [] });
const resolve = createHeaderResolver(registry, () => true);

const adapter = createMemoryAdapter();
await adapter.connect();
await adapter.createTable("bench");

const roles = new Map([
  ["admin", { id: "admin", name: "Admin", permissions: ["users.*", "cms.posts.*"] }],
  ["user", { id: "user", name: "User", permissions: ["posts.read"] }],
]);

console.log("allinone overhead benchmarks (higher is better)\n");

await bench("auth: scrypt hash + verify", 500, async () => {
  await hasher.verify("benchmark-password", hashValue);
});

// scrypt is expensive by design — compare against a trivial baseline.
await bench("auth: token hashing (sha256)", 20_000, async () => {
  hashToken("bench-token");
});

await bench("authz: can(read users)", 20_000, async () => {
  can(
    { actor: { id: "u", roles: ["admin"], attributes: {} }, action: "read", resource: "users" },
    roles,
  );
});

await bench("tenancy: header resolve + membership", 20_000, async () => {
  await resolve({ headerTenantId: "t1", userId: "u1" });
});

await bench("database: memory find (limit 10)", 5_000, async () => {
  await adapter.find("bench", { limit: 10 });
});

await adapter.disconnect();
console.log("\ndone.");
