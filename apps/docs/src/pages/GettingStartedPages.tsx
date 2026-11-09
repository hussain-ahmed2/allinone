import { Code, Note, PageHeader } from "../components/Docs.js";

const QUICKSTART = `import { createPlatform, presets, fields } from "allinone";

// 1. Create the platform with a preset + a database adapter.
const platform = createPlatform({
  preset: presets.saas(),          // tenancy + orgs + API keys + billing
  database: { adapter: "memory" }, // swap for postgres: { adapter: "postgres", instance: db }
  auth: { mfa: true },
  cms: { enabled: true },
});

// 2. Initialize once (connects DB, runs module hooks).
await platform.initialize();

// 3. Typed collection (database-agnostic schema DSL).
const User = {
  name: "users",
  fields: {
    id: fields.uuid(),
    name: fields.string({ required: true }),
    email: fields.email({ unique: true }),
    role: fields.enum(["admin", "user"]),
    createdAt: fields.createdAt(),
  },
};

await platform.shutdown();`;

const COMPOSE = `import { createPlatform, presets } from "allinone";

const platform = createPlatform({
  preset: presets.saas(),
  database: { adapter: "memory" },
  tenancy: { strategy: "separate-schema" }, // overrides ONE section only
  auth: { mfa: true, session: { maxAgeSeconds: 86400 } },
  modules: { notifications: true },
});

await platform.initialize();`;

const CONFIG_EXAMPLE = `import { resolveConfig } from "@allinone/config";

const config = resolveConfig({
  database: { adapter: "memory" },
  authorization: { mode: "rbac-abac", customPolicies: [myPolicy] },
  audit: { enabled: true, retentionDays: 180 },
});

config.authorization.defaultDeny; // true — invariant, cannot be disabled
config.auth.session.httpOnly;     // true — invariant (local dev needs opt-in)`;

export function QuickStartPage() {
  return (
    <>
      <PageHeader
        eyebrow="Getting started"
        title="Quick start"
        intro={
          <>
            One call wires config, lifecycle, and services. Your framework keeps the HTTP/rendering
            layer; allinone supplies everything else.
          </>
        }
      />
      <Code title="app.ts">{QUICKSTART}</Code>
      <Note>
        Swap <code>adapter: "memory"</code> for{" "}
        <code>adapter: "postgres", instance: createPostgresAdapter(...)</code> or the Mongo
        equivalent — the rest of the code is unchanged.
      </Note>
    </>
  );
}

export function PresetsPage() {
  const PRESETS = [
    { name: "starter", desc: "Single tenant, auth, basic RBAC, audit, storage." },
    { name: "saas", desc: "Multi-tenancy, orgs, billing, API keys, webhooks, entitlements." },
    { name: "enterprise", desc: "Hybrid tenancy, MFA, workflows, 365-day audit retention." },
    { name: "cms", desc: "Headless CMS, media, localization, SEO, content APIs." },
    { name: "ecommerce", desc: "Customers, catalog, orders, payment adapters, webhooks." },
  ] as const;
  return (
    <>
      <PageHeader
        eyebrow="Getting started"
        title="Compose & presets"
        intro={
          <>
            Presets compose — later presets win per section, and user options always win. Override a
            single field without replacing a whole preset.
          </>
        }
      />
      <Code>{COMPOSE}</Code>
      <p>
        All five presets are composable: <code>presets.compose(presets.saas(), presets.cms())</code>{" "}
        enables tenancy + billing + CMS + media together.
      </p>
      <div className="chip-row">
        {PRESETS.map((p) => (
          <span key={p.name} className="chip">
            {p.name}() — {p.desc}
          </span>
        ))}
      </div>
      <Code title="@allinone/config">{CONFIG_EXAMPLE}</Code>
    </>
  );
}
