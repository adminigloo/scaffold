import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * A generated project's UNIT tests run on a laptop exactly as in CI: no
 * .env.local, so no keys and no network. Loading the developer's .env.local
 * for them once handed the isolation proof real Stripe test keys (Igloo Back
 * Office), and its Connect route called Stripe for real. Only the integration
 * project, which needs DATABASE_URL, loads it.
 */
describe("the unit tests never read .env.local", () => {
  it("the unit project reads only .env.local's plain settings; the integration project reads all of it", async () => {
    const config = await readFile(join(TEMPLATE_DIR, "vitest.config.ts"), "utf8");
    const unit = config.slice(config.indexOf('name: "unit"') - 200, config.indexOf('name: "unit"'));
    const integration = config.slice(config.indexOf('name: "integration"') - 200, config.indexOf('name: "integration"'));
    expect(config).not.toMatch(/const shared = \{[^}]*setupFiles/s);
    expect(unit).toContain("...loadsLocalSettings");
    expect(unit).not.toContain("...loadsLocalEnv");
    expect(integration).toContain("...loadsLocalEnv");
  });
});

describe("the unit setup keeps keys out", () => {
  it("copies plain settings and drops every key, token, secret and database address", async () => {
    const { mkdtemp, writeFile, mkdir, cp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { pathToFileURL } = await import("node:url");
    const dir = await mkdtemp(join(tmpdir(), "unit-setup-"));
    await mkdir(join(dir, "src", "test"), { recursive: true });
    await cp(join(TEMPLATE_DIR, "src", "test", "setup-unit.ts"), join(dir, "src", "test", "setup-unit.ts"));
    await writeFile(
      join(dir, ".env.local"),
      [
        "NEXT_PUBLIC_APP_URL=http://localhost:3440",
        "DATABASE_URL=postgres://x",
        "STRIPE_SECRET_KEY=sk_test_x",
        "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_x",
        "STRIPE_CONNECT_WEBHOOK_SECRET=whsec_x",
        "CLERK_SECRET_KEY=sk_test_y",
        "ANTHROPIC_API_KEY=sk-ant-x",
        "BLOB_READ_WRITE_TOKEN=t",
        "BILLING_TRIAL_DAYS=7",
      ].join("\n"),
    );
    const names = ["NEXT_PUBLIC_APP_URL", "DATABASE_URL", "STRIPE_SECRET_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_CONNECT_WEBHOOK_SECRET", "CLERK_SECRET_KEY", "ANTHROPIC_API_KEY", "BLOB_READ_WRITE_TOKEN", "BILLING_TRIAL_DAYS"];
    const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names) delete process.env[n];
    try {
      await import(pathToFileURL(join(dir, "src", "test", "setup-unit.ts")).href);
      expect(process.env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3440");
      expect(process.env.BILLING_TRIAL_DAYS).toBe("7");
      for (const n of names.slice(1, 8)) expect(process.env[n], n).toBeUndefined();
    } finally {
      for (const n of names) {
        if (before[n] === undefined) delete process.env[n];
        else process.env[n] = before[n];
      }
    }
  });
});
