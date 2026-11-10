import { createFileRoute } from "@tanstack/react-router";
import { listPosts } from "@/lib/server";

/**
 * Home route — the loader calls a server function; the client bundle never
 * contains the platform.
 */
export const Route = createFileRoute("/")({
  loader: () => listPosts(),
  component: Home,
});

function Home() {
  const posts = Route.useLoaderData();
  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>allinone × TanStack Start</h1>
      <ul>
        {posts.map((p) => (
          <li key={p.id}>
            {p.title} — {p.status}
          </li>
        ))}
      </ul>
      <p style={{ marginTop: 24 }}>
        Data loaded through <code>createServerFn</code> — the platform stays on the server.
      </p>
    </main>
  );
}
