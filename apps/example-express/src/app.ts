/**
 * @allinone/example-express — runnable Express integration for allinone.
 *
 * Demonstrates the platform mounted in a real (third-party) framework:
 * tenant resolution, cookie sessions, CSRF, RBAC guard, CMS endpoints,
 * API keys, rate limiting, audit, and framework-native error handling.
 *
 * Run:  pnpm example:express   (http://localhost:3000)
 */
import { createPlatform, presets } from "allinone";
import { can, generateToken } from "@allinone/auth";
import express, { type NextFunction, type Request, type Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      tenantId?: string;
    }
  }
}

export interface ExampleState {
  sessions: Map<string, { userId: string; tenantId: string; csrf: string; createdAt: string }>;
  memberships: Map<string, Set<string>>; // userId -> tenantIds
  roleAssignments: Map<string, Map<string, string[]>>; // tenantId -> userId -> roles
}

const ROLES = new Map([
  ["admin", { id: "admin", name: "Admin", permissions: ["users.*", "cms.posts.*", "keys.manage"] }],
  [
    "editor",
    { id: "editor", name: "Editor", permissions: ["posts.read", "posts.create", "posts.publish"] },
  ],
  ["viewer", { id: "viewer", name: "Viewer", permissions: ["posts.read"] }],
]);

function errorPayload(code: string, message: string, reason?: string) {
  return { error: { code, message, ...(reason ? { reason } : {}) } };
}

type Platform = ReturnType<typeof createPlatform>;

