import { defineConfig } from "drizzle-kit";

// drizzle-kit is a standalone binary and does NOT read .env.local — Next loads
// that file, drizzle-kit does not. Without this, `pnpm db:migrate` fails with
// "Please provide required params for Postgres driver: url: ''" while the app
// itself connects perfectly, which reads as a broken config rather than an
// unloaded file. Node-native, so no dotenv dependency.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local yet. drizzle-kit will report the missing url itself.
}

// The UNPOOLED url, deliberately. drizzle-kit through a Neon pooler either
// hangs or misreports which migrations have been applied, and the second
// failure mode is the one you discover during a production deploy.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? "" },
});
