import { cookies } from "next/headers";

/**
 * Home page — server component reading the session cookie.
 * Shows the framework-agnostic pattern: cookies → session → tenant →
 * permission-aware rendering.
 */
export default async function HomePage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("session")?.value;
  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>allinone × Next.js</h1>
      <p>
        Session cookie: <code>{sessionId ? "present" : "absent"}</code>
      </p>
      <ul>
        <li>
          <a href="/api/health">GET /api/health</a> — datastore health
        </li>
        <li>
          <a href="/api/cms/posts">GET /api/cms/posts</a> — RBAC-protected
        </li>
        <li>
          <a href="/admin">/admin</a> — permission-shaped server component
        </li>
      </ul>
    </main>
  );
}
