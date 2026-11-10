import { createFileRoute } from "@tanstack/react-router";
import { loadAdminManifest } from "@/lib/server";

/**
 * Admin route — the loader fetches the permission-shaped manifest through a
 * server function; the component only renders what the server decided.
 */
export const Route = createFileRoute("/admin")({
  loader: () => loadAdminManifest(),
  component: Admin,
});

function Admin() {
  const data = Route.useLoaderData();
  if (!data.signedIn) {
    return (
      <main style={{ padding: 32, fontFamily: "system-ui" }}>
        <h1>Admin</h1>
        <p>Sign in to view this page.</p>
      </main>
    );
  }
  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Admin</h1>
      <p>
        User <b>{data.userId}</b>
      </p>
      {data.manifest.modules.map((module) => (
        <section key={module.name} style={{ marginTop: 20 }}>
          <h2>{module.label}</h2>
          <ul>
            {module.sections.map((section) => (
              <li key={section.slug}>{section.label}</li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
