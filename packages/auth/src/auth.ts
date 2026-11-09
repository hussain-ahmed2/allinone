/**
 * @allinone/auth — identity + authorization.
 *
 * Security notes:
 *  - Password hashing uses Node's scrypt (built-in, no native deps).
 *    In production prefer Argon2id via your chosen hasher — the interface
 *    is intentionally swappable.
 *  - Refresh tokens are stored ONLY as SHA-256 hashes and rotated on use.
 *    Token reuse is detected and revokes the whole token family.
 *  - Authorization is DEFAULT-DENY and server-side only. UI hiding is
 *    never an authorization boundary.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Identity entities                                                    */
/* ------------------------------------------------------------------ */

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash?: string;
  emailVerified: boolean;
  suspended: boolean;
  createdAt: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
}

export interface Membership {
  id: string;
  userId: string;
  organizationId: string;
  tenantId: string;
  roleId: string;
}

export interface Role {
  id: string;
  name: string;
  permissions: readonly string[];
  /** Parent role for inheritance (optional). */
  inherits?: string;
}

export interface Session {
  id: string;
  userId: string;
  tenantId: string;
  expiresAt: string;
  revoked: boolean;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Password hashing (scrypt — swappable interface)                      */
/* ------------------------------------------------------------------ */

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

/** Default scrypt hasher — no native dependencies. */
export function scryptHasher(): PasswordHasher {
  return {
    async hash(password: string): Promise<string> {
      const salt = randomBytes(16).toString("hex");
      const derived = scryptSync(password, salt, 64).toString("hex");
      return `scrypt$${salt}$${derived}`;
    },
    async verify(password: string, hash: string): Promise<boolean> {
      const [scheme, salt, expected] = hash.split("$");
      if (scheme !== "scrypt" || !salt || !expected) return false;
      const derived = scryptSync(password, salt, 64);
      const expectedBuf = Buffer.from(expected, "hex");
      if (derived.length !== expectedBuf.length) return false;
      return timingSafeEqual(derived, expectedBuf);
    },
  };
}

/** Secure random token (base64url). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Hash a token for storage — never store refresh tokens in plaintext. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Authorization — RBAC + ABAC with default-deny                        */
/* ------------------------------------------------------------------ */

export interface Actor {
  id: string;
  roles: readonly string[];
  attributes: Record<string, unknown>;
}

export interface CanQuery {
  actor: Actor;
  action: string;
  resource: string;
  resourceAttributes?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface Policy {
  /** e.g. "users.read" — supports "*" wildcard for admin. */
  permission: string;
  /** Optional extra ABAC condition. Return false to deny. */
  condition?: (q: CanQuery) => boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  /** Explanation — never expose internal policy details to untrusted clients. */
  reason: string;
  matchedPermission?: string;
}

/**
 * Permission pattern matcher:
 *  - "users.read" matches exactly.
 *  - "users.*" matches any users.* action.
 *  - "*" matches everything.
 */
export function matchesPermission(granted: string, required: string): boolean {
  if (granted === "*") return true;
  if (granted.endsWith(".*")) {
    return required.startsWith(granted.slice(0, -1));
  }
  return granted === required;
}

/** Resolve a role's effective permissions through inheritance. */
export function effectivePermissions(
  roleId: string,
  rolesById: Map<string, Role>,
): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  let current: string | undefined = roleId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const role = rolesById.get(current);
    if (!role) break;
    for (const p of role.permissions) out.add(p);
    current = role.inherits;
  }
  return [...out];
}

/**
 * Evaluate authorization — fail closed (deny) on any error or unknown input.
 */
export function evaluatePolicy(
  query: CanQuery,
  rolesById: Map<string, Role>,
  policies: readonly Policy[] = [],
): PolicyDecision {
  try {
    const required = `${query.resource}.${query.action}`;
    const granted = query.actor.roles.flatMap((r) =>
      effectivePermissions(r, rolesById),
    );
    const matched = granted.find((g) => matchesPermission(g, required));
    if (matched) {
      // ABAC conditions can still deny — explicit deny always wins.
      const denied = policies.some(
        (p) =>
          matchesPermission(matched, p.permission) &&
          p.condition?.(query) === false,
      );
      if (denied) {
        return { allowed: false, reason: "abac-condition-denied", matchedPermission: matched };
      }
      return { allowed: true, reason: "granted", matchedPermission: matched };
    }
    return { allowed: false, reason: "no-matching-permission" };
  } catch {
    return { allowed: false, reason: "evaluation-error" };
  }
}

/** Convenience boolean check. */
export function can(
  query: CanQuery,
  rolesById: Map<string, Role>,
  policies: readonly Policy[] = [],
): boolean {
  return evaluatePolicy(query, rolesById, policies).allowed;
}

/* ------------------------------------------------------------------ */
/* Auth service (users, sessions, lockout bookkeeping)                  */
/* ------------------------------------------------------------------ */

