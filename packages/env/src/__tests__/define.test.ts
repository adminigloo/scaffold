import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineEnv } from "../define.js";
import { coreClient, coreServer } from "../fragments.js";
import { pooledPostgresUrl, prefixedSecret } from "../schemas.js";
import { KeyModeMismatchError } from "../validators.js";

const STRIPE_KEYS = ["STRIPE_SECRET_KEY"] as const;

function build(
  source: Record<string, string | undefined>,
  runtimeEnv: Record<string, string | undefined>,
  skipValidation?: boolean,
) {
  return defineEnv({
    source,
    skipValidation,
    server: { ...coreServer(), STRIPE_SECRET_KEY: z.string().optional() },
    client: { ...coreClient(source) },
    modeBoundKeys: STRIPE_KEYS,
    runtimeEnv,
  });
}

describe("defineEnv", () => {
  it("builds a valid local environment", () => {
    const env = build(
      {},
      {
        NODE_ENV: "development",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        STRIPE_SECRET_KEY: "sk_test_x",
      },
    );
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("refuses a localhost app url on a deployment", () => {
    expect(() =>
      build(
        { VERCEL_ENV: "preview" },
        { NEXT_PUBLIC_APP_URL: "http://localhost:3000", STRIPE_SECRET_KEY: "sk_test_x" },
      ),
    ).toThrow();
  });

  it("accepts a real origin on a deployment", () => {
    const env = build(
      { VERCEL_ENV: "preview" },
      {
        NEXT_PUBLIC_APP_URL: "https://staging.adminigloo.com",
        STRIPE_SECRET_KEY: "sk_test_x",
      },
    );
    expect(env.NEXT_PUBLIC_APP_URL).toBe("https://staging.adminigloo.com");
  });

  it("refuses a live key on preview", () => {
    expect(() =>
      build(
        { VERCEL_ENV: "preview" },
        {
          NEXT_PUBLIC_APP_URL: "https://staging.adminigloo.com",
          STRIPE_SECRET_KEY: "sk_live_x",
        },
      ),
    ).toThrow(KeyModeMismatchError);
  });

  it("requires a live key on production", () => {
    expect(() =>
      build(
        { VERCEL_ENV: "production" },
        {
          NEXT_PUBLIC_APP_URL: "https://adminigloo.com",
          STRIPE_SECRET_KEY: "sk_test_x",
        },
      ),
    ).toThrow(KeyModeMismatchError);
  });

  // The load-bearing test. skipValidation exists for CI type-check jobs that
  // have no secrets; it must never become a way to run live keys off production.
  it("STILL enforces key mode when skipValidation is true", () => {
    expect(() =>
      build(
        { VERCEL_ENV: "preview" },
        { NEXT_PUBLIC_APP_URL: "http://localhost:3000", STRIPE_SECRET_KEY: "sk_live_x" },
        true,
      ),
    ).toThrow(KeyModeMismatchError);
  });

  it("skipValidation does relax the Zod pass", () => {
    // NEXT_PUBLIC_APP_URL is missing and would normally fail validation.
    expect(() => build({}, { STRIPE_SECRET_KEY: "sk_test_x" }, true)).not.toThrow();
  });

  it("skips validation automatically under NODE_ENV=test", () => {
    expect(() => build({ NODE_ENV: "test" }, {})).not.toThrow();
  });

  it("honours SKIP_ENV_VALIDATION from the source", () => {
    expect(() => build({ SKIP_ENV_VALIDATION: "1" }, {})).not.toThrow();
  });

  it("enforces key mode even under NODE_ENV=test", () => {
    expect(() =>
      build({ NODE_ENV: "test", VERCEL_ENV: "preview" }, { STRIPE_SECRET_KEY: "sk_live_x" }),
    ).toThrow(KeyModeMismatchError);
  });
});

describe("defineEnv — inferred value types", () => {
  it("produces usable types, not unknown", () => {
    const env = build(
      {},
      {
        NODE_ENV: "development",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        STRIPE_SECRET_KEY: "sk_test_x",
      },
    );

    // Compile-time assertions. Before InferEnvSchemas these were `unknown`,
    // so every consumer needed a cast and the generated app did not typecheck.
    const url: string = env.NEXT_PUBLIC_APP_URL;
    const level: "trace" | "debug" | "info" | "warn" | "error" | "fatal" = env.LOG_LEVEL;
    const secret: string | undefined = env.STRIPE_SECRET_KEY;

    expect(url).toBe("http://localhost:3000");
    expect(level).toBe("info");
    expect(secret).toBe("sk_test_x");
  });
});

// ---------------------------------------------------------------------------
// Graduated strictness
// ---------------------------------------------------------------------------

const LOCAL_URL = "http://localhost:3000";
const POOLED = "postgres://u:p@ep-quiet-pooler.example.dev/main";
const RELAXABLE = ["DATABASE_URL", "STRIPE_SECRET_KEY"] as const;

function buildGraduated(
  source: Record<string, string | undefined>,
  runtimeEnv: Record<string, string | undefined>,
  extra: {
    skipValidation?: boolean;
    optionalUntilDeployed?: readonly ("DATABASE_URL" | "STRIPE_SECRET_KEY")[];
  } = {},
) {
  return defineEnv({
    source,
    skipValidation: extra.skipValidation,
    server: {
      ...coreServer(),
      DATABASE_URL: pooledPostgresUrl(),
      STRIPE_SECRET_KEY: prefixedSecret("sk_"),
    },
    client: { ...coreClient(source) },
    modeBoundKeys: STRIPE_KEYS,
    optionalUntilDeployed: extra.optionalUntilDeployed ?? RELAXABLE,
    runtimeEnv,
  });
}

describe("defineEnv — optionalUntilDeployed", () => {
  it("boots locally with no database and no Stripe account", () => {
    const env = buildGraduated({}, { NEXT_PUBLIC_APP_URL: LOCAL_URL });

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.NEXT_PUBLIC_APP_URL).toBe(LOCAL_URL);
  });

  it("treats an empty value as absent, the same as the parser does", () => {
    const env = buildGraduated({}, { NEXT_PUBLIC_APP_URL: LOCAL_URL, DATABASE_URL: "" });

    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("still validates a listed variable that IS set", () => {
    const env = buildGraduated({}, { NEXT_PUBLIC_APP_URL: LOCAL_URL, DATABASE_URL: POOLED });

    expect(env.DATABASE_URL).toBe(POOLED);
  });

  // The edge case the whole option turns on. A pasted-wrong URL that is merely
  // tolerated resurfaces hours later as a connection error inside a request
  // handler, with nothing pointing back at the typo.
  it("REFUSES a listed variable that is present but malformed, even locally", () => {
    expect(() =>
      buildGraduated({}, {
        NEXT_PUBLIC_APP_URL: LOCAL_URL,
        DATABASE_URL: "postgres://u:p@direct.example.dev/main",
      }),
    ).toThrow();
  });

  it("does not swallow a default when a defaulted variable is listed", () => {
    // Listing LOG_LEVEL is pointless but not harmful: Zod's optional wrapper
    // defers to the inner default rather than short-circuiting on undefined.
    // Pinned because losing it would silently drop every defaulted variable
    // any package happens to list.
    const env = defineEnv({
      source: {},
      server: { ...coreServer(), DATABASE_URL: pooledPostgresUrl() },
      client: { ...coreClient({}) },
      optionalUntilDeployed: ["LOG_LEVEL", "DATABASE_URL"],
      runtimeEnv: { NEXT_PUBLIC_APP_URL: LOCAL_URL },
    });

    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("relaxes only the listed variables", () => {
    expect(() =>
      buildGraduated({}, { NEXT_PUBLIC_APP_URL: LOCAL_URL }, {
        optionalUntilDeployed: ["STRIPE_SECRET_KEY"],
      }),
    ).toThrow();
  });

  it("does not relax on preview", () => {
    expect(() =>
      buildGraduated(
        { VERCEL_ENV: "preview" },
        { NEXT_PUBLIC_APP_URL: "https://staging.example.com" },
      ),
    ).toThrow();
  });

  it("does not relax on production", () => {
    expect(() =>
      buildGraduated(
        { VERCEL_ENV: "production" },
        { NEXT_PUBLIC_APP_URL: "https://example.com" },
      ),
    ).toThrow();
  });

  it("leaves an unlisted required variable failing locally", () => {
    expect(() => buildGraduated({}, {})).toThrow();
  });
});

// Listing a key as optional says it may be ABSENT on a laptop. It never says a
// value that IS present may be the wrong mode — that assertion is the one
// guarantee this package exists to provide, and no option may reach it.
describe("defineEnv — optionalUntilDeployed never weakens the key-mode assertion", () => {
  const LIVE = "sk_live_aaaaaaaaaaaa";
  const TEST = "sk_test_aaaaaaaaaaaa";

  it("rejects a live key locally", () => {
    expect(() =>
      buildGraduated({}, { NEXT_PUBLIC_APP_URL: LOCAL_URL, STRIPE_SECRET_KEY: LIVE }),
    ).toThrow(KeyModeMismatchError);
  });

  it("rejects a live key on preview", () => {
    expect(() =>
      buildGraduated(
        { VERCEL_ENV: "preview" },
        {
          NEXT_PUBLIC_APP_URL: "https://staging.example.com",
          DATABASE_URL: POOLED,
          STRIPE_SECRET_KEY: LIVE,
        },
      ),
    ).toThrow(KeyModeMismatchError);
  });

  it("rejects a test key on production", () => {
    expect(() =>
      buildGraduated(
        { VERCEL_ENV: "production" },
        {
          NEXT_PUBLIC_APP_URL: "https://example.com",
          DATABASE_URL: POOLED,
          STRIPE_SECRET_KEY: TEST,
        },
      ),
    ).toThrow(KeyModeMismatchError);
  });

  it("rejects a live key when skipValidation is also on", () => {
    expect(() =>
      buildGraduated(
        { VERCEL_ENV: "preview" },
        { NEXT_PUBLIC_APP_URL: LOCAL_URL, STRIPE_SECRET_KEY: LIVE },
        { skipValidation: true },
      ),
    ).toThrow(KeyModeMismatchError);
  });

  it("rejects a live key when SKIP_ENV_VALIDATION is set in the source", () => {
    expect(() =>
      buildGraduated({ VERCEL_ENV: "preview", SKIP_ENV_VALIDATION: "1" }, {
        NEXT_PUBLIC_APP_URL: LOCAL_URL,
        STRIPE_SECRET_KEY: LIVE,
      }),
    ).toThrow(KeyModeMismatchError);
  });

  it("rejects a live key under NODE_ENV=test", () => {
    expect(() =>
      buildGraduated({ NODE_ENV: "test", VERCEL_ENV: "preview" }, {
        STRIPE_SECRET_KEY: LIVE,
      }),
    ).toThrow(KeyModeMismatchError);
  });
});

describe("defineEnv — relaxed value types", () => {
  it("widens the listed keys so a consumer cannot read them as definite", () => {
    const env = defineEnv({
      source: {},
      server: {
        ...coreServer(),
        DATABASE_URL: pooledPostgresUrl(),
        RESEND_API_KEY: prefixedSecret("re_"),
      },
      client: { ...coreClient({}) },
      optionalUntilDeployed: ["DATABASE_URL"],
      runtimeEnv: {
        NEXT_PUBLIC_APP_URL: LOCAL_URL,
        RESEND_API_KEY: "re_aaaaaaaaaaaa",
      },
    });

    const relaxed: string | undefined = env.DATABASE_URL;
    // The load-bearing assertion: if this stopped erroring, the type would be
    // promising a string that is undefined on every laptop, and the boot error
    // would have been traded for a crash at the first read.
    // @ts-expect-error DATABASE_URL may have been relaxed and is not definite
    const definite: string = env.DATABASE_URL;

    // Unlisted keys keep their exact types.
    const untouched: string = env.RESEND_API_KEY;

    expect(relaxed).toBeUndefined();
    expect(definite).toBeUndefined();
    expect(untouched).toBe("re_aaaaaaaaaaaa");
  });
});
