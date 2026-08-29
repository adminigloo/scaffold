import type { NextConfig } from "next";

// Importing the env module here is deliberate: it runs Zod validation during
// `next build`, so a missing or malformed variable fails the build rather than
// the first request that happens to touch it.
import "./src/env";

const config: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@neondatabase/serverless"],
  turbopack: {
    // Pin the workspace root to THIS project. Next walks up looking for a
    // lockfile, so a project generated anywhere below another one — a scratch
    // directory, a monorepo you happen to be sitting in — infers the wrong root
    // and warns on every build.
    root: import.meta.dirname,
  },
};

export default config;
