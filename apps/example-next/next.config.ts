import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The platform is server-only — never bundle it into client components.
  serverExternalPackages: ["allinone", "@allinone/auth", "@allinone/infra"],
};

export default nextConfig;
