import { Code, Note, PageHeader, ROADMAP, Section } from "../components/Docs.js";
import { Link } from "react-router";

const MODULES = [
  {
    name: "allinone",
    pkg: "packages/platform",
    desc: "Public entry: createPlatform(), lifecycle, DI container, extensions.",
  },
  {
    name: "Config",
    pkg: "@allinone/config",
    desc: "Typed config + security invariants (default-deny, isolation).",
  },
  {
    name: "Presets",
    pkg: "@allinone/presets",
    desc: "starter / saas / enterprise / cms / ecommerce — composable.",
  },
  {
    name: "Database",
    pkg: "@allinone/database",
    desc: "Adapter contract, typed fields, conformance suite.",
    tag: "memory included",
  },
  {
    name: "Postgres",
    pkg: "@allinone/database-postgres",
    desc: "Transactions, migrations, RLS, soft deletes, schema-per-tenant.",
    tag: "PG17 verified",
  },
  {
    name: "MongoDB",
    pkg: "@allinone/database-mongodb",
    desc: "Document-native, NoSQL-injection-safe, DB-per-tenant.",
    tag: "local mongod",
  },
  {
    name: "MySQL",
    pkg: "@allinone/database-mysql",
    desc: "MySQL/MariaDB — InnoDB, prepared statements, savepoints.",
    tag: "MariaDB 11 verified",
  },
  {
    name: "Tenancy",
    pkg: "@allinone/tenancy",
    desc: "Registry, async-safe context, membership-validated resolvers.",
    tag: "4 strategies",
  },
  {
    name: "Auth",
    pkg: "@allinone/auth",
    desc: "Identity, sessions, RBAC + ABAC, TOTP MFA + OIDC SSO.",
    tag: "RFC vectors tested",
  },
  {
    name: "CMS",
    pkg: "@allinone/cms",
    desc: "Collections, revisions, draft → review → publish.",
    tag: "localization-ready",
  },
  {
    name: "Infra",
    pkg: "@allinone/infra",
    desc: "Audit, API keys, webhooks, cache, subscriptions, rate limiting.",
    tag: "all opt-in",
  },
] as const;

export function ArchitecturePage() {
  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="Architecture"
        intro={<>Logical package map. Core never imports optional modules.</>}
      />
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
      <Note>
        Dependency inversion everywhere: explicit interfaces for infrastructure, no circular deps,
        no global mutable state, stable versioned public APIs.
      </Note>
    </>
  );
}

const SECURITY_INVARIANTS = [
  ["Default-deny stays enabled", "assertSecure() throws"],
  ["Tenant isolation stays enabled", "assertSecure() throws"],
  ["Cookies httpOnly + secure", "Throws unless dangerouslyAllowInsecure"],
  ["Refresh token rotation", "Required; reuse revokes family"],
  ["Injection immunity", "Bound params (SQL) / primitives-only (Mongo)"],
] as const;

export function SecurityPage() {
  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="Security model"
        intro={
          <>
            Security is a foundational requirement, not an optional module. Invariants are enforced
            at startup — violations are <code>assertSecure()</code> throws, never silent downgrades.
          </>
        }
      />
      <div className="box-grid">
        <article className="box">
          <h3>Default-deny authorization</h3>
          <p>
            Every check fails closed. Unknown permissions, evaluation errors, and missing roles all
            deny.
          </p>
        </article>
        <article className="box">
          <h3>Tenant isolation</h3>
          <p>
            Enforced at query time; cache keys namespaced by tenant. Cross-tenant keys are a bug
            class, not an afterthought.
          </p>
        </article>
        <article className="box">
          <h3>Token security</h3>
          <p>
            Refresh tokens are SHA-256 hashed at rest, rotated on use; reuse revokes the family.
            Passwords scrypt-hashed.
          </p>
        </article>
        <article className="box">
          <h3>Honest capabilities</h3>
          <p>
            A transaction a backend cannot provide is never faked — adapters declare it{" "}
            <code>false</code> and throw.
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
            {SECURITY_INVARIANTS.map(([inv, enf]) => (
              <tr key={inv}>
                <td>{inv}</td>
                <td>{enf}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Baselines: OWASP ASVS, OWASP Top 10, CWE Top 25. Used as engineering checklists — not
        certifications. Read the full guides via the GitHub links in the sidebar.
      </p>
    </>
  );
}

const DEPLOY_EXAMPLE = `# .env (never commit .env)
DATABASE_URL=postgres://postgres:***@db.example.com:5432/allinone
MONGO_URL=mongodb://mongo.example.com:27017

# docker compose up -d  (local stack: Postgres 17 + Mongo 8)
docker compose up -d postgres mongo

# Production checks before every deploy
pnpm checks   # build + strict typecheck + typed lint + format + tests`;

export function DeploymentPage() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Deployment"
        intro={
          <>
            Production topology, provisioning snippets, and the full checklist live in{" "}
            <code>docs/DEPLOYMENT.md</code>. Local stack in 30 seconds:
          </>
        }
      />
      <Code>{DEPLOY_EXAMPLE}</Code>
      <p>
        Datastores stay private (no external ports); only your app opens HTTPS. Benchmarks:{" "}
        <code>pnpm bench</code> (smoke) — for load tests run k6/autocannon against the deployed app.
      </p>
      <Note>
        Enable GitHub Pages once in <b>Settings → Pages → Source: “GitHub Actions”</b>. PRs verify
        the docs build; <code>main</code> deploys automatically.
      </Note>
    </>
  );
}

export function RoadmapPage() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Roadmap"
        intro={
          <>
            Milestones ship incrementally — each is tested, documented, and production-grade before
            the next begins.
          </>
        }
      />
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
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader
        eyebrow="Missing page"
        title="Page not found"
        intro={<>That page does not exist in this documentation.</>}
      />
      <div className="cta-row">
        <Link className="btn btn-primary" to="/">
          Go home
        </Link>
        <Link className="btn" to="/roadmap">
          See roadmap
        </Link>
      </div>
      <Section eyebrow="Tip" title="Stale link?">
        <p>
          Docs moved recently. Please use the sidebar navigation — external reference links point at
          the GitHub repo.
        </p>
      </Section>
    </>
  );
}
