import type { NextConfig } from "next";

// Importing the env module here is deliberate: it runs Zod validation during
// `next build`, so a missing or malformed variable fails the build rather than
// the first request that happens to touch it.
import "./src/env";

const config: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@neondatabase/serverless"],
};

export default config;
