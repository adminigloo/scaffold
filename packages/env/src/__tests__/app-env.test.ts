import { describe, expect, it } from "vitest";
import { appEnvOrigin, isDeployed, resolveAppEnv } from "../app-env.js";

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

  // This used to assert the opposite — that APP_ENV was ignored, because the
  // value was "derived, not declared". Deriving it from VERCEL_ENV alone is
  // exactly what failed open on every host that is not Vercel, so APP_ENV is
  // now the supported way to name an environment. The tests below pin the two
  // properties that make honouring it safe.
  it("honours APP_ENV, so a non-Vercel host can say what it is", () => {
    expect(resolveAppEnv({ APP_ENV: "production" })).toBe("production");
    expect(resolveAppEnv({ APP_ENV: "staging" })).toBe("staging");
    expect(resolveAppEnv({ APP_ENV: "local" })).toBe("local");
  });

  it("lets the platform outrank APP_ENV, so a preview cannot declare itself production", () => {
    expect(
      resolveAppEnv({ VERCEL_ENV: "preview", APP_ENV: "production" }),
    ).toBe("staging");
  });

  it("does not let a mistyped APP_ENV become the permissive answer", () => {
    // Falls through to the unidentified default rather than parsing loosely. A
    // typo reaching a permissive branch is what gave paid goods away once.
    expect(resolveAppEnv({ APP_ENV: "prod", NODE_ENV: "production" })).toBe(
      "staging",
    );
    expect(appEnvOrigin({ APP_ENV: "prod", NODE_ENV: "production" })).toBe(
      "unidentified",
    );
  });

  it("treats a production artefact that nobody labelled as a deployment", () => {
    // The bug this whole module was rewritten for: NODE_ENV=production with no
    // platform variable used to read as somebody's laptop.
    expect(resolveAppEnv({ NODE_ENV: "production" })).toBe("staging");
    expect(appEnvOrigin({ NODE_ENV: "production" })).toBe("unidentified");
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

describe("isLocalRun (env 0.4): looks like the founder's own machine, production build included — for wording only", () => {
  it("a production build on a localhost app URL looks local", async () => {
    const { isLocalRun, resolveAppEnv } = await import("../app-env.js");
    const laptopBuild = { NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:3700" };
    expect(isLocalRun(laptopBuild)).toBe(true);
    expect(isLocalRun({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3700" })).toBe(true);
    // NEGATIVE CONTROL: the danger answer is unchanged — still staging, so live keys stay refused.
    expect(resolveAppEnv(laptopBuild)).toBe("staging");
  });

  it("never on a deployment, whatever its URL says, and never for an unlabelled box with a real URL", async () => {
    const { isLocalRun } = await import("../app-env.js");
    expect(isLocalRun({ NODE_ENV: "production", VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).toBe(false);
    expect(isLocalRun({ NODE_ENV: "production", APP_ENV: "staging", NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).toBe(false);
    expect(isLocalRun({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "https://almanac.example.com" })).toBe(false);
    expect(isLocalRun({ NODE_ENV: "production" })).toBe(false);
    expect(isLocalRun({ NODE_ENV: "development" })).toBe(true);
  });

  it("is a GUESS: a self-hosted server that loaded the project's .env.local looks exactly like a laptop (so nothing may grant on it)", async () => {
    const { isLocalRun, resolveAppEnv } = await import("../app-env.js");
    // `next start` on a VPS/Docker host reads .env.local in production; the generated one has a localhost URL.
    const server = { NODE_ENV: "production", HOSTNAME: "0.0.0.0", PORT: "8080", NEXT_PUBLIC_APP_URL: "http://localhost:3000" };
    expect(isLocalRun(server)).toBe(true);
    expect(resolveAppEnv(server)).toBe("staging");
    // Naming the environment is what tells them apart.
    expect(isLocalRun({ ...server, APP_ENV: "production" })).toBe(false);
  });
});
