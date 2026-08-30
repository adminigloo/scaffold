import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The same "@/..." the app uses, so a test imports a module by the path the
 * module's own neighbours import it by. Without it, tests would need relative
 * paths, and `vi.mock("@/server/permissions")` in a router test would resolve
 * to a specifier nothing imports and silently mock nothing.
 */
const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

const shared = {
  environment: "node" as const,
  // Off, matching the packages: `describe`/`it`/`expect` are imported. A global
  // `expect` reads fine right up until a file is moved somewhere without the
  // ambient types, and then the failure is a wall of TS2304 rather than "you
  // forgot an import".
  globals: false,
  // Loads .env.local, which Next reads and Vitest does not. It runs before any
  // test module is imported, so DATABASE_URL is already in place by the time
  // src/test/db.ts decides whether the integration suites can run.
  setupFiles: ["./src/test/setup.ts"],
};

/**
 * Two projects, one rule: `pnpm test` must pass on a laptop with nothing
 * configured.
 *
 *   unit         no database, no network. Always runs.
 *   integration  needs DATABASE_URL. Reports as SKIPPED without one.
 *
 * A suite that fails because a machine has no database is a suite people
 * delete — or, worse, learn to ignore, which costs the same and takes longer to
 * notice. So the skip is not a nice-to-have: wrap every database test in
 * `describeIntegration` from src/test/db.ts and it reports as skipped instead
 * of erroring on a connection nobody asked it to make.
 *
 * The split is here rather than in one merged glob so that
 * `vitest --project=integration` is a thing you can type, and so the
 * integration project can run its files one at a time — they share a real
 * database, and two suites seeding the same row concurrently fail in a way
 * that looks exactly like a bug in the code under test.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          ...shared,
          name: "unit",
          // `.ts` only. A component test needs `environment: "jsdom"`, which is
          // a third project and a dependency this template does not carry.
          include: ["src/**/*.test.ts"],
          // Vitest replaces the default excludes rather than merging, so
          // node_modules is named explicitly. The second entry is the split:
          // without it, `*.integration.test.ts` matches the glob above too and
          // would run in both projects.
          exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          ...shared,
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
