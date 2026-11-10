/**
 * @allinone/example-fastify — runnable Fastify integration for allinone.
 *
 * Fastify idioms throughout:
 *   - `preHandler` hooks (request id, tenant, auth, permissions)
 *   - `fastify.inject()` in tests (in-process, no sockets)
 * Routes mirror apps/example-express for behavioral parity.
 */
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createPlatform, presets } from "allinone";
import { can, generateToken } from "@allinone/auth";
import { buildAdminManifest } from "@allinone/infra";

type Platform = ReturnType<typeof createPlatform>;

const ROLES = new Map([
  [
    "admin",
    {
      id: "admin",
      name: "Admin",
      permissions: ["users.*", "posts.*", "cms.posts.*", "keys.manage"],
    },
  ],
  [
    "editor",
    { id: "editor", name: "Editor", permissions: ["posts.read", "posts.create", "posts.publish"] },
  ],
  ["viewer", { id: "viewer", name: "Viewer", permissions: ["posts.read"] }],
]);

interface SessionRow {
  userId: string;
  tenantId: string;
  csrf: string;
  createdAt: string;
}

function errorPayload(code: string, message: string, reason?: string) {
  return { error: { code, message, ...(reason ? { reason } : {}) } };
}

export async function createApp(): Promise<{ app: FastifyInstance; platform: Platform }> {
  const platform = createPlatform({
    preset: presets.saas(),
    database: { adapter: "memory" },
    auth: { mfa: true },
    authorization: { mode: "rbac-abac", defaultDeny: true },
    cms: { enabled: true },
  });
  await platform.initialize();

  const sessions = new Map<string, SessionRow>();
  const memberships = new Map<string, Set<string>>();
  const roleAssignments = new Map<string, Map<string, string[]>>();

  function grant(tenantId: string, userId: string, role: string): void {
    const set = memberships.get(userId) ?? new Set();
    set.add(tenantId);
    memberships.set(userId, set);
    let byUser = roleAssignments.get(tenantId);
    if (!byUser) {
      byUser = new Map();
      roleAssignments.set(tenantId, byUser);
    }
    const roles = byUser.get(userId) ?? [];
    if (!roles.includes(role)) roles.push(role);
    byUser.set(userId, roles);
  }

  const rolesOf = (tenantId: string, userId: string): string[] =>
    roleAssignments.get(tenantId)?.get(userId) ?? [];

  function readSession(req: FastifyRequest): (SessionRow & { sessionId: string }) | null {
    const cookie = req.headers.cookie ?? "";
    const match = /(?:^|;\s*)session=([^;]+)/.exec(cookie);
    if (!match?.[1]) return null;
    const row = sessions.get(match[1]);
    return row ? { ...row, sessionId: match[1] } : null;
  }

  function publicUser(userId: string) {
    const user = platform.auth.getUser(userId);
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      tenants: [...(memberships.get(userId) ?? [])],
    };
  }

  function audit(
    req: FastifyRequest,
    action: string,
    resource: string,
    outcome: "success" | "failure",
  ): void {
    const session = readSession(req);
    platform.audit.append({
      actorId: session?.userId ?? "anonymous",
      tenantId: req.tenantId ?? session?.tenantId ?? "unscoped",
      action,
      resource,
      outcome,
      correlationId: req.requestId ?? "unknown",
      metadata: { route: req.raw.url },
    });
  }

  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req) => {
    req.requestId = `req_${generateToken(8).replace(/[^a-zA-Z0-9]/g, "")}`;
  });

  const authLimiter = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!platform.rateLimiter.allow(req.ip)) {
      await reply
        .code(429)
        .header("Retry-After", "60")
        .send(errorPayload("RATE_LIMITED", "Too many requests"));
    }
  };

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const session = readSession(req);
    if (!session) {
      await reply.code(401).send(errorPayload("UNAUTHORIZED", "Authentication required"));
    }
  };

  const requireTenant = async (req: FastifyRequest, reply: FastifyReply) => {
    const session = readSession(req);
    if (!session) {
      await reply.code(401).send(errorPayload("UNAUTHORIZED", "Authentication required"));
      return;
    }
    const effective = first(req.headers["x-tenant-id"]) || session.tenantId;
    const member = [...(memberships.get(session.userId) ?? [])].includes(effective);
    if (!member) {
      audit(req, "tenancy.resolve", effective, "failure");
      await reply.code(403).send(errorPayload("TENANT_FORBIDDEN", "Tenant membership required"));
      return;
    }
    req.tenantId = effective;
  };

  const requireCsrf = async (req: FastifyRequest, reply: FastifyReply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const session = readSession(req);
    const token = first(req.headers["x-csrf-token"]);
    if (!session || token !== session.csrf) {
      await reply.code(403).send(errorPayload("CSRF", "CSRF token required"));
    }
  };

  const requirePermission =
    (resource: string, action: string) => async (req: FastifyRequest, reply: FastifyReply) => {
      const session = readSession(req);
      if (!session) {
        await reply.code(401).send(errorPayload("UNAUTHORIZED", "Authentication required"));
        return;
      }
      const tenantId = req.tenantId ?? session.tenantId;
      const allowed = can(
        {
          actor: { id: session.userId, roles: rolesOf(tenantId, session.userId), attributes: {} },
          action,
          resource,
        },
        ROLES,
      );
      if (!allowed) {
        audit(req, "authorization.check", `${resource}.${action}`, "failure");
        await reply
          .code(403)
          .send(
            errorPayload(
              "FORBIDDEN",
              `Missing permission: ${resource}.${action}`,
              "no-matching-permission",
            ),
          );
      }
    };

  function setCookies(reply: FastifyReply, sessionId: string, csrf: string): void {
    reply.header("Set-Cookie", [
      `session=${sessionId}; HttpOnly; SameSite=Lax; Path=/`,
      `csrf=${csrf}; SameSite=Lax; Path=/`,
    ]);
  }

  /* -------------------------------------------------------------- */
  /* Routes                           */
  /* -------------------------------------------------------------- */

  app.get("/health", async () => {
    const database = await platform.database.healthCheck();
    return { ok: database.ok, database, service: "example-fastify" };
  });

  app.get("/", async () => ({
    service: "allinone example (fastify)",
    endpoints: [
      "POST /api/auth/register",
      "POST /api/auth/login",
      "POST /api/auth/logout",
      "POST /api/tenants",
      "GET /api/cms/posts",
      "POST /api/cms/posts",
      "POST /api/cms/posts/:id/publish",
      "GET /api/admin/me",
      "GET /api/admin/manifest",
      "POST /api/keys",
      "GET /api/v1/status",
    ],
  }));

  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/auth")) return;
    if (route.onRequest === undefined) {
      route.onRequest = [authLimiter];
    } else if (Array.isArray(route.onRequest)) {
      route.onRequest.push(authLimiter);
    } else {
      route.onRequest = [route.onRequest, authLimiter];
    }
  });

  app.post("/api/auth/register", async (req, reply) => {
    const { email, password, name } = req.body as Record<string, unknown>;
    if (typeof email !== "string" || typeof password !== "string" || typeof name !== "string") {
      return reply
        .code(400)
        .send(errorPayload("VALIDATION", "email, password, and name are required"));
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
      grant(tenant.id, user.id, "admin");
      const sessionId = generateToken();
      const csrf = generateToken();
      sessions.set(sessionId, {
        userId: user.id,
        tenantId: tenant.id,
        csrf,
        createdAt: new Date().toISOString(),
      });
      setCookies(reply, sessionId, csrf);
      audit(req, "auth.register", "user", "success");
      await reply.code(201).send({ user: publicUser(user.id) });
      return;
    } catch (error) {
      audit(req, "auth.register", "user", "failure");
      return reply
        .code(400)
        .send(
          errorPayload(
            "AUTH_ERROR",
            error instanceof Error ? error.message : "Registration failed",
          ),
        );
    }
  });

  app.post("/api/auth/login", async (req, reply) => {
    const { email, password } = req.body as Record<string, unknown>;
    if (typeof email !== "string" || typeof password !== "string") {
      return reply.code(400).send(errorPayload("VALIDATION", "email and password are required"));
    }
    try {
      const { session } = await platform.auth.login({
        email,
        password,
        tenantId: "personal",
      });
      const sessionId = generateToken();
      const csrf = generateToken();
      sessions.set(sessionId, {
        userId: session.userId,
        tenantId: session.tenantId,
        csrf,
        createdAt: new Date().toISOString(),
      });
      setCookies(reply, sessionId, csrf);
      audit(req, "auth.login", "session", "success");
      await reply.send({ user: publicUser(session.userId) });
      return;
    } catch {
      audit(req, "auth.login", "session", "failure");
      return reply.code(401).send(errorPayload("UNAUTHORIZED", "Invalid credentials"));
    }
  });

  app.post("/api/auth/logout", { preHandler: [requireAuth] }, async (req, reply) => {
    const session = readSession(req);
    if (session) {
      sessions.delete(session.sessionId);
      await platform.auth.logout(session.sessionId).catch(() => undefined);
    }
    reply.header("Set-Cookie", [
      "session=; HttpOnly; Max-Age=0; Path=/",
      "csrf=; Max-Age=0; Path=/",
    ]);
    audit(req, "auth.logout", "session", "success");
    return reply.send({ ok: true });
  });

  app.post(
    "/api/tenants",
    { preHandler: [requireAuth, requireTenant, requireCsrf] },
    async (req, reply) => {
      const { name, slug } = req.body as Record<string, unknown>;
      if (typeof name !== "string" || typeof slug !== "string") {
        return reply.code(400).send(errorPayload("VALIDATION", "name and slug are required"));
      }
      const session = readSession(req);
      if (!session) throw new Error("unreachable");
      const tenant = platform.tenants.create({
        id: `t_${generateToken(8).replace(/[^a-zA-Z0-9]/g, "")}`,
        name,
        slug,
        strategy: "shared-schema",
        domains: [],
      });
      grant(tenant.id, session.userId, "admin");
      audit(req, "tenancy.create", tenant.id, "success");
      return reply.code(201).send({ tenant });
    },
  );

  app.get(
    "/api/cms/posts",
    { preHandler: [requireAuth, requireTenant, requirePermission("cms.posts", "read")] },
    async (req, reply) => {
      const tenantId = req.tenantId ?? "";
      const query = req.query as { status?: string };
      const publishedOnly = query["status"] === "published";
      const entries = platform.cms
        .findByCollection("posts", publishedOnly ? "published" : undefined)
        .filter((entry) => tenantOf(entry) === tenantId);
      return reply.send({ posts: entries });
    },
  );

  app.post(
    "/api/cms/posts",
    {
      preHandler: [
        requireAuth,
        requireTenant,
        requirePermission("cms.posts", "create"),
        requireCsrf,
      ],
    },
    async (req, reply) => {
      const session = readSession(req);
      if (!session) throw new Error("unreachable");
      const { title, body } = req.body as Record<string, unknown>;
      if (typeof title !== "string") {
        return reply.code(400).send(errorPayload("VALIDATION", "title is required"));
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
      return reply.code(201).send({ post: entry });
    },
  );

  app.post(
    "/api/cms/posts/:postId/publish",
    {
      preHandler: [
        requireAuth,
        requireTenant,
        requirePermission("cms.posts", "publish"),
        requireCsrf,
      ],
    },
    async (req, reply) => {
      const params = req.params as { postId?: string | string[] };
      const postId = params.postId === undefined ? "" : first(params.postId);
      if (!postId) return reply.code(400).send(errorPayload("VALIDATION", "postId is required"));
      try {
        const draft = platform.cms.findByCollection("posts").find((e) => e.id === postId);
        if (!draft || tenantOf(draft) !== (req.tenantId ?? "")) {
          await reply.code(404).send(errorPayload("NOT_FOUND", "Post not found"));
          return;
        }
        if (draft.status === "draft") platform.cms.submitForReview(postId);
        const published = platform.cms.publish(postId);
        audit(req, "cms.publish", postId, "success");
        await reply.send({ post: published });
        return;
      } catch (error) {
        audit(req, "cms.publish", postId, "failure");
        return reply
          .code(400)
          .send(
            errorPayload("CMS_ERROR", error instanceof Error ? error.message : "Publish failed"),
          );
      }
    },
  );

  app.get("/api/admin/me", { preHandler: [requireAuth, requireTenant] }, async (req, reply) => {
    const session = readSession(req);
    if (!session) throw new Error("unreachable");
    return reply.send({
      user: publicUser(session.userId),
      tenant: platform.tenants.get(req.tenantId ?? "") ?? null,
      roles: rolesOf(req.tenantId ?? "", session.userId),
    });
  });

  app.get(
    "/api/admin/manifest",
    { preHandler: [requireAuth, requireTenant] },
    async (req, reply) => {
      const session = readSession(req);
      if (!session) throw new Error("unreachable");
      const tenantId = req.tenantId ?? "";
      audit(req, "admin.manifest", "manifest", "success");
      return reply.send(
        buildAdminManifest({
          actor: { id: session.userId, roles: rolesOf(tenantId, session.userId) },
          tenantId,
          rolesById: ROLES,
        }),
      );
    },
  );

  app.post(
    "/api/keys",
    { preHandler: [requireAuth, requireTenant, requireCsrf] },
    async (req, reply) => {
      const session = readSession(req);
      if (!session) throw new Error("unreachable");
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
      return reply.code(201).send({ id: record.id, scopes: record.scopes, secret });
    },
  );

  app.get("/api/v1/status", async (req, reply) => {
    const keyHeader = first(req.headers["x-api-key"]);
    if (!keyHeader) {
      return reply.code(401).send(errorPayload("UNAUTHORIZED", "API key required"));
    }
    const record = platform.apiKeys.verify(keyHeader, "status.read");
    if (!record) {
      return reply.code(403).send(errorPayload("FORBIDDEN", "Invalid or out-of-scope API key"));
    }
    return reply.send({ ok: true, tenantId: record.tenantId });
  });

  app.get("/api/version", async () => ({ version: "0.1.0", preset: "saas" }));

  app.setErrorHandler((error: FastifyError, _req, reply) => {
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    reply
      .code(status)
      .send(
        errorPayload(
          status >= 500 ? "INTERNAL" : "ERROR",
          status >= 500 ? "Internal server error" : "Request failed",
        ),
      );
  });

  return { app, platform };
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function tenantOf(entry: { data: Record<string, unknown> }): string {
  const value = entry.data["tenantId"];
  return typeof value === "string" ? value : "";
}

declare module "fastify" {
  interface FastifyRequest {
    requestId?: string;
    tenantId?: string;
  }
}

export async function start(port = Number(process.env["PORT"] ?? 3001)): Promise<void> {
  const { app, platform } = await createApp();
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`example-fastify listening on http://localhost:${String(port)}`);
  const shutdown = (): void => {
    void app.close().then(() => platform.shutdown().then(() => process.exit(0)));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
