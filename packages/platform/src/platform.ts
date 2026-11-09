/**
 * allinone — platform core.
 *
 * Framework-agnostic by design: the core exposes a `RequestContext` and
 * lifecycle hooks your custom framework can call, but it imports NO web
 * framework, NO React, and NO database driver. Adapters/providers are
 * injected; the framework stays in charge of HTTP + rendering.
 *
 * Typical usage:
 * ```ts
 * import { createPlatform, presets, fields } from "allinone";
 *
 * const platform = createPlatform({ preset: presets.saas(), database: { adapter: "memory" } });
 * await platform.initialize();
 * ```
 */
import { resolveConfig, type PlatformOptions, type ResolvedPlatformConfig } from "@allinone/config";
import { createMemoryAdapter, type DatabaseAdapter } from "@allinone/database";
import { TenantContext, TenantRegistry } from "@allinone/tenancy";
import { AuthService } from "@allinone/auth";
import { CmsStore } from "@allinone/cms";
import {
  ApiKeyStore,
  AuditLog,
  MemoryCache,
  RateLimiter,
  SubscriptionStore,
} from "@allinone/infra";

/* Re-export the public building blocks so `import { fields } from "allinone"`
 * works for the documented API without extra installs. */
export { fields } from "@allinone/database";
export { presets } from "@allinone/presets";
export type { DatabaseAdapter, DatabaseCapabilities } from "@allinone/database";

/** Framework-agnostic request context — your framework maps HTTP → this. */
export interface RequestContext {
  requestId: string;
  tenantId?: string;
  userId?: string;
  ip?: string;
  headers?: Record<string, string>;
  /** Escape hatch for framework-native values (req/res, etc. — untyped). */
  native?: unknown;
}

/** A platform module (plugin). Keep modules small + single-purpose. */
export interface PlatformModule {
  name: string;
  config?: Record<string, unknown>;
  /** Run once during initialize(), in registration order. */
  initialize(platform: Platform): Promise<void> | void;
  /** Graceful shutdown — reverse registration order. */
  shutdown?(): Promise<void> | void;
}

/** Hook points your framework can call at request boundaries. */
export interface LifecycleHooks {
  onRequest: readonly ((ctx: RequestContext) => Promise<void> | void)[];
  onResponse: readonly ((ctx: RequestContext) => Promise<void> | void)[];
  onError: readonly ((ctx: RequestContext, error: unknown) => Promise<void> | void)[];
}

/** Typed container — replaces a global DI singleton. */
export class Container {
  readonly #services = new Map<string, unknown>();

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  register<T>(token: string, value: T): void {
    if (this.#services.has(token)) {
      throw new Error(`[allinone] Duplicate service registration: ${token}`);
    }
    this.#services.set(token, value);
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  resolve<T>(token: string): T {
    const value = this.#services.get(token);
    if (value === undefined) throw new Error(`[allinone] Service not found: ${token}`);
    return value as T;
  }

  has(token: string): boolean {
    return this.#services.has(token);
  }
}

/** Platform error — carries a stable machine-readable code. */
export class PlatformError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
  }
}

/**
 * The configured platform instance.
 * Services are lazily constructed on first access — no eager app boot cost.
 */
export class Platform {
  readonly config: ResolvedPlatformConfig;
  readonly container = new Container();
  readonly lifecycle: LifecycleHooks = { onRequest: [], onResponse: [], onError: [] };

  readonly #modules: PlatformModule[] = [];
  readonly #db: DatabaseAdapter;
  readonly #tenants = new TenantRegistry();
  readonly #tenantContext = new TenantContext();
  readonly #auth: AuthService;
  readonly #cms = new CmsStore();
  readonly #audit = new AuditLog();
  readonly #apiKeys = new ApiKeyStore();
  readonly #cache = new MemoryCache();
  readonly #subscriptions = new SubscriptionStore();
  readonly #rateLimiter: RateLimiter;
  #initialized = false;

