import { describe, expect, it } from "vitest";
import {
  OBSERVABILITY_ENV_GROUPS,
  groupComplete,
  observabilityGroupStatus,
  observabilityServer,
} from "../env.js";

const UPSTASH = OBSERVABILITY_ENV_GROUPS.upstash;

describe("observabilityServer", () => {
  it("declares only optional variables", () => {
    // An app boots with none of these set. Requiring them means a developer
    // cannot start locally without two vendor accounts, and the reliable
    // outcome of that is a shared .env passed around in chat.
    const schemas = observabilityServer();
    for (const schema of Object.values(schemas)) {
      expect(schema.safeParse(undefined).success).toBe(true);
    }
  });

  it("does not redeclare LOG_LEVEL, which coreServer already owns", () => {
    // Two schemas for one variable: spread order picks the winner, and they
    // drift the first time one of them gains an enum member.
    expect(Object.keys(observabilityServer())).not.toContain("LOG_LEVEL");
  });

  it("rejects the redis:// connection string in the REST URL slot", () => {
    // The mistake this catches costs an afternoon: the REST client cannot open
    // a TCP connection from an edge runtime, and the failure surfaces as a
    // fetch error with no mention of the wrong variable.
    const schema = observabilityServer().UPSTASH_REDIS_REST_URL;
    expect(schema.safeParse("redis://default:pw@fly.upstash.io:6379").success).toBe(
      false,
    );
    expect(schema.safeParse("https://apn1-cool-cat-12345.upstash.io").success).toBe(
      true,
    );
  });

  it("rejects a SENTRY_DSN that is not a URL", () => {
    const schema = observabilityServer().SENTRY_DSN;
    expect(schema.safeParse("my-project").success).toBe(false);
    expect(schema.safeParse("https://abc@o1.ingest.sentry.io/2").success).toBe(true);
  });
});

describe("groupComplete", () => {
  it("reports a fully configured group", () => {
    const status = groupComplete("upstash", UPSTASH, {
      UPSTASH_REDIS_REST_URL: "https://apn1.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "AX9sASQ",
    });
    expect(status.state).toBe("configured");
    expect(status.missing).toEqual([]);
    expect(status.warning).toBeNull();
  });

  it("reports an entirely unset group as absent, not as a problem", () => {
    const status = groupComplete("upstash", UPSTASH, {});
    expect(status.state).toBe("absent");
    expect(status.present).toEqual([]);
    expect(status.warning).toBeNull();
  });

  it("warns — and does not throw — on a half-configured group", () => {
    // Half configured is a legitimate state for the thirty seconds between
    // pasting the first variable into a dashboard and pasting the second.
    // Throwing there takes production down over an optional feature.
    const status = groupComplete("upstash", UPSTASH, {
      UPSTASH_REDIS_REST_URL: "https://apn1.upstash.io",
    });
    expect(status.state).toBe("partial");
    expect(status.warning).not.toBeNull();
  });

  it("names both halves in the warning", () => {
    // Silence is the other failure: the URL ships without the token, every
    // rate-limit check throws at request time, and nothing at boot connects
    // the 500s to the missing variable.
    const status = groupComplete("upstash", UPSTASH, {
      UPSTASH_REDIS_REST_URL: "https://apn1.upstash.io",
    });
    expect(status.warning).toContain("UPSTASH_REDIS_REST_URL");
    expect(status.warning).toContain("UPSTASH_REDIS_REST_TOKEN");
  });

  it("treats an empty string as absent", () => {
    // Clearing a variable in the Vercel dashboard leaves it present and empty.
    // Counting that as configured is how a group reports itself complete while
    // holding an empty token.
    expect(
      groupComplete("upstash", UPSTASH, {
        UPSTASH_REDIS_REST_URL: "",
        UPSTASH_REDIS_REST_TOKEN: "",
      }).state,
    ).toBe("absent");
  });

  it("treats whitespace as absent", () => {
    expect(
      groupComplete("upstash", UPSTASH, {
        UPSTASH_REDIS_REST_URL: "https://apn1.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "   ",
      }).state,
    ).toBe("partial");
  });

  it("never throws, whatever it is handed", () => {
    expect(() => groupComplete("nothing", [], {})).not.toThrow();
    expect(groupComplete("nothing", [], {}).state).toBe("configured");
  });

  it("cannot report a one-member group as partial", () => {
    // With nothing to be inconsistent with, it is configured or absent.
    for (const source of [{}, { SENTRY_DSN: "https://abc@o1.ingest.sentry.io/2" }]) {
      expect(
        groupComplete("sentry", OBSERVABILITY_ENV_GROUPS.sentry, source).state,
      ).not.toBe("partial");
    }
  });
});

describe("observabilityGroupStatus", () => {
  it("reports every group this package owns", () => {
    const statuses = observabilityGroupStatus({
      SENTRY_DSN: "https://abc@o1.ingest.sentry.io/2",
      UPSTASH_REDIS_REST_URL: "https://apn1.upstash.io",
    });
    expect(statuses.map((s) => s.name)).toEqual(["sentry", "upstash"]);
    expect(statuses.find((s) => s.name === "sentry")?.state).toBe("configured");
    expect(statuses.find((s) => s.name === "upstash")?.state).toBe("partial");
  });

  it("returns statuses rather than logging them", () => {
    // The environment check must not depend on the logger whose configuration
    // it is checking.
    expect(Array.isArray(observabilityGroupStatus({}))).toBe(true);
  });
});
