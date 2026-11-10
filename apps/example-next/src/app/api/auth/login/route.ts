import { NextResponse, type NextRequest } from "next/server";
import { getPlatform, issueSession, createCsrfToken } from "@/lib/platform";

/**
 * Login route handler — sets HttpOnly session cookie + readable CSRF cookie.
 * The CSRF token is echoed in the JSON body so the browser can send it
 * back in `x-csrf-token` on state-changing requests.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const platform = await getPlatform();
  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  if (!body.email || !body.password) {
    return NextResponse.json(
      { error: { code: "VALIDATION", message: "email and password are required" } },
      { status: 400 },
    );
  }
  try {
    const { session } = await platform.auth.login({
      email: body.email,
      password: body.password,
      tenantId: "personal",
    });
    const csrf = createCsrfToken();
    const sessionId = issueSession({
      userId: session.userId,
      tenantId: session.tenantId,
      csrf,
      memberships: [session.tenantId],
      roles: ["admin"],
    });
    const response = NextResponse.json({ ok: true, csrf });
    response.cookies.set("session", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env["NODE_ENV"] === "production",
    });
    response.cookies.set("csrf", csrf, {
      sameSite: "lax",
      path: "/",
      secure: process.env["NODE_ENV"] === "production",
    });
    return response;
  } catch {
    // Generic error — no account enumeration.
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid credentials" } },
      { status: 401 },
    );
  }
}
