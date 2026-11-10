/**
 * Server functions — the only path from the client to the platform.
 *
 * The TanStack Start plugin strips each handler body (and its dynamic
 * import) from the client bundle, so the Node-only platform never ships
 * to the browser. Loaders call these; the client receives plain data.
 */
import { createServerFn } from "@tanstack/react-start";

/** List posts (server-side; returns plain JSON to the client). */
export const listPosts = createServerFn({ method: "GET" }).handler(async () => {
  const { getPlatform } = await import("./platform");
  const p = await getPlatform();
  return p.cms.findByCollection("posts").map((entry) => {
    const title = entry.data["title"];
    return {
      id: entry.id,
      title: typeof title === "string" ? title : "",
      status: entry.status,
    };
  });
});

/** Permission-shaped admin manifest for the current session. */
export const loadAdminManifest = createServerFn({ method: "GET" }).handler(async () => {
  const { adminManifest, readSession } = await import("./platform");
  const session = readSession(undefined);
  if (!session) return { signedIn: false as const };
  return {
    signedIn: true as const,
    userId: session.userId,
    manifest: adminManifest({ id: session.userId, roles: session.roles }, session.tenantId),
  };
});
