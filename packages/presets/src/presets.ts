/**
 * @allinone/presets — composable, recommended configurations.
 *
 * Presets are plain `Partial<PlatformOptions>` values; they compose with
 * each other and with user options via `resolveConfig()` (user wins).
 * Nothing here enables insecure behaviour — every preset turns ON
 * secure defaults (see @allinone/config).
 */
import type { PlatformOptions } from "@allinone/config";

/** Starter — single tenant, auth + basic RBAC. */
export function starter(): PlatformOptions {
  return {
    database: { adapter: "memory" },
    tenancy: { strategy: "shared-schema", enforceIsolation: true },
    auth: { enabled: true, mfa: false },
    authorization: { mode: "rbac", defaultDeny: true },
    cms: { enabled: false, localization: false },
    audit: { enabled: true },
    modules: {
      storage: true,
      observability: true,
      admin: true,
    },
  };
}

/** SaaS — multi-tenancy, organizations, billing entitlements. */
export function saas(): PlatformOptions {
  return {
    database: { adapter: "memory" },
    tenancy: { strategy: "shared-schema", enforceIsolation: true },
    auth: { enabled: true, mfa: true },
    authorization: { mode: "rbac-abac", defaultDeny: true },
    audit: { enabled: true, retentionDays: 180 },
    modules: {
      billing: true,
      subscriptions: true,
      apiKeys: true,
      webhooks: true,
      notifications: true,
      rateLimit: true,
      cache: true,
      observability: true,
      admin: true,
    },
  };
}

/** Enterprise — SSO-ready, MFA, workflows, advanced audit. */
export function enterprise(): PlatformOptions {
  return {
    database: { adapter: "memory" },
    tenancy: { strategy: "hybrid", enforceIsolation: true },
    auth: { enabled: true, mfa: true, passwordless: false },
    authorization: { mode: "rbac-abac", defaultDeny: true },
    audit: { enabled: true, retentionDays: 365, immutable: true },
    modules: {
      billing: true,
      subscriptions: true,
      apiKeys: true,
      webhooks: true,
      notifications: true,
      workflows: true,
      rateLimit: true,
      cache: true,
      scheduler: true,
      observability: true,
      admin: true,
    },
  };
}

/** CMS — headless content + media + editorial workflows. */
export function cms(): PlatformOptions {
  return {
    database: { adapter: "memory" },
    tenancy: { strategy: "shared-schema", enforceIsolation: true },
    auth: { enabled: true, mfa: false },
    authorization: { mode: "rbac", defaultDeny: true },
    cms: { enabled: true, localization: true },
    audit: { enabled: true },
    modules: {
      media: true,
      storage: true,
      search: true,
      webhooks: true,
      observability: true,
      admin: true,
    },
  };
}

/** E-commerce — customers, catalog, orders, payment adapters. */
export function ecommerce(): PlatformOptions {
  return {
    database: { adapter: "memory" },
    tenancy: { strategy: "shared-schema", enforceIsolation: true },
    auth: { enabled: true, mfa: true },
    authorization: { mode: "rbac-abac", defaultDeny: true },
    audit: { enabled: true },
    modules: {
      billing: true,
      subscriptions: false,
      apiKeys: true,
      webhooks: true,
      notifications: true,
      media: true,
      storage: true,
      cache: true,
      rateLimit: true,
      observability: true,
      admin: true,
    },
  };
}

/**
 * Compose multiple presets — later presets win per-section.
 * Use to build custom combinations, e.g. `presets.compose(saas(), cms())`.
 */
export function compose(...presets: PlatformOptions[]): PlatformOptions {
  const out: PlatformOptions = { database: { adapter: "memory" } };
  for (const p of presets) {
    out.tenancy = { ...out.tenancy, ...p.tenancy };
    out.auth = { ...out.auth, ...p.auth };
    out.authorization = { ...out.authorization, ...p.authorization };
    out.cms = { ...out.cms, ...p.cms };
    out.audit = { ...out.audit, ...p.audit };
    out.modules = { ...out.modules, ...p.modules };
    if (p.database.adapter) out.database = p.database;
  }
  return out;
}

export const presets = { starter, saas, enterprise, cms, ecommerce, compose };
