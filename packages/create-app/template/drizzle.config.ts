import { defineConfig } from "drizzle-kit";

// The UNPOOLED url, deliberately. drizzle-kit through a Neon pooler either
// hangs or misreports which migrations have been applied, and the second
// failure mode is the one you discover during a production deploy.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? "" },
});
