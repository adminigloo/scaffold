import { describe, expect, it } from "vitest";
import { describeEnv, formatEnvReport } from "../report.js";
import { coreClient, coreServer } from "../fragments.js";
import { pooledPostgresUrl, prefixedSecret } from "../schemas.js";
import type { EnvSource } from "../app-env.js";

const RELAXABLE = ["DATABASE_URL", "STRIPE_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"];

function schemas(source: EnvSource) {
  return {
    server: {
      ...coreServer(),
      DATABASE_URL: pooledPostgresUrl(),
      STRIPE_SECRET_KEY: prefixedSecret("sk_"),
    },
    client: {
      ...coreClient(source),
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: prefixedSecret("pk_"),
    },
  };
}

function report(
  source: EnvSource,
  runtimeEnv: Record<string, string | undefined>,
  optionalUntilDeployed: readonly string[] = RELAXABLE,
) {
  return describeEnv({ ...schemas(source), source, runtimeEnv, optionalUntilDeployed });
}

function varNamed(
  groups: ReturnType<typeof report>["groups"],
  name: string,
) {
  const found = groups.flatMap((group) => group.vars).find((v) => v.name === name);
  if (found === undefined) throw new Error(`no report row for ${name}`);
  return found;
}

describe("describeEnv", () => {
  it("groups by server and client when no features are given", () => {
    const result = report({}, { NEXT_PUBLIC_APP_URL: "http://localhost:3000" });

    expect(result.groups.map((g) => g.name)).toEqual(["server", "client"]);
    expect(result.groups[0]?.vars.map((v) => v.name)).toEqual([
      "NODE_ENV",
      "LOG_LEVEL",
      "DATABASE_URL",
      "STRIPE_SECRET_KEY",
    ]);
    expect(result.appEnv).toBe("local");
  });

  it("reports a defaulted variable as not required", () => {
    const result = report({}, { NEXT_PUBLIC_APP_URL: "http://localhost:3000" });

    expect(varNamed(result.groups, "LOG_LEVEL")).toEqual({
      name: "LOG_LEVEL",
      present: false,
      required: false,
      defaulted: true,
    });
  });

  it("treats an empty string as absent, matching the parser", () => {
    const result = report({}, {
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      DATABASE_URL: "",
    });

    expect(varNamed(result.groups, "DATABASE_URL").present).toBe(false);
    expect(varNamed(result.groups, "DATABASE_URL").malformed).toBeUndefined();
  });

  it("locally, a relaxable variable is unrequired but still owed before deploying", () => {
    const result = report({}, { NEXT_PUBLIC_APP_URL: "http://localhost:3000" });

    expect(varNamed(result.groups, "DATABASE_URL")).toEqual({
      name: "DATABASE_URL",
      present: false,
      required: false,
    });
    expect(result.missingLocally).toEqual([]);
    expect(result.missingWhenDeployed).toEqual([
      "DATABASE_URL",
      "STRIPE_SECRET_KEY",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ]);
    expect(result.ok).toBe(true);
  });

  it("locally, a variable that is NOT relaxable still blocks boot when absent", () => {
    const result = report({}, { NEXT_PUBLIC_APP_URL: "http://localhost:3000" }, [
      "STRIPE_SECRET_KEY",
    ]);

    expect(varNamed(result.groups, "DATABASE_URL").required).toBe(true);
    expect(result.missingLocally).toEqual([
      "DATABASE_URL",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ]);
    expect(result.ok).toBe(false);
  });

  it("on a deployment the relaxation is ignored entirely", () => {
    const result = report(
      { VERCEL_ENV: "preview" },
      { NEXT_PUBLIC_APP_URL: "https://staging.example.com" },
    );

    expect(varNamed(result.groups, "DATABASE_URL").required).toBe(true);
    expect(result.appEnv).toBe("staging");
    expect(result.ok).toBe(false);
  });

  it("on production the relaxation is ignored entirely", () => {
    const result = report(
      { VERCEL_ENV: "production" },
      { NEXT_PUBLIC_APP_URL: "https://example.com" },
    );

    expect(varNamed(result.groups, "STRIPE_SECRET_KEY").required).toBe(true);
    expect(result.appEnv).toBe("production");
    expect(result.ok).toBe(false);
  });

  it("flags a present-but-malformed value, and is never ok because of it", () => {
    const result = report({}, {
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://u:p@direct.example.dev/main",
    });

    expect(varNamed(result.groups, "DATABASE_URL")).toEqual({
      name: "DATABASE_URL",
      present: true,
      required: false,
      malformed: true,
    });
    // Relaxable, absent from both missing lists, and still not ok: a pasted-wrong
    // value is a different problem from an unset one and must not read as fine.
    expect(result.missingLocally).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("does not throw on a completely empty environment", () => {
    expect(() => report({}, {})).not.toThrow();
    expect(report({}, {}).ok).toBe(false);
  });
});

describe("describeEnv — value confidentiality", () => {
  // A setup page rendering this report is the whole reason it exists, so a
  // leaked value here is a secret on a web page. Every field is checked, not
  // just the ones that look risky.
  const SECRETS = {
    DATABASE_URL: "postgres://neon:hunter2spool@ep-quiet-pooler.example.dev/main",
    STRIPE_SECRET_KEY: "sk_test_zzzsupersecretstripe",
    NEXT_PUBLIC_APP_URL: "https://tenant-alpha.example.com",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "not-a-clerk-key-and-malformed",
    LOG_LEVEL: "debug",
  };

  it("never returns the value of any input variable", () => {
    const result = report({}, SECRETS);
    const serialised = JSON.stringify(result);

    for (const value of Object.values(SECRETS)) {
      expect(serialised).not.toContain(value);
    }
    // Fragments too: a truncated or quoted value is still a leak.
    for (const fragment of ["hunter2spool", "zzzsupersecretstripe", "tenant-alpha"]) {
      expect(serialised).not.toContain(fragment);
    }
  });

  it("does not leak values through the formatted summary either", () => {
    const text = formatEnvReport(report({}, SECRETS));

    for (const value of Object.values(SECRETS)) {
      expect(text).not.toContain(value);
    }
    for (const fragment of ["hunter2spool", "zzzsupersecretstripe", "tenant-alpha"]) {
      expect(text).not.toContain(fragment);
    }
  });

  it("carries no field beyond the four schema facts", () => {
    const result = report({}, SECRETS);
    const allowed = new Set(["name", "present", "required", "malformed", "defaulted"]);

    for (const group of result.groups) {
      for (const entry of group.vars) {
        for (const key of Object.keys(entry)) expect(allowed).toContain(key);
      }
    }
  });
});

describe("describeEnv — features", () => {
  const FEATURES = [
    {
      name: "database",
      vars: ["DATABASE_URL"],
      disables: "persistence; the app boots but nothing is stored",
    },
    { name: "billing", vars: ["STRIPE_SECRET_KEY"], disables: "checkout and subscriptions" },
    { name: "search", vars: ["TYPESENSE_API_KEY"], disables: "full-text search" },
  ];

  function featured(runtimeEnv: Record<string, string | undefined>) {
    return describeEnv({
      ...schemas({}),
      runtimeEnv,
      source: {},
      optionalUntilDeployed: RELAXABLE,
      features: FEATURES,
    });
  }

  it("names groups after features and leaves unclaimed variables in server/client", () => {
    const result = featured({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" });

    expect(result.groups.map((g) => g.name)).toEqual([
      "database",
      "billing",
      "server",
      "client",
    ]);
    expect(result.groups[0]?.disables).toBe(
      "persistence; the app boots but nothing is stored",
    );
    expect(result.groups[2]?.vars.map((v) => v.name)).toEqual(["NODE_ENV", "LOG_LEVEL"]);
  });

  it("drops a feature whose variables this app never declared", () => {
    // TYPESENSE_API_KEY belongs to a package that is not installed. Rendering a
    // row for it would tell the reader to configure something never read.
    const result = featured({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" });

    expect(result.groups.map((g) => g.name)).not.toContain("search");
  });
});

describe("formatEnvReport", () => {
  const LOCAL_URL = "http://localhost:3000";

  it("does not report a defaulted variable as a disabled feature", () => {
    // LOG_LEVEL is unset in almost every project and defaults to "info".
    // Listing it under "these features are off" would put a false alarm in
    // front of every reader on every boot.
    const text = formatEnvReport(report({}, { NEXT_PUBLIC_APP_URL: LOCAL_URL }));

    expect(text).not.toContain("LOG_LEVEL");
    expect(text).not.toContain("NODE_ENV");
    expect(text).toContain("DATABASE_URL");
  });

  it("names what is unset and what that switches off", () => {
    const text = formatEnvReport(
      describeEnv({
        ...schemas({}),
        source: {},
        runtimeEnv: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
        optionalUntilDeployed: RELAXABLE,
        features: [
          {
            name: "billing",
            vars: ["STRIPE_SECRET_KEY"],
            disables: "checkout and subscriptions",
          },
        ],
      }),
    );

    expect(text).toContain("Environment: local");
    expect(text).toContain("STRIPE_SECRET_KEY (billing) - checkout and subscriptions");
    expect(text).toContain("Required before this deploys to preview or production:");
    expect(text).toContain("DATABASE_URL");
  });

  it("separates malformed from unset, because they need different fixes", () => {
    const text = formatEnvReport(
      report({}, {
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        STRIPE_SECRET_KEY: "pk_test_wrong_prefix",
      }),
    );

    expect(text).toContain("Malformed - fix these, the app will not boot:");
    expect(text).toContain("  - STRIPE_SECRET_KEY (server)");
  });

  it("says so plainly when nothing is outstanding", () => {
    const text = formatEnvReport(
      report({ VERCEL_ENV: "production" }, {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        NEXT_PUBLIC_APP_URL: "https://example.com",
        DATABASE_URL: "postgres://u:p@ep-x-pooler.example.dev/main",
        STRIPE_SECRET_KEY: "sk_live_aaaaaaaaaaaa",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_aaaaaaaaaaaa",
      }),
    );

    expect(text).toContain("6 of 6 variables set");
    expect(text).toContain("Everything this environment requires is set.");
  });

  it("emits no colour escape codes", () => {
    const text = formatEnvReport(report({}, {}));

    // ANSI sequences start with ESC (char 27) and survive into build logs as
    // literal noise, burying the one line the reader needed.
    expect(text.includes(String.fromCharCode(27))).toBe(false);
  });
});
