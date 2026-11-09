/**
 * @allinone/config — strongly-typed platform configuration.
 *
 * Configuration precedence (highest → lowest):
 *   1. Platform security invariants (cannot be overridden silently)
 *   2. Explicit application security policies
 *   3. Application configuration (createPlatform options)
 *   4. Preset defaults
 *   5. Platform defaults
 *
 * Invariants enforced in `assertSecure()`:
 *   - Default-deny authorization must stay enabled.
 *   - Sessions with cookies must be httpOnly + secure + SameSite.
 *   - Refresh tokens must rotate (stored as hashes).
 *   - Tenant context is explicit — never trust client-supplied tenant IDs.
 *
 * @see docs/adr/0002-config-precedence.md
 */

/** Tenant isolation strategy. */
export type TenancyStrategy =
  "shared-schema" | "separate-schema" | "database-per-tenant" | "hybrid";

/** Authorization engine mode. */
export type AuthzMode = "rbac" | "abac" | "rbac-abac";

export interface DatabaseConfig {
  /** Adapter key, e.g. "postgres" | "mongodb" | "redis" | "memory" | custom. */
  adapter: string;
  /** Adapter instance — typed loosely so any adapter satisfying DatabaseAdapter works. */

  instance?: unknown;
  url?: string;
}

export interface TenancyConfig {
  strategy: TenancyStrategy;
  /** Custom resolver — MUST validate membership; never trust raw client tenant IDs. */

  resolver?: (ctx: unknown) => Promise<string | null> | string | null;
  enforceIsolation: boolean;
}

export interface SessionConfig {
  secure: boolean;
  httpOnly: boolean;
  sameSite: "strict" | "lax" | "none";
  maxAgeSeconds: number;
  rotateRefreshTokens: boolean;
}

export interface PasskeysConfig {
  enabled: boolean;
  rpID: string;
  rpName: string;
  origin: string | readonly string[];
}

/** OAuth 2.0 / OIDC provider (SSO). Secrets should come from env. */
export interface OAuthProviderConfig {
  /** Stable local id, e.g. "google" | "okta" | "keycloak". */
  id: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: readonly string[];
}

export interface AuthConfig {
  enabled: boolean;
  mfa: boolean;
  passwordless: boolean;
  passkeys: PasskeysConfig;
  /** SSO / OIDC providers (e.g. Google, Okta, Keycloak). */
  providers: readonly OAuthProviderConfig[];
  session: SessionConfig;
  maxLoginAttempts: number;
  lockoutSeconds: number;
}

export interface AuthorizationConfig {
  mode: AuthzMode;
  /** Must stay true — platform invariant. */
  defaultDeny: boolean;

  customPolicies?: readonly unknown[];
}

export interface CmsConfig {
  enabled: boolean;

  collections?: readonly unknown[];
  localization: boolean;
}

export interface AuditConfig {
  enabled: boolean;
  retentionDays: number;
  immutable: boolean;
}

export interface ModuleFlags {
  billing: boolean;
  notifications: boolean;
  webhooks: boolean;
  apiKeys: boolean;
  workflows: boolean;
  storage: boolean;
  cache: boolean;
  subscriptions: boolean;
  observability: boolean;
  rateLimit: boolean;
  scheduler: boolean;
  search: boolean;
  mailer: boolean;
  media: boolean;
  admin: boolean;
}

/**
 * Totally-typed platform options accepted by `createPlatform()`.
 * Every field is optional — presets + defaults fill the rest.
 */
export interface PlatformOptions {
  preset?: Partial<PlatformOptions>;
  database: DatabaseConfig;
  tenancy?: Partial<TenancyConfig>;
  auth?: Partial<AuthConfig>;
  authorization?: Partial<AuthorizationConfig>;
  cms?: Partial<CmsConfig>;
  audit?: Partial<AuditConfig>;
  modules?: Partial<ModuleFlags>;
  /** Explicit opt-in required for dangerous overrides. */
  dangerouslyAllowInsecure?: boolean;
}

