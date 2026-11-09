import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AddressInfo } from "node:net";

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const { app, platform } = await createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await platform.shutdown();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header
    .split(",")
    .map((part) => {
      const [name, value] = part.split("=");
      return `${name ?? ""}=${value ?? ""}`;
    })
    .join("; ");
}

function csrfOf(response: Response): string | null {
  const header = response.headers.get("set-cookie") ?? "";
  const part = header.split(",").find((p) => p.trim().startsWith("csrf="));
  return part ? (part.split("=")[1]?.split(";")[0] ?? null) : null;
}

async function register(base: string, email: string) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery", name: "Ada" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    user: { id: string; tenants: string[] };
  };
  return { cookie: cookieOf(res), csrf: csrfOf(res), user: body.user };
}

describe("example-express", () => {
  it("health check opens without auth", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  it("protects CMS endpoints until authenticated", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/cms/posts`);
      expect(res.status).toBe(401);
    });
  });

  it("full flow: register → create post → publish → list", async () => {
    await withServer(async (base) => {
      const { cookie, csrf } = await register(base, "ada@example.com");
      const meRes = await fetch(`${base}/api/admin/me`, { headers: { cookie } });
      const me = (await meRes.json()) as { tenant: { id: string } | null };
      expect(me.tenant?.id).toBeTruthy();
      const tenantHeader = {
        cookie,
        "x-tenant-id": me.tenant!.id,
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      };

      const created = await fetch(`${base}/api/cms/posts`, {
        method: "POST",
        headers: { ...tenantHeader, "content-type": "application/json" },
        body: JSON.stringify({ title: "Hello" }),
      });
      expect(created.status).toBe(201);
      const { post } = (await created.json()) as { post: { id: string; status: string } };
      expect(post.status).toBe("draft");

      const published = await fetch(`${base}/api/cms/posts/${post.id}/publish`, {
        method: "POST",
        headers: tenantHeader,
      });
      expect(published.status).toBe(200);

      const list = await fetch(`${base}/api/cms/posts`, { headers: tenantHeader });
      expect(list.status).toBe(200);
      const posts = (await list.json()) as { posts: { status: string }[] };
      expect(posts.posts.some((p) => p.status === "published")).toBe(true);
    });
  });

  it("RBAC: viewer cannot create posts", async () => {
    await withServer(async (base) => {
      const admin = await register(base, "admin@example.com");
      const me = (await (
        await fetch(`${base}/api/admin/me`, { headers: { cookie: admin.cookie } })
      ).json()) as { tenant: { id: string } };
      const viewer = await register(base, "viewer@example.com");
      // Grant viewer membership + viewer role on the admin tenant.
      const added = await fetch(`${base}/api/tenants/${me.tenant.id}/members`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: admin.cookie,
          "x-tenant-id": me.tenant.id,
          ...(admin.csrf ? { "x-csrf-token": admin.csrf } : {}),
        },
        body: JSON.stringify({ userId: viewer.user.id, role: "viewer" }),
      });
      expect(added.status).toBe(200);

      const denied = await fetch(`${base}/api/cms/posts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: viewer.cookie,
          "x-tenant-id": me.tenant.id,
          ...(viewer.csrf ? { "x-csrf-token": viewer.csrf } : {}),
        },
        body: JSON.stringify({ title: "Nope" }),
      });
      expect(denied.status).toBe(403);
    });
  });

  it("API keys are scoped and tenant-bound", async () => {
    await withServer(async (base) => {
      const { cookie, csrf } = await register(base, "key@example.com");
      const me = (await (await fetch(`${base}/api/admin/me`, { headers: { cookie } })).json()) as {
        tenant: { id: string };
      };
      const created = await fetch(`${base}/api/keys`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-tenant-id": me.tenant.id,
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        body: JSON.stringify({ name: "client", scopes: ["status.read"] }),
      });
      expect(created.status).toBe(201);
      const { secret } = (await created.json()) as { secret: string };
      const ok = await fetch(`${base}/api/v1/status`, { headers: { "x-api-key": secret } });
      expect(ok.status).toBe(200);
      const scoped = await fetch(`${base}/api/v1/status`, {
        headers: { "x-api-key": secret + "x" },
      });
      expect(scoped.status).toBe(403);
    });
  });

  it("admin manifest adapts to the actor's permissions", async () => {
    await withServer(async (base) => {
      const admin = await register(base, "boss@example.com");
      const full = await fetch(`${base}/api/admin/manifest`, { headers: { cookie: admin.cookie } });
      expect(full.status).toBe(200);
      const manifestFull = (await full.json()) as {
        modules: { name: string; sections: { slug: string }[] }[];
        collections: { slug: string }[];
        tenantId: string;
      };
      expect(manifestFull.collections.map((c) => c.slug)).toEqual(["users", "posts"]);
      expect(manifestFull.tenantId).toBeTruthy();

      const anon = await fetch(`${base}/api/admin/manifest`);
      expect(anon.status).toBe(401);
    });
  });

  it("cross-tenant access is forbidden", async () => {
    await withServer(async (base) => {
      const one = await register(base, "one@example.com");
      const two = await register(base, "two@example.com");
      const twoMe = (await (
        await fetch(`${base}/api/admin/me`, { headers: { cookie: two.cookie } })
      ).json()) as { tenant: { id: string } };
      const hijack = await fetch(`${base}/api/cms/posts`, {
        headers: { cookie: one.cookie, "x-tenant-id": twoMe.tenant.id },
      });
      expect(hijack.status).toBe(403);
    });
  });
});
