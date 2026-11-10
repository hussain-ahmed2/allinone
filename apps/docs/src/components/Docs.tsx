import type { ReactNode } from "react";

export const GITHUB = "https://github.com/hussain-ahmed2/allinone";

export function Code({ title, children }: { title?: string; children: string }) {
  return (
    <div className="code-block">
      {title ? <div className="code-title">{title}</div> : null}
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="note">{children}</div>;
}

export function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="section">
      <div className="eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function PageHeader({
  eyebrow,
  title,
  intro,
}: {
  eyebrow: string;
  title: string;
  intro: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{intro}</p>
    </div>
  );
}

export interface NavEntry {
  to: string;
  label: string;
  external?: string;
}

export interface NavGroup {
  group: string;
  entries: NavEntry[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    group: "Getting started",
    entries: [
      { to: "/", label: "Overview" },
      { to: "/install", label: "Install" },
      { to: "/quickstart", label: "Quick start" },
      { to: "/presets", label: "Compose & presets" },
      { to: "/express", label: "Express integration" },
      { to: "/frameworks", label: "Framework integrations" },
      { to: "/architecture", label: "Architecture" },
    ],
  },
  {
    group: "Guides",
    entries: [
      { to: "/database", label: "Database" },
      { to: "/tenancy", label: "Multi-tenancy" },
      { to: "/auth", label: "Authentication & MFA" },
      { to: "/sso", label: "SSO / OIDC" },
      { to: "/authz", label: "Authorization" },
      { to: "/cms", label: "CMS" },
      { to: "/infra", label: "Audit & infra" },
    ],
  },
  {
    group: "Reference",
    entries: [
      { to: "/security", label: "Security model" },
      { to: "#", label: "API reference ↗", external: `${GITHUB}/blob/main/docs/API.md` },
      {
        to: "#",
        label: "Troubleshooting ↗",
        external: `${GITHUB}/blob/main/docs/TROUBLESHOOTING.md`,
      },
    ],
  },
  {
    group: "Operations",
    entries: [
      { to: "/deployment", label: "Deployment" },
      { to: "/roadmap", label: "Roadmap" },
    ],
  },
];

export const ROADMAP = [
  {
    phase: "0–6",
    title: "Core + database (memory) + identity + tenancy + CMS + infra",
    status: "done",
  },
  { phase: "7a", title: "Postgres adapter (conformance + live PG17)", status: "done" },
  { phase: "7b", title: "MongoDB adapter (conformance + local mongod)", status: "done" },
  { phase: "7c", title: "SSO / OIDC, TOTP MFA, recovery codes", status: "done" },
  { phase: "7d", title: "Separate-schema (PG) + DB-per-tenant (Mongo)", status: "done" },
  { phase: "7e", title: "Deployment guide + docker stack + benchmarks", status: "done" },
  { phase: "7f", title: "CI checks + API reference + troubleshooting", status: "done" },
  { phase: "7g", title: "MySQL/MariaDB adapter", status: "done" },
  { phase: "7h", title: "SQLite + Redis adapters", status: "done" },
  { phase: "7h", title: "Coverage audit (adapters + security)", status: "next" },
  { phase: "7i", title: "Passkeys/WebAuthn, proven in production", status: "next" },
] as const;
