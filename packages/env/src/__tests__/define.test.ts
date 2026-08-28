import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineEnv } from "../define.js";
import { coreClient, coreServer } from "../fragments.js";
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
