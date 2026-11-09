import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves project sites under /<repo>/ — the workflow
// sets GITHUB_PAGES=true so asset URLs get the repo prefix.
export default defineConfig({
  plugins: [react()],
  base: process.env["GITHUB_PAGES"] === "true" ? "/allinone/" : "/",
  server: {
    port: 5173,
  },
});
