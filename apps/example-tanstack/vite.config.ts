import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    tanstackStart({
      router: { quoteStyle: "double" },
    }),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: false,
    }),
    viteReact(),
  ],
  server: { port: 3003 },
  ssr: {
    // The platform is server-only (Node built-ins, pg, mongodb, ...).
    // It must never be bundled into the client graph.
    external: ["allinone", "@allinone/auth", "@allinone/infra", "@allinone/database"],
  },
});
