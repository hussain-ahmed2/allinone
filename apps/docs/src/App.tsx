import { useState } from "react";

const QUICKSTART = `import { createPlatform, presets, fields } from "allinone";

const platform = createPlatform({
  preset: presets.saas(),
  database: { adapter: "memory" }, // swap for postgres / mongo adapters
  auth: { mfa: true },
  cms: { enabled: true },
});

await platform.initialize();

// Typed collection (schema DSL — database-agnostic)
const User = {
  name: "users",
  fields: {
    id: fields.uuid(),
    name: fields.string({ required: true }),
    email: fields.email({ unique: true }),
    role: fields.enum(["admin", "user"]),
  },
};

await platform.shutdown();`;

const NAV = [
  { id: "overview", label: "Overview" },
  { id: "quickstart", label: "Quick start" },
  { id: "architecture", label: "Architecture" },
  { id: "presets", label: "Presets" },
  { id: "security", label: "Security model" },
  { id: "roadmap", label: "Roadmap" },
] as const;

const MODULES = [
  {
    name: "Config",
    pkg: "@allinone/config",
    desc: "Typed config, defaults, security invariants that cannot be silently disabled.",
  },
  {
    name: "Database",
    pkg: "@allinone/database",
    desc: "Capability-matrix adapter contract, typed fields, conformance suite.",
    tag: "memory adapter included",
  },
  {
    name: "Postgres",
    pkg: "@allinone/database-postgres",
    desc: "PostgreSQL adapter — transactions, migrations, RLS, soft deletes.",
    tag: "PG17 verified",
  },
  {
    name: "Tenancy",
    pkg: "@allinone/tenancy",
    desc: "Tenant registry, explicit async-safe context, membership-validated resolvers.",
    tag: "shared-schema",
  },
  {
    name: "Auth",
    pkg: "@allinone/auth",
    desc: "Identity, sessions, RBAC + ABAC with default-deny.",
    tag: "scrypt + token rotation",
  },
  {
    name: "CMS",
    pkg: "@allinone/cms",
    desc: "Collections, revisions, draft → review → publish workflow.",
    tag: "localization-ready",
  },
  {
    name: "Infra",
    pkg: "@allinone/infra",
    desc: "Audit, API keys, webhooks, cache, subscriptions, rate limiting.",
    tag: "all opt-in",
  },
] as const;

const PRESETS = [
  { name: "starter", desc: "Single tenant, auth, basic RBAC, audit, storage." },
  { name: "saas", desc: "Multi-tenancy, orgs, billing, API keys, webhooks, entitlements." },
  { name: "enterprise", desc: "Hybrid tenancy, MFA, workflows, 365-day audit retention." },
  { name: "cms", desc: "Headless CMS, media, localization, SEO, content APIs." },
  { name: "ecommerce", desc: "Customers, catalog, orders, payment adapters, webhooks." },
] as const;

const ROADMAP = [
  {
    phase: "0–6",
    title: "Core + database (memory) + identity + tenancy + CMS + infra",
    status: "done",
  },
  { phase: "7a", title: "Postgres adapter (conformance + live PG17)", status: "done" },
  { phase: "7b", title: "MongoDB adapter", status: "next" },
  { phase: "7c", title: "SSO / OIDC, TOTP MFA, passkeys, recovery codes", status: "next" },
  { phase: "7d", title: "Separate-schema + database-per-tenant strategies", status: "next" },
  { phase: "7e", title: "Deployment examples, load + security benchmarking", status: "next" },
] as const;

