import { describe, expect, it } from "vitest";
import { isDeployed, resolveAppEnv } from "../app-env.js";

describe("resolveAppEnv", () => {
  it("maps Vercel production to production", () => {
    expect(resolveAppEnv({ VERCEL_ENV: "production" })).toBe("production");
  });

  it("maps Vercel preview to staging", () => {
    expect(resolveAppEnv({ VERCEL_ENV: "preview" })).toBe("staging");
  });

  it("falls back to local when VERCEL_ENV is absent", () => {
    expect(resolveAppEnv({})).toBe("local");
  });

  it("treats an unrecognised VERCEL_ENV as local, never production", () => {
    expect(resolveAppEnv({ VERCEL_ENV: "prod" })).toBe("local");
    expect(resolveAppEnv({ VERCEL_ENV: "PRODUCTION" })).toBe("local");
  });

  it("ignores an APP_ENV variable — the value is derived, not declared", () => {
    expect(resolveAppEnv({ APP_ENV: "production" })).toBe("local");
  });
});

describe("isDeployed", () => {
  it.each([
    [{ VERCEL_ENV: "production" }, true],
    [{ VERCEL_ENV: "preview" }, true],
    [{ VERCEL_ENV: "development" }, false],
    [{}, false],
  ])("%o -> %s", (source, expected) => {
    expect(isDeployed(source)).toBe(expected);
  });
});