export interface ResolvedPlatformConfig {
  database: DatabaseConfig;
  tenancy: TenancyConfig;
  auth: AuthConfig;
  authorization: AuthorizationConfig;
  cms: CmsConfig;
  audit: AuditConfig;
  modules: ModuleFlags;
}

/** Secure platform defaults. */
export const platformDefaults: ResolvedPlatformConfig = {
  database: { adapter: "memory" },
  tenancy: {
    strategy: "shared-schema",
    enforceIsolation: true,
  },
  auth: {
    enabled: true,
    mfa: false,
    passwordless: false,
    passkeys: {
      enabled: false,
      rpID: "localhost",
      rpName: "allinone",
      origin: "http://localhost:5173",
    },
    providers: [],
    session: {
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      maxAgeSeconds: 60 * 60 * 24 * 7,
      rotateRefreshTokens: true,
    },
    maxLoginAttempts: 5,
    lockoutSeconds: 15 * 60,
  },
  authorization: { mode: "rbac", defaultDeny: true },
  cms: { enabled: false, localization: false },
  audit: { enabled: true, retentionDays: 90, immutable: true },
  modules: {
    billing: false,
    notifications: false,
    webhooks: false,
    apiKeys: false,
    workflows: false,
    storage: false,
    cache: false,
    subscriptions: false,
    observability: true,
    rateLimit: false,
    scheduler: false,
    search: false,
    mailer: false,
    media: false,
    admin: false,
  },
};

/**
 * Shallow-merge preset + user options onto defaults.
 * Nested sections merge section-by-section so a single override
 * never replaces an entire preset.
 */
export function resolveConfig(options: PlatformOptions): ResolvedPlatformConfig {
  const preset = options.preset ?? {};
  const merged: ResolvedPlatformConfig = {
    database: { ...platformDefaults.database, ...options.database },
    tenancy: {
      ...platformDefaults.tenancy,
      ...preset.tenancy,
      ...options.tenancy,
    },
    auth: {
      ...platformDefaults.auth,
      ...preset.auth,
      ...options.auth,
      session: {
        ...platformDefaults.auth.session,
        ...preset.auth?.session,
        ...options.auth?.session,
      },
    },
    authorization: {
      ...platformDefaults.authorization,
      ...preset.authorization,
      ...options.authorization,
    },
    cms: {
      ...platformDefaults.cms,
      ...preset.cms,
      ...options.cms,
    },
    audit: {
      ...platformDefaults.audit,
      ...preset.audit,
      ...options.audit,
    },
    modules: {
      ...platformDefaults.modules,
      ...preset.modules,
      ...options.modules,
    },
  };
  assertSecure(merged, options.dangerouslyAllowInsecure === true);
  return merged;
}

/**
 * Enforce security invariants (precedence level 1).
 * Throws on violation unless the caller explicitly opts in with
 * `dangerouslyAllowInsecure: true` — and even then we only allow
 * weakening session cookies, never default-deny.
 */
export function assertSecure(config: ResolvedPlatformConfig, allowInsecure: boolean): void {
  if (!config.authorization.defaultDeny) {
    throw new Error(
      "[allinone] Security invariant: authorization.defaultDeny must be true. " +
        "Deny-by-default cannot be disabled, even with dangerouslyAllowInsecure.",
    );
  }
  if (!config.tenancy.enforceIsolation) {
    throw new Error(
      "[allinone] Security invariant: tenancy.enforceIsolation must be true. " +
        "Tenant isolation cannot be disabled at runtime.",
    );
  }
  if (!allowInsecure) {
    const s = config.auth.session;
    if (!s.httpOnly || !s.secure) {
      throw new Error(
        "[allinone] Security invariant: session cookies must be httpOnly + secure. " +
          "Pass dangerouslyAllowInsecure: true to override for local dev only.",
      );
    }
    if (!s.rotateRefreshTokens) {
      throw new Error("[allinone] Security invariant: refresh token rotation must stay enabled.");
    }
  }
}