  constructor(options: PlatformOptions) {
    this.config = resolveConfig(options);
    this.#db = this.#resolveAdapter(options);
    this.#auth = new AuthService({
      maxLoginAttempts: this.config.auth.maxLoginAttempts,
      lockoutSeconds: this.config.auth.lockoutSeconds,
      sessionMaxAgeSeconds: this.config.auth.session.maxAgeSeconds,
    });
    this.#rateLimiter = new RateLimiter(100, 60);
    this.container.register("database", this.#db);
    this.container.register("tenants", this.#tenants);
    this.container.register("tenantContext", this.#tenantContext);
    this.container.register("auth", this.#auth);
    this.container.register("cms", this.#cms);
    this.container.register("audit", this.#audit);
    this.container.register("apiKeys", this.#apiKeys);
    this.container.register("cache", this.#cache);
    this.container.register("subscriptions", this.#subscriptions);
    this.container.register("rateLimiter", this.#rateLimiter);
  }

  #resolveAdapter(options: PlatformOptions): DatabaseAdapter {
    const instance = options.database.instance as DatabaseAdapter | undefined;
    if (instance && typeof instance.find === "function") {
      return instance;
    }
    if (options.database.adapter !== "memory") {
      throw new PlatformError(
        "DATABASE_ADAPTER_UNAVAILABLE",
        `[allinone] Database adapter "${options.database.adapter}" is not installed. ` +
          `Install the matching adapter package and pass it as ` +
          `database: { adapter: "${options.database.adapter}", instance: myAdapter }. ` +
          `Only "memory" ships in this repo and is intended for tests/examples.`,
      );
    }
    return createMemoryAdapter();
  }

  get database(): DatabaseAdapter {
    return this.#db;
  }

  get tenants(): TenantRegistry {
    return this.#tenants;
  }

  get tenantContext(): TenantContext {
    return this.#tenantContext;
  }

  get auth(): AuthService {
    return this.#auth;
  }

  get cms(): CmsStore {
    return this.#cms;
  }

  get audit(): AuditLog {
    return this.#audit;
  }

  get apiKeys(): ApiKeyStore {
    return this.#apiKeys;
  }

  get cache(): MemoryCache {
    return this.#cache;
  }

  get subscriptions(): SubscriptionStore {
    return this.#subscriptions;
  }

  get rateLimiter(): RateLimiter {
    return this.#rateLimiter;
  }

  /** Register a custom module — runs during initialize(). */
  extend(module: PlatformModule): this {
    if (this.#modules.some((m) => m.name === module.name)) {
      throw new PlatformError(
        "DUPLICATE_MODULE",
        `[allinone] Module already registered: ${module.name}`,
      );
    }
    this.#modules.push(module);
    return this;
  }

  /** Convenience: extend with several modules at once. */
  extendMany(modules: readonly PlatformModule[]): this {
    for (const m of modules) this.extend(m);
    return this;
  }

  /** Connect infrastructure + run module initialization, in order. */
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#db.connect();
    await this.#db.createTable?.("users");
    await this.#db.createTable?.("organizations");
    await this.#db.createTable?.("memberships");
    for (const module of this.#modules) {
      await module.initialize(this);
    }
    this.#initialized = true;
  }

  async shutdown(): Promise<void> {
    if (!this.#initialized) return;
    for (const module of [...this.#modules].reverse()) {
      await module.shutdown?.();
    }
    await this.#db.disconnect();
    this.#initialized = false;
  }

  get isInitialized(): boolean {
    return this.#initialized;
  }

  isModuleEnabled(name: string): boolean {
    const flags = this.config.modules;
    return (flags as unknown as Record<string, boolean>)[name] === true;
  }
}

/** Create + configure a platform instance (not yet initialized). */
export function createPlatform(options: PlatformOptions): Platform {
  return new Platform(options);
}
