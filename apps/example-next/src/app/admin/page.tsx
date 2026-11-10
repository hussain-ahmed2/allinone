import { cookies } from "next/headers";
import { adminManifest, readSession } from "@/lib/platform";

/**
 * Server component — renders the admin shell from the permission-aware
 * manifest. The client never computes permissions; it renders what the
 * server decided is visible.
 */
export default async function AdminPage() {
  const cookieStore = await cookies();
  const session = readSession(cookieStore.get("session")?.value);
  if (!session) {
    return (
      <main style={{ padding: 32, fontFamily: "system-ui" }}>
        <h1>Admin</h1>
        <p>Sign in to view this page.</p>
      </main>
    );
  }
  const manifest = adminManifest({ id: session.userId, roles: session.roles }, session.tenantId);
  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Admin</h1>
      <p>
        Signed in as <b>{session.userId}</b> · tenant <b>{session.tenantId}</b> · roles{" "}
        {session.roles.join(", ")}
      </p>
      {manifest.modules.map((module) => (
        <section key={module.name} style={{ marginTop: 24 }}>
          <h2>{module.label}</h2>
          <ul>
            {module.sections.map((section) => (
              <li key={section.slug}>
                {section.label}
                {section.view ? ` — view: ${section.view}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <h2 style={{ marginTop: 24 }}>Collections</h2>
      <ul>
        {manifest.collections.map((collection) => (
          <li key={collection.slug}>
            {collection.name} ({collection.fields.length} fields)
          </li>
        ))}
      </ul>
    </main>
  );
}
