import { createRootRoute, Outlet } from "@tanstack/react-router";

/**
 * Root route — the app shell. TanStack Start renders this around every
 * route (server + client).
 */
export const Route = createRootRoute({
  component: Root,
});

function Root() {
  return (
    <html lang="en">
      <head>
        <title>allinone × TanStack Start</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="/src/styles.css" />
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  );
}