export async function createApp(): Promise<{ app: express.Express; platform: Platform }> {
  const platform = createPlatform({
    preset: presets.saas(),
    database: { adapter: "memory" },
    auth: { mfa: true },
    authorization: { mode: "rbac-abac", defaultDeny: true },
    cms: { enabled: true },
  });
  await platform.initialize();

  const state: ExampleState = {
    sessions: new Map(),
    memberships: new Map(),
    roleAssignments: new Map(),
  };

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  /* -------------------------------------------------------------- */
  /* Helpers                                                         */
  /* -------------------------------------------------------------- */

  function grantMembership(tenantId: string, userId: string, role: string): void {
    let set = state.memberships.get(userId);
    if (!set) {
      set = new Set();
      state.memberships.set(userId, set);
    }
    set.add(tenantId);
    let byUser = state.roleAssignments.get(tenantId);
    if (!byUser) {
      byUser = new Map();
      state.roleAssignments.set(tenantId, byUser);
    }
    const roles = byUser.get(userId) ?? [];
    if (!roles.includes(role)) roles.push(role);
    byUser.set(userId, roles);
  }

  function membershipsOf(userId: string): string[] {
    return [...(state.memberships.get(userId) ?? [])];
  }

  function rolesOf(tenantId: string, userId: string): string[] {
    return state.roleAssignments.get(tenantId)?.get(userId) ?? [];
  }

  function readSession(
    req: Request,
  ): { sessionId: string; userId: string; tenantId: string; csrf: string } | null {
    const cookie = req.headers.cookie ?? "";
    const match = /(?:^|;\s*)session=([^;]+)/.exec(cookie);
    if (!match?.[1]) return null;
    const session = state.sessions.get(match[1]);
    if (!session) return null;
    return {
      sessionId: match[1],
      userId: session.userId,
      tenantId: session.tenantId,
      csrf: session.csrf,
    };
  }

  function publicUser(userId: string) {
    const user = platform.auth.getUser(userId);
    if (!user) return null;
    return { id: user.id, email: user.email, name: user.name, tenants: membershipsOf(user.id) };
  }

  /* -------------------------------------------------------------- */
  /* Middleware                                                      */
  /* -------------------------------------------------------------- */

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = `req_${generateToken(8).replace(/[^a-zA-Z0-9]/g, "")}`;
    res.locals["requestId"] = requestId;
    req.requestId = requestId;
    next();
  });

  function audit(
    req: Request,
    action: string,
    resource: string,
    outcome: "success" | "failure",
  ): void {
    const session = readSession(req);
    const tenantHeader = req.get("x-tenant-id") ?? session?.tenantId ?? "unscoped";
    platform.audit.append({
      actorId: session?.userId ?? "anonymous",
      tenantId: tenantHeader,
      action,
      resource,
      outcome,
      correlationId: req.requestId ?? "unknown",
      ...(req.ip ? { ip: req.ip } : {}),
      metadata: { route: req.path },
    });
  }

  /** Express 5 `params` values may be `string | string[]` — take the first. */
  function first(value: string | string[] | undefined): string {
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  }

  /** Tenant id recorded on a CMS entry's data (string-or-nothing). */
  function tenantOf(entry: { data: Record<string, unknown> }): string {
    const value = entry.data["tenantId"];
    return typeof value === "string" ? value : "";
  }

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const session = readSession(req);
    if (!session) {
      res.status(401).json(errorPayload("UNAUTHORIZED", "Authentication required"));
      return;
    }
    audit(req, "session.check", "session", "success");
    next();
  }

  function requireTenant(req: Request, res: Response, next: NextFunction): void {
    const session = readSession(req);
    if (!session) {
      res.status(401).json(errorPayload("UNAUTHORIZED", "Authentication required"));
      return;
    }
    const requested = req.get("x-tenant-id");
    const effective = requested ?? session.tenantId;
    if (!membershipsOf(session.userId).includes(effective)) {
      audit(req, "tenancy.resolve", effective, "failure");
      res.status(403).json(errorPayload("TENANT_FORBIDDEN", "Tenant membership required"));
      return;
    }
    req.tenantId = effective;
    next();
  }

  function requirePermission(
    resource: string,
    action: string,
  ): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
      const session = readSession(req);
      if (!session) {
        res.status(401).json(errorPayload("UNAUTHORIZED", "Authentication required"));
        return;
      }
      const tenantId = req.tenantId ?? session.tenantId;
      const allowed = can(
        {
          actor: { id: session.userId, roles: rolesOf(tenantId, session.userId), attributes: {} },
          action,
          resource,
          context: { requestId: String(res.locals["requestId"] ?? "") },
        },
        ROLES,
      );
      if (!allowed) {
        audit(req, "authorization.check", `${resource}.${action}`, "failure");
        res
          .status(403)
          .json(
            errorPayload(
              "FORBIDDEN",
              `Missing permission: ${resource}.${action}`,
              "no-matching-permission",
            ),
          );
        return;
      }
      next();
    };
  }

  function requireCsrf(req: Request, res: Response, next: NextFunction): void {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }
    const session = readSession(req);
    const token = req.get("x-csrf-token") ?? "";
    if (!session || token !== session.csrf) {
      res.status(403).json(errorPayload("CSRF", "CSRF token required"));
      return;
    }
    next();
  }

  function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (!platform.rateLimiter.allow(req.ip ?? "unknown")) {
      res
        .status(429)
        .setHeader("Retry-After", "60")
        .json(errorPayload("RATE_LIMITED", "Too many requests"));
      return;
    }
    next();
  }

  function setSessionCookies(res: Response, sessionId: string, csrf: string): void {
    res.setHeader("Set-Cookie", [
      `session=${sessionId}; HttpOnly; SameSite=Lax; Path=/`,
      `csrf=${csrf}; SameSite=Lax; Path=/`,
    ]);
  }

  /** Wrap async handlers — forward rejections to the error middleware. */
  const ah =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      handler(req, res).catch(next);
    };

  /* -------------------------------------------------------------- */
  /* Routes                                                          */
  /* -------------------------------------------------------------- */

  app.get(
    "/health",
    ah(async (req, res) => {
      const database = await platform.database.healthCheck();
      res.json({ ok: database.ok, database, service: "example-express" });
    }),
  );

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      service: "allinone example (express)",
      endpoints: [
        "POST /api/auth/register",
        "POST /api/auth/login",
        "POST /api/auth/logout",
        "POST /api/tenants",
        "GET /api/cms/posts",
        "POST /api/cms/posts",
        "POST /api/cms/posts/:id/publish",
        "GET /api/admin/me",
        "POST /api/keys",
        "GET /api/version",
      ],
    });
  });

  const authLimiter = express.Router();
  authLimiter.use(rateLimit);

  app.use("/api/auth", authLimiter);

  // Register/login establish the session — no CSRF check here (there is
  // no session yet); CSRF applies to authenticated state changes only.
  app.post(
    "/api/auth/register",
    ah(async (req, res) => {
      const { email, password, name } = req.body as Record<string, unknown>;
      if (typeof email !== "string" || typeof password !== "string" || typeof name !== "string") {
        res.status(400).json(errorPayload("VALIDATION", "email, password, and name are required"));
        return;
      }
      try {
        const user = await platform.auth.register({ email, password, name });
        const tenant = platform.tenants.create({
          id: `t_${generateToken(8).replace(/[^a-zA-Z0-9]/g, "")}`,
          name: `${name}'s workspace`,
          slug: `ws-${user.id.slice(-6)}`,
          strategy: "shared-schema",
          domains: [],
        });
        grantMembership(tenant.id, user.id, "admin");
        const sessionId = generateToken();
        const csrf = generateToken();
        state.sessions.set(sessionId, {
          userId: user.id,
          tenantId: tenant.id,
          csrf,
          createdAt: new Date().toISOString(),
        });
        setSessionCookies(res, sessionId, csrf);
        audit(req, "auth.register", "user", "success");
        res.status(201).json({ user: publicUser(user.id) });
      } catch (error) {
        audit(req, "auth.register", "user", "failure");
        res
          .status(400)
          .json(
            errorPayload(
              "AUTH_ERROR",
              error instanceof Error ? error.message : "Registration failed",
            ),
          );
      }
    }),
  );

  app.post(
    "/api/auth/login",
    ah(async (req, res) => {
      const { email, password } = req.body as Record<string, unknown>;
      if (typeof email !== "string" || typeof password !== "string") {
        res.status(400).json(errorPayload("VALIDATION", "email and password are required"));
        return;
      }
      const requested = req.get("x-tenant-id");
      try {
        const { session } = await platform.auth.login({
          email,
          password,
          tenantId: requested ?? "personal",
        });
        const sessionId = generateToken();
        const csrf = generateToken();
        state.sessions.set(sessionId, {
          userId: session.userId,
          tenantId: session.tenantId,
          csrf,
          createdAt: new Date().toISOString(),
        });
        setSessionCookies(res, sessionId, csrf);
        audit(req, "auth.login", "session", "success");
        res.json({ user: publicUser(session.userId) });
      } catch {
        audit(req, "auth.login", "session", "failure");
        res.status(401).json(errorPayload("UNAUTHORIZED", "Invalid credentials"));
      }
    }),
  );

  app.post(
    "/api/auth/logout",
    requireAuth,
    ah(async (req, res) => {
      const session = readSession(req);
      if (session) {
        state.sessions.delete(session.sessionId);
        await platform.auth.logout(session.sessionId).catch(() => undefined);
      }
      res.setHeader("Set-Cookie", [
        "session=; HttpOnly; Max-Age=0; Path=/",
        "csrf=; Max-Age=0; Path=/",
      ]);
      audit(req, "auth.logout", "session", "success");
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/tenants",
    requireAuth,
    requireTenant,
    requireCsrf,
    ah(async (req, res) => {
      const { name, slug } = req.body as Record<string, unknown>;
      if (typeof name !== "string" || typeof slug !== "string") {
        res.status(400).json(errorPayload("VALIDATION", "name and slug are required"));
        return;
      }
      const session = readSession(req);
      if (!session) return;
      const tenant = platform.tenants.create({
        id: `t_${generateToken(8).replace(/[^a-zA-Z0-9]/g, "")}`,
        name,
        slug,
        strategy: "shared-schema",
        domains: [],
      });
      grantMembership(tenant.id, session.userId, "admin");
      audit(req, "tenancy.create", tenant.id, "success");
      res.status(201).json({ tenant });
    }),
  );

  app.post(
    "/api/tenants/:tenantId/members",
    requireAuth,
    requireCsrf,
    ah(async (req, res) => {
      const tenantId = first(req.params["tenantId"]);
      const { userId, role } = req.body as Record<string, unknown>;
      const session = readSession(req);
      if (!session) return;
      if (!platform.tenants.get(tenantId)) {
        res.status(404).json(errorPayload("NOT_FOUND", "Tenant not found"));
        return;
      }
      if (
        typeof userId !== "string" ||
        (role !== "admin" && role !== "editor" && role !== "viewer")
      ) {
        res
          .status(400)
          .json(errorPayload("VALIDATION", "userId and role (admin|editor|viewer) are required"));
        return;
      }
      const allowed = can(
        {
          actor: { id: session.userId, roles: rolesOf(tenantId, session.userId), attributes: {} },
          action: "update",
          resource: "users",
        },
        ROLES,
      );
      if (!allowed) {
        audit(req, "authorization.check", "users.update", "failure");
        res
          .status(403)
          .json(
            errorPayload("FORBIDDEN", "Missing permission: users.update", "no-matching-permission"),
          );
        return;
      }
      grantMembership(tenantId, userId, role);
      audit(req, "tenancy.member.add", tenantId, "success");
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/cms/posts",
    requireAuth,
    requireTenant,
    requirePermission("cms.posts", "read"),
    ah(async (req, res) => {
      const tenantId = req.tenantId ?? "";
      const publishedOnly = req.query["status"] === "published";
      const entries = platform.cms
        .findByCollection("posts", publishedOnly ? "published" : undefined)
        .filter((entry) => tenantOf(entry) === tenantId);
      res.json({ posts: entries });
    }),
  );

  app.post(
    "/api/cms/posts",
    requireAuth,
    requireTenant,
    requirePermission("cms.posts", "create"),
    requireCsrf,
    ah(async (req, res) => {
      const session = readSession(req);
      if (!session) return;
      const { title, body } = req.body as Record<string, unknown>;
      if (typeof title !== "string") {
        res.status(400).json(errorPayload("VALIDATION", "title is required"));
        return;
      }
      const entry = platform.cms.create({
        collection: "posts",
        data: {
          title,
          body: typeof body === "string" ? body : "",
          tenantId: req.tenantId ?? session.tenantId,
        },
        slug:
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "untitled",
        createdBy: session.userId,
      });
      audit(req, "cms.create", entry.id, "success");
      res.status(201).json({ post: entry });
    }),
  );

  app.post(
    "/api/cms/posts/:postId/publish",
    requireAuth,
    requireTenant,
    requirePermission("cms.posts", "publish"),
    requireCsrf,
    ah(async (req, res) => {
      const postId = first(req.params["postId"]);
      if (!postId) {
        res.status(400).json(errorPayload("VALIDATION", "postId is required"));
        return;
      }
      try {
        const draft = platform.cms.findByCollection("posts").find((e) => e.id === postId);
        if (!draft || tenantOf(draft) !== (req.tenantId ?? "")) {
          res.status(404).json(errorPayload("NOT_FOUND", "Post not found"));
          return;
        }
        if (draft.status === "draft") platform.cms.submitForReview(postId);
        const published = platform.cms.publish(postId);
        audit(req, "cms.publish", postId, "success");
        res.json({ post: published });
      } catch (error) {
        audit(req, "cms.publish", postId, "failure");
        res
          .status(400)
          .json(
            errorPayload("CMS_ERROR", error instanceof Error ? error.message : "Publish failed"),
          );
      }
    }),
  );

  app.get(
    "/api/admin/me",
    requireAuth,
    requireTenant,
    ah(async (req, res) => {
      const session = readSession(req);
      if (!session) return;
      res.json({
        user: publicUser(session.userId),
        tenant: platform.tenants.get(req.tenantId ?? "") ?? null,
        roles: rolesOf(req.tenantId ?? "", session.userId),
      });
    }),
  );

  app.post(
    "/api/keys",
    requireAuth,
    requireTenant,
    requireCsrf,
    ah(async (req, res) => {
      const session = readSession(req);
      if (!session) return;
      const { name, scopes } = req.body as Record<string, unknown>;
      const scopeList = Array.isArray(scopes)
        ? scopes.filter((s): s is string => typeof s === "string")
        : [];
      const { record, secret } = platform.apiKeys.create({
        tenantId: session.tenantId,
        name: typeof name === "string" ? name : "untitled",
        scopes: scopeList,
      });
      audit(req, "api.keys.create", record.id, "success");
      // The secret appears exactly once — never log it.
      res.status(201).json({ id: record.id, scopes: record.scopes, secret });
    }),
  );

  app.get(
    "/api/v1/status",
    ah(async (req, res) => {
      const rawKey = req.get("x-api-key");
      if (!rawKey) {
        res.status(401).json(errorPayload("UNAUTHORIZED", "API key required"));
        return;
      }
      const record = platform.apiKeys.verify(rawKey, "status.read");
      if (!record) {
        res.status(403).json(errorPayload("FORBIDDEN", "Invalid or out-of-scope API key"));
        return;
      }
      res.json({ ok: true, tenantId: record.tenantId });
    }),
  );

  app.get("/api/version", (_req: Request, res: Response) => {
    res.json({ version: "0.1.0", preset: "saas" });
  });

  /* -------------------------------------------------------------- */
  /* Error + shutdown wiring                                         */
  /* -------------------------------------------------------------- */

  app.use((err: unknown, _req: Request, res: Response) => {
    const status = (err as { status?: number } | null)?.status ?? 500;
    res.setHeader("content-type", "application/json");
    res
      .status(status >= 400 && status < 600 ? status : 500)
      .send(
        errorPayload(
          status >= 500 ? "INTERNAL" : "ERROR",
          status >= 500 ? "Internal server error" : "Request failed",
        ),
      );
  });

  return { app, platform };
}

export async function start(port = Number(process.env["PORT"] ?? 3000)): Promise<void> {
  const { app, platform } = await createApp();
  const server = app.listen(port, () => {
    console.log(`example-express listening on http://localhost:${String(port)}`);
  });
  const shutdown = (): void => {
    server.close(() => {
      void platform.shutdown().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
