import { NextResponse, type NextRequest } from "next/server";
import { getPlatform, readSession, canPerform } from "@/lib/platform";

/**
 * CMS posts endpoint.
 *  - GET  → list posts (requires cms.posts.read)
 *  - POST → create post (requires cms.posts.create + CSRF token)
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const platform = await getPlatform();
  const session = readSession(req.cookies.get("session")?.value);
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      { status: 401 },
    );
  }
  const tenantId = req.headers.get("x-tenant-id") ?? session.tenantId;
  if (!session.memberships.includes(tenantId)) {
    return NextResponse.json(
      { error: { code: "TENANT_FORBIDDEN", message: "Tenant membership required" } },
      { status: 403 },
    );
  }
  if (!canPerform({ id: session.userId, roles: session.roles }, "read", "cms.posts")) {
    return NextResponse.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Missing permission: cms.posts.read",
          reason: "no-matching-permission",
        },
      },
      { status: 403 },
    );
  }
  const posts = platform.cms.findByCollection("posts").filter((entry) => {
    const value = entry.data["tenantId"];
    return typeof value === "string" && value === tenantId;
  });
  return NextResponse.json({ posts });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const platform = await getPlatform();
  const session = readSession(req.cookies.get("session")?.value);
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      { status: 401 },
    );
  }
  const tenantId = req.headers.get("x-tenant-id") ?? session.tenantId;
  if (!session.memberships.includes(tenantId)) {
    return NextResponse.json(
      { error: { code: "TENANT_FORBIDDEN", message: "Tenant membership required" } },
      { status: 403 },
    );
  }
  if (!canPerform({ id: session.userId, roles: session.roles }, "create", "cms.posts")) {
    return NextResponse.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Missing permission: cms.posts.create",
          reason: "no-matching-permission",
        },
      },
      { status: 403 },
    );
  }
  const csrf = req.headers.get("x-csrf-token") ?? "";
  if (csrf !== session.csrf) {
    return NextResponse.json(
      { error: { code: "CSRF", message: "CSRF token required" } },
      { status: 403 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  if (!body.title) {
    return NextResponse.json(
      { error: { code: "VALIDATION", message: "title is required" } },
      { status: 400 },
    );
  }
  const entry = platform.cms.create({
    collection: "posts",
    data: { title: body.title, tenantId },
    slug: body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    createdBy: session.userId,
  });
  return NextResponse.json({ post: entry }, { status: 201 });
}