export function App() {
  const [activePreset, setActivePreset] = useState<string>("saas");

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#overview">
            <span className="brand-mark">a1</span>
            <span>allinone docs</span>
          </a>
          <nav aria-label="Primary">
            <a href="#quickstart">Quick start</a>
            <a href="#architecture">Architecture</a>
            <a href="#presets">Presets</a>
            <a href="#security">Security</a>
            <a href="#roadmap">Roadmap</a>
          </nav>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar" aria-label="Docs navigation">
          <h2>Documentation</h2>
          <ul>
            {NAV.map((item) => (
              <li key={item.id}>
                <a href={`#${item.id}`}>{item.label}</a>
              </li>
            ))}
          </ul>
        </aside>

        <main className="main">
          <section id="overview" className="hero">
            <h1>
              Universal application platform, <span className="accent">secure by default</span>.
            </h1>
            <p>
              allinone is a modular package ecosystem for custom TypeScript frameworks —
              authentication, multi-tenancy, CMS, audit logging, and application infrastructure
              included. Database-agnostic, framework-native, preset-driven.
            </p>
            <div className="cta-row">
              <a className="btn btn-primary" href="#quickstart">
                Get started
              </a>
              <a className="btn" href="#architecture">
                View architecture
              </a>
            </div>
          </section>

          <section id="quickstart" className="section">
            <h2>Quick start</h2>
            <pre>
              <code>{QUICKSTART}</code>
            </pre>
          </section>

          <section id="architecture" className="section">
            <h2>Architecture</h2>
            <div className="box-grid">
              {MODULES.map((m) => (
                <article className="box" key={m.name}>
                  <h3>{m.name}</h3>
                  <p>{m.desc}</p>
                  <span className="tag">{m.pkg}</span>
                  {(m as { tag?: string }).tag ? (
                    <span className="tag">{(m as { tag?: string }).tag}</span>
                  ) : null}
                </article>
              ))}
            </div>
          </section>

          <section id="presets" className="section">
            <h2>Presets</h2>
            <p>
              Click a preset to preview its intent — presets are composable and every section can be
              overridden without replacing the preset.
            </p>
            <div className="chip-row" role="tablist" aria-label="Presets">
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  role="tab"
                  aria-selected={activePreset === p.name}
                  className={activePreset === p.name ? "chip active" : "chip"}
                  onClick={() => setActivePreset(p.name)}
                >
                  {p.name}()
                </button>
              ))}
            </div>
            <pre>
              <code>{`createPlatform({
  preset: presets.${activePreset}(),
  database: { adapter: "memory" },
  // override any single section:
  auth: { mfa: true },
});`}</code>
            </pre>
          </section>

          <section id="security" className="section">
            <h2>Security model</h2>
            <div className="box-grid">
              <article className="box">
                <h3>Default-deny authorization</h3>
                <p>
                  Every RBAC/ABAC check fails closed. Unknown permissions, evaluation errors, and
                  missing roles all deny.
                </p>
              </article>
              <article className="box">
                <h3>Tenant isolation</h3>
                <p>
                  Enforced at query time, with explicit async-safe context and membership-validated
                  resolvers. Never trust client tenant IDs.
                </p>
              </article>
              <article className="box">
                <h3>Token security</h3>
                <p>
                  Refresh tokens stored as SHA-256 hashes, rotated on use; reuse revokes the token
                  family. Passwords hashed (scrypt).
                </p>
              </article>
              <article className="box">
                <h3>Honest capabilities</h3>
                <p>
                  Adapters declare what they support. Unsupported operations throw instead of being
                  silently simulated.
                </p>
              </article>
            </div>
            <div className="table-wrap section">
              <table>
                <thead>
                  <tr>
                    <th>Invariant</th>
                    <th>Enforcement</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Default-deny stays enabled</td>
                    <td>assertSecure() throws</td>
                  </tr>
                  <tr>
                    <td>Tenant isolation stays enabled</td>
                    <td>assertSecure() throws</td>
                  </tr>
                  <tr>
                    <td>Cookies httpOnly + secure</td>
                    <td>Throws unless dangerouslyAllowInsecure</td>
                  </tr>
                  <tr>
                    <td>Refresh token rotation</td>
                    <td>Required; reuse revokes family</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="roadmap" className="section">
            <h2>Roadmap</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Phase</th>
                    <th>Scope</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {ROADMAP.map((r) => (
                    <tr key={r.phase}>
                      <td>{r.phase}</td>
                      <td>{r.title}</td>
                      <td>
                        <span className="tag">{r.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>

      <footer className="footer">
        <span>allinone — MIT</span>
        <span>Secure by default · Database-agnostic · Framework-native</span>
      </footer>
    </>
  );
}
