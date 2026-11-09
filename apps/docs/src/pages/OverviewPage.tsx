import { PageHeader, Note } from "../components/Docs.js";
import { Link } from "react-router";

export function OverviewPage() {
  return (
    <>
      <PageHeader
        eyebrow="Getting started"
        title="Overview"
        intro={
          <>
            allinone is a modular package ecosystem for custom TypeScript frameworks —
            authentication, multi-tenancy, CMS, audit logging, and application infrastructure.
            Database-agnostic, framework-native, preset-driven.
          </>
        }
      />
      <div className="chip-row">
        <span className="chip">TypeScript strict</span>
        <span className="chip">ESLint typed rules</span>
        <span className="chip">Postgres + Mongo adapters</span>
        <span className="chip">TOTP MFA + OIDC SSO</span>
        <span className="chip">121 tests green</span>
      </div>
      <h2>What you get</h2>
      <div className="box-grid">
        <article className="box">
          <h3>Secure by default</h3>
          <p>
            Deny-by-default authorization, hashed refresh tokens with rotation + reuse detection,
            tenant isolation enforced at query time, append-only audit with hash-chain tamper
            detection.
          </p>
        </article>
        <article className="box">
          <h3>Database-agnostic</h3>
          <p>
            Capability-matrix adapters (Postgres + Mongo today). Unsupported features throw loudly —
            never silently simulated.
          </p>
        </article>
        <article className="box">
          <h3>Preset-driven</h3>
          <p>
            SaaS / Enterprise / CMS / E-commerce / Starter presets. Composable, section-overridable,
            invariants enforced.
          </p>
        </article>
        <article className="box">
          <h3>Framework-native</h3>
          <p>
            No React, Next.js, Express, or NestJS as runtime deps. Your framework keeps HTTP +
            rendering; allinone plugs in via providers + lifecycle hooks.
          </p>
        </article>
      </div>
      <div className="cta-row section">
        <Link className="btn btn-primary" to="/quickstart">
          Get started
        </Link>
        <Link className="btn" to="/database">
          Use a real database
        </Link>
        <Link className="btn" to="/deployment">
          Deploy to production
        </Link>
      </div>
      <Note>
        New here? Read <Link to="/install">Install</Link>, then{" "}
        <Link to="/quickstart">Quick start</Link>. Power users: jump to{" "}
        <Link to="/auth">Authentication &amp; MFA</Link> or <Link to="/tenancy">Multi-tenancy</Link>
        .
      </Note>
    </>
  );
}
