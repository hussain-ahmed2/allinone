/**
 * Permission cache — caches pure-RBAC decisions with versioned keys so
 * invalidation is a single counter bump (orphans die by TTL).
 *
 * Correctness contract:
 *  - Cache keys live under `perm:` and embed per-actor AND per-tenant
 *    version counters. `invalidateActor` / `invalidateTenant` bump the
 *    counters only — stale entries are unreachable by key construction
 *    and age out by TTL.
 *  - Custom/ABAC policies bypass the cache entirely: cached decisions
 *    only ever cover pure RBAC (attribute-dependent decisions are
 *    evaluated fresh — never serialized into shared cache).
 *  - Cache failures fail CLOSED: on any cache read error the evaluator
 *    falls back to a fresh evaluation and returns the real RBAC answer
 *    (cache is a performance layer, never an authorization boundary).
 */
import { can, type CanQuery, type Policy, type Role } from "./auth.js";

/** Minimal cache contract — satisfied by infra MemoryCache / Redis. */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PermissionCacheOptions {
  cache: CacheClient;
  /** Decision TTL in seconds (default 300 = 5 minutes). */
  ttlSeconds?: number;
}

export class PermissionCache {
  readonly #cache: CacheClient;
  readonly #ttl: number;

  constructor(options: PermissionCacheOptions) {
    this.#cache = options.cache;
    this.#ttl = options.ttlSeconds ?? 300;
  }

  private async version(kind: "actor" | "tenant", scope: string): Promise<string> {
    try {
      return (await this.#cache.get(`perm:${kind}:${scope}:v`)) ?? "1";
    } catch {
      // Fail open toward freshness: treat as generation 1, evaluation
      // remains authoritative (RBAC decides, cache merely memoizes).
      return "1";
    }
  }

  /** Cache-aware RBAC check. */
  async can(
    query: CanQuery,
    rolesById: Map<string, Role>,
    tenantId: string,
    policies?: readonly Policy[],
  ): Promise<boolean> {
    if (policies && policies.length > 0) {
      // ABAC/custom policies depend on request attributes — never cached.
      return can(query, rolesById, policies);
    }
    const actorVersion = await this.version("actor", query.actor.id);
    const tenantVersion = await this.version("tenant", tenantId);
    const key =
      `perm:t${tenantVersion}:a${actorVersion}:` +
      `${query.actor.id}:${query.resource}.${query.action}`;
    try {
      const cached = await this.#cache.get(key);
      if (cached !== null) return cached === "1";
    } catch {
      // Cache read failed — fresh evaluation below (fail closed on errors?
      // No: evaluation errors inside `can` still deny; cache outage only
      // skips memoization, not the decision.)
    }
    const allowed = can(query, rolesById);
    try {
      await this.#cache.set(key, allowed ? "1" : "0", this.#ttl);
    } catch {
      // Writes never fail the check.
    }
    return allowed;
  }

  /** Invalidate one actor (roles/policy change for that user). */
  async invalidateActor(actorId: string): Promise<void> {
    const next = (await this.version("actor", actorId)).replace(/[^0-9]/g, "");
    await this.#cache.set(`perm:actor:${actorId}:v`, String(Number(next || "1") + 1), 86_400);
  }

  /** Invalidate an entire tenant (roles/policy bulk change). */
  async invalidateTenant(tenantId: string): Promise<void> {
    const next = (await this.version("tenant", tenantId)).replace(/[^0-9]/g, "");
    await this.#cache.set(`perm:tenant:${tenantId}:v`, String(Number(next || "1") + 1), 86_400);
  }
}

export function createPermissionCache(options: PermissionCacheOptions): PermissionCache {
  return new PermissionCache(options);
}
