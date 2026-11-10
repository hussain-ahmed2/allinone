import { StrictMode, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createAppRouter } from "./router";

/**
 * Client entry — hydrates the SSR output. Platform calls never run here:
 * loaders and server functions execute on the server.
 */
function App() {
  const [router] = useState(() => createAppRouter());
  return (
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

hydrateRoot(container, <App />);
