import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { FastifyInstance } from "fastify";

async function withApp(fn: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const { app, platform } = await createApp();
  try {
    await app.ready();
    await fn(app);
  } finally {
    await platform.shutdown();
  }
}

interface InjectedResponse {
  cookies: { name: string; value: string }[];
}

function cookiesOf(res: InjectedResponse): {
  cookie: string;
  csrf: string | null;
} {
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const csrf = res.cookies.find((c) => c.name === "csrf")?.value ?? null;
  return { cookie, csrf };
}

async function register(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: "correct horse battery", name: "Ada" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json<{ user: { id: string; tenants: string[] } }>();
  return { ...cookiesOf(res), user: body.user };
}

function csrfHeaders(csrf: string | null): Record<string, string> {
  return csrf ? { "x-csrf-token": csrf } : {};
}

describe("example-fastify", () => {
  it("health check opens without auth", async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const health = res.json<{ ok: boolean }>();
      expect(health.ok).toBe(true);
    });
  });

  it("protects CMS endpoints until authenticated", async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: "GET", url: "/api/cms/posts" });
      expect(res.statusCode).toBe(401);
    });
  });

  it("full flow: register → create post → publish → list", async () => {
    await withApp(async (app) => {
      const { cookie, csrf } = await register(app, "fb@example.com");
      const me = (
        await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } })
      ).json<{ tenant: { id: string } | null }>();
      expect(me.tenant?.id).toBeTruthy();
      const headers = { cookie, "x-tenant-id": me.tenant!.id, ...csrfHeaders(csrf) };

      const created = await app.inject({
        method: "POST",
        url: "/api/cms/posts",
        headers,
        payload: { title: "Hello" },
      });
      expect(created.statusCode).toBe(201);
      const { post } = created.json<{ post: { id: string; status: string } }>();
      expect(post.status).toBe("draft");

      const published = await app.inject({
        method: "POST",
        url: `/api/cms/posts/${post.id}/publish`,
        headers,
      });
      expect(published.statusCode).toBe(200);

      const list = await app.inject({
        method: "GET",
        url: "/api/cms/posts",
        headers: { cookie, "x-tenant-id": me.tenant!.id },
      });
      expect(list.statusCode).toBe(200);
      const posts = list.json<{ posts: { status: string }[] }>();
      expect(posts.posts.some((p) => p.status === "published")).toBe(true);
    });
  });

  it("manifest adapts to the actor's permissions", async () => {
    await withApp(async (app) => {
      const { cookie } = await register(app, "boss@example.com");
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/manifest",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const manifest = res.json<{ collections: { slug: string }[]; modules: { name: string }[] }>();
      expect(manifest.collections.map((c) => c.slug)).toEqual(["users", "posts"]);
      expect(manifest.modules.map((m) => m.name)).toContain("dashboard");

      const anon = await app.inject({ method: "GET", url: "/api/admin/manifest" });
      expect(anon.statusCode).toBe(401);
    });
  });

  it("tenant isolation blocks cross-tenant reads", async () => {
    await withApp(async (app) => {
      const one = await register(app, "one@example.com");
      const two = await register(app, "two@example.com");
      const twoMe = (
        await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: two.cookie } })
      ).json<{ tenant: { id: string } }>();
      const hijack = await app.inject({
        method: "GET",
        url: "/api/cms/posts",
        headers: { cookie: one.cookie, "x-tenant-id": twoMe.tenant.id },
      });
      expect(hijack.statusCode).toBe(403);
    });
  });
});
