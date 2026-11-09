/**
 * @allinone/tenancy — enterprise multi-tenancy primitives.
 *
 * Security model:
 *  - Tenant context is EXPLICIT (AsyncLocalStorage), never ambient globals.
 *  - Tenant IDs are NEVER trusted from the client — resolvers must validate
 *    against authenticated membership + access policies.
 *  - Cross-tenant isolation is enforced at query time (defense in depth:
 *    app filter + DB row-level security where supported).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { TenancyStrategy } from "@allinone/config";

export type { TenancyStrategy };

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended" | "archived";
  strategy: TenancyStrategy;
  /** Custom domain / subdomain mapping. */
  domains: readonly string[];
  metadata: Record<string, unknown>;
}

export interface TenantResolverContext {
  subdomain?: string;
  hostname?: string;
  headerTenantId?: string;
  /** Authenticated user id — tenant must be derived FROM membership. */
  userId?: string;
}

export type TenantResolver = (ctx: TenantResolverContext) => Promise<string | null> | string | null;

/**
 * Explicit, async-safe tenant context.
 * Call `runWithTenant()` around request handling so background work
 * inherits the correct tenant; AsyncLocalStorage survives `await`.
 */
export class TenantContext {
  readonly #storage = new AsyncLocalStorage<{ tenantId: string }>();

  runWithTenant<T>(tenantId: string, fn: () => T): T {
    if (!tenantId) throw new Error("[allinone/tenancy] tenantId is required");
    return this.#storage.run({ tenantId }, fn);
  }

  /** Active tenant id, or null when no context is set (fail-closed). */
  getCurrent(): string | null {
    return this.#storage.getStore()?.tenantId ?? null;
  }

  /** Throw when no tenant is active — use for tenant-bound operations. */
  require(): string {
    const id = this.getCurrent();
    if (!id) {
      throw new Error(
        "[allinone/tenancy] No active tenant context. " +
          "Tenant-scoped work must run inside runWithTenant().",
      );
    }
    return id;
  }
}

/** In-memory tenant registry (swap for DB-backed in production). */
export class TenantRegistry {
  readonly #tenants = new Map<string, Tenant>();

  create(
    input: Omit<Tenant, "status" | "metadata"> & {
      status?: Tenant["status"];
      metadata?: Record<string, unknown>;
    },
  ): Tenant {
    const tenant: Tenant = {
      ...input,
      status: input.status ?? "active",
      metadata: input.metadata ?? {},
    };
    this.#tenants.set(tenant.id, tenant);
    return tenant;
  }

  get(id: string): Tenant | null {
    return this.#tenants.get(id) ?? null;
  }

  list(): Tenant[] {
    return [...this.#tenants.values()];
  }

  suspend(id: string): Tenant {
    const t = this.mustGet(id);
    const next = { ...t, status: "suspended" as const };
    this.#tenants.set(id, next);
    return next;
  }

  activate(id: string): Tenant {
    const t = this.mustGet(id);
    const next = { ...t, status: "active" as const };
    this.#tenants.set(id, next);
    return next;
  }

  archive(id: string): Tenant {
    const t = this.mustGet(id);
    const next = { ...t, status: "archived" as const };
    this.#tenants.set(id, next);
    return next;
  }

  /** Resolve via subdomain or custom domain. */
  resolveByDomain(hostname: string): Tenant | null {
    const host = hostname.toLowerCase();
    for (const t of this.#tenants.values()) {
      if (t.domains.some((d) => d.toLowerCase() === host)) return t;
      if (host === `${t.slug}.` || host.startsWith(`${t.slug}.`)) return t;
    }
    return null;
  }

  mustGet(id: string): Tenant {
    const t = this.#tenants.get(id);
    if (!t) throw new Error(`[allinone/tenancy] Tenant not found: ${id}`);
    return t;
  }
}

/**
 * Safe resolver factory — header-based resolution that VALIDATES
 * membership instead of trusting the header (header is only a hint).
 */
export function createHeaderResolver(
  registry: TenantRegistry,
  isMember: (userId: string, tenantId: string) => Promise<boolean> | boolean,
): TenantResolver {
  return async (ctx) => {
    if (!ctx.headerTenantId || !ctx.userId) return null;
    const tenant = registry.get(ctx.headerTenantId);
    if (!tenant || tenant.status !== "active") return null;
    const member = await isMember(ctx.userId, tenant.id);
    return member ? tenant.id : null;
  };
}

/** Tenant-aware cache key builder — prevents cross-tenant cache leakage. */
export function tenantCacheKey(tenantId: string, key: string): string {
  if (!tenantId) throw new Error("[allinone/tenancy] tenantId required for cache keys");
  return `t:${tenantId}:${key}`;
}