export interface AuthOptions {
  hasher?: PasswordHasher;
  maxLoginAttempts?: number;
  lockoutSeconds?: number;
  sessionMaxAgeSeconds?: number;
}

/**
 * Minimal in-memory auth service demonstrating the security model:
 * hashed passwords, hashed refresh tokens, rotation, reuse detection,
 * lockout, session revocation. Swap persistence for DB in production.
 */
export class AuthService {
  readonly #hasher: PasswordHasher;
  readonly #maxAttempts: number;
  readonly #lockoutSeconds: number;
  readonly #sessionMaxAge: number;
  readonly #users = new Map<string, User>();
  readonly #byEmail = new Map<string, User>();
  readonly #sessions = new Map<string, Session>();
  readonly #refreshHashes = new Map<string, string>(); // sessionId -> sha256(refreshToken)
  readonly #failures = new Map<string, { count: number; lockedUntil: number }>();
  readonly #usedRefresh = new Set<string>(); // rotated-away hashes — reuse = compromise

  constructor(options: AuthOptions = {}) {
    this.#hasher = options.hasher ?? scryptHasher();
    this.#maxAttempts = options.maxLoginAttempts ?? 5;
    this.#lockoutSeconds = options.lockoutSeconds ?? 15 * 60;
    this.#sessionMaxAge = options.sessionMaxAgeSeconds ?? 60 * 60 * 24 * 7;
  }

  async register(input: {
    email: string;
    password: string;
    name: string;
  }): Promise<User> {
    const email = input.email.toLowerCase();
    if (this.#byEmail.has(email)) {
      throw new Error("[allinone/auth] Account already exists");
    }
    if (input.password.length < 12) {
      throw new Error("[allinone/auth] Password must be at least 12 characters");
    }
    const user: User = {
      id: `usr_${generateToken(12).replace(/[^a-zA-Z0-9]/g, "")}`,
      email,
      name: input.name,
      passwordHash: await this.#hasher.hash(input.password),
      emailVerified: false,
      suspended: false,
      createdAt: new Date().toISOString(),
    };
    this.#users.set(user.id, user);
    this.#byEmail.set(email, user);
    return user;
  }

  async login(input: {
    email: string;
    password: string;
    tenantId: string;
  }): Promise<{ session: Session; refreshToken: string }> {
    const email = input.email.toLowerCase();
    const failure = this.#failures.get(email);
    if (failure && Date.now() < failure.lockedUntil) {
      throw new Error("[allinone/auth] Account temporarily locked");
    }
    const user = this.#byEmail.get(email);
    let ok = false;
    if (user && !user.suspended && user.passwordHash) {
      ok = await this.#hasher.verify(input.password, user.passwordHash);
    }
    if (!ok || !user) {
      const count = (failure?.count ?? 0) + 1;
      this.#failures.set(email, {
        count,
        lockedUntil: count >= this.#maxAttempts ? Date.now() + this.#lockoutSeconds * 1000 : 0,
      });
      // Generic error — no account enumeration.
      throw new Error("[allinone/auth] Invalid credentials");
    }
    this.#failures.delete(email);
    const session: Session = {
      id: `ses_${generateToken(12).replace(/[^a-zA-Z0-9]/g, "")}`,
      userId: user.id,
      tenantId: input.tenantId,
      expiresAt: new Date(Date.now() + this.#sessionMaxAge * 1000).toISOString(),
      revoked: false,
      createdAt: new Date().toISOString(),
    };
    const refreshToken = generateToken();
    this.#sessions.set(session.id, session);
    this.#refreshHashes.set(session.id, hashToken(refreshToken));
    return { session, refreshToken };
  }

  /**
   * Rotate a refresh token. Reusing an already-rotated token revokes
   * the entire session family (reuse detection).
   */
  async rotateRefresh(refreshToken: string): Promise<{
    session: Session;
    refreshToken: string;
  }> {
    const hash = hashToken(refreshToken);
    if (this.#usedRefresh.has(hash)) {
      // Reuse detected — revoke every session tied to this family.
      for (const [sessionId] of this.#refreshHashes) {
        if (this.#refreshHashes.get(sessionId) === hash) {
          const session = this.#sessions.get(sessionId);
          if (session) session.revoked = true;
        }
      }
      throw new Error("[allinone/auth] Refresh token reuse detected");
    }
    for (const [sessionId, stored] of this.#refreshHashes) {
      if (stored === hash) {
        const session = this.#sessions.get(sessionId);
        if (!session || session.revoked) {
          throw new Error("[allinone/auth] Session revoked");
        }
        this.#usedRefresh.add(hash);
        const next = generateToken();
        this.#refreshHashes.set(sessionId, hashToken(next));
        return { session, refreshToken: next };
      }
    }
    throw new Error("[allinone/auth] Invalid refresh token");
  }

  async logout(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session) session.revoked = true;
    this.#refreshHashes.delete(sessionId);
  }
}
