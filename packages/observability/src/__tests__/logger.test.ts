import { describe, expect, it } from "vitest";
import type { DestinationStream } from "pino";
import {
  createLogger,
  redactValue,
  REDACTED,
  REDACT_PATHS,
} from "../logger.js";

/**
 * pino writes to a plain `{ write }` object synchronously, so every assertion
 * below reads real pino output rather than a re-implementation of the paths.
 * That matters: an unmatched fast-redact path is not an error, it is a path
 * that never fires, so the only way to know the list works is to make it work.
 */
function capture(): {
  readonly stream: DestinationStream;
  lines(): readonly Record<string, unknown>[];
} {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    lines() {
      return chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

describe("createLogger — the redaction list is actually wired", () => {
  it("censors an Authorization header three levels down", () => {
    const sink = capture();
    createLogger({ destination: sink.stream }).info({
      req: { headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.aaaa.bbbb" } },
    });
    expect(JSON.stringify(sink.lines())).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(JSON.stringify(sink.lines())).toContain(REDACTED);
  });

  it.each([
    ["top level", { authorization: "Bearer topsecrettoken" }],
    ["under one key", { headers: { authorization: "Bearer topsecrettoken" } }],
    ["capitalised", { headers: { Authorization: "Bearer topsecrettoken" } }],
  ])("censors an Authorization header %s", (_shape, payload) => {
    const sink = capture();
    createLogger({ destination: sink.stream }).info(payload);
    expect(JSON.stringify(sink.lines())).not.toContain("topsecrettoken");
  });

  it("censors DATABASE_URL when the environment is dumped into a log line", () => {
    // The exact shape of the incident this list exists for: something throws
    // during boot, someone logs `{ env: process.env }` to find out why, and
    // the Neon role password is in the aggregator from then on.
    const sink = capture();
    createLogger({ destination: sink.stream }).error({
      env: {
        DATABASE_URL: "postgresql://neondb_owner:npg_supersecret@ep-x-pooler.neon.tech/db",
        NODE_ENV: "production",
      },
    });
    const output = JSON.stringify(sink.lines());
    expect(output).not.toContain("npg_supersecret");
    // The variables that are not secrets survive, or nobody will use this.
    expect(output).toContain("production");
  });

  it("censors a Stripe signature header — a signed replayable request", () => {
    const sink = capture();
    createLogger({ destination: sink.stream }).warn({
      headers: { "stripe-signature": "t=1756382400,v1=deadbeef" },
    });
    expect(JSON.stringify(sink.lines())).not.toContain("deadbeef");
  });

  it("censors a nested secret one level down", () => {
    const sink = capture();
    createLogger({ destination: sink.stream }).info({
      input: { email: "ada@example.com", password: "hunter2" },
    });
    const output = JSON.stringify(sink.lines());
    expect(output).not.toContain("hunter2");
    expect(output).toContain("ada@example.com");
  });

  it("adds caller paths without dropping the defaults", () => {
    const sink = capture();
    createLogger({
      destination: sink.stream,
      redact: ["*.dateOfBirth"],
    }).info({ patient: { dateOfBirth: "1970-01-01", password: "hunter2" } });
    const output = JSON.stringify(sink.lines());
    expect(output).not.toContain("1970-01-01");
    expect(output).not.toContain("hunter2");
  });

  it("does not throw when a caller re-lists a default path", () => {
    // fast-redact rejects duplicate paths by throwing during construction,
    // which would kill the process before it could log why.
    expect(() =>
      createLogger({
        destination: capture().stream,
        redact: ["*.password", "password"],
      }),
    ).not.toThrow();
  });

  it("writes the level as a string, not as 30", () => {
    const sink = capture();
    createLogger({ destination: sink.stream }).info("hello");
    expect(sink.lines()[0]?.level).toBe("info");
  });

  it("honours the level and stamps base fields on every line", () => {
    const sink = capture();
    const logger = createLogger({
      level: "warn",
      base: { service: "web", release: "abc123" },
      destination: sink.stream,
    });
    logger.info("dropped");
    logger.warn("kept");
    const lines = sink.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.service).toBe("web");
    expect(lines[0]?.release).toBe("abc123");
  });
});

describe("REDACT_PATHS", () => {
  it("covers every credential-bearing variable this scaffold declares", () => {
    for (const name of [
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "CLERK_SECRET_KEY",
      "CLERK_WEBHOOK_SIGNING_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "RESEND_API_KEY",
      "UPSTASH_REDIS_REST_TOKEN",
    ]) {
      expect(REDACT_PATHS).toContain(name);
      expect(REDACT_PATHS).toContain(`*.${name}`);
    }
  });

  it("lists each secret property both bare and nested", () => {
    // Two different paths. Neither form implies the other, and shipping only
    // the wildcard is how a top-level `{ token }` stays in the clear.
    for (const name of ["password", "token", "secret", "apiKey"]) {
      expect(REDACT_PATHS).toContain(name);
      expect(REDACT_PATHS).toContain(`*.${name}`);
    }
  });

  it("has no duplicates of its own", () => {
    expect(new Set(REDACT_PATHS).size).toBe(REDACT_PATHS.length);
  });
});

describe("redactValue — credential shapes", () => {
  it.each([
    ["sk_live_51H8xKzABCDEFGHijklmnop", "Stripe secret key"],
    ["sk_test_51H8xKzABCDEFGHijklmnop", "Clerk / Stripe test secret key"],
    ["pk_test_Y2xlcmsuZXhhbXBsZS5jb20k", "publishable key"],
    ["rk_live_51H8xKzABCDEFGHijklmnop", "restricted key"],
    ["whsec_A1b2C3d4E5f6G7h8I9j0K1l2", "webhook signing secret"],
    ["re_123456789_abcdefghijklmnop", "Resend key"],
  ])("masks %s (%s)", (credential) => {
    expect(redactValue(credential)).toBe(REDACTED);
  });

  it("masks a credential embedded in a sentence, keeping the sentence", () => {
    const masked = redactValue(
      "Stripe rejected key sk_live_51H8xKzABCDEFGHijklmnop for account acct_1",
    );
    expect(masked).toBe(`Stripe rejected key ${REDACTED} for account acct_1`);
  });

  it("masks every credential in a string, not just the first", () => {
    const masked = redactValue(
      "tried sk_live_51H8xKzABCDEFGHijklmnop then sk_test_51H8xKzABCDEFGHijklmnop",
    );
    expect(masked).toBe(`tried ${REDACTED} then ${REDACTED}`);
  });

  it("masks a JWT — an access token in a message is a live session", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redactValue(`token=${jwt}`)).toBe(`token=${REDACTED}`);
  });

  it("keeps the auth scheme so a 401 is still diagnosable", () => {
    expect(redactValue("Authorization: Bearer abcdefghijklmnop")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactValue("Basic YWxhZGRpbjpvcGVuc2VzYW1l")).toBe(
      `Basic ${REDACTED}`,
    );
  });

  it("masks the password in a connection string and keeps the host", () => {
    // The whole reason this is not a blanket mask: "which database refused
    // us" is the question, and the host is not the secret.
    expect(
      redactValue(
        "connect ECONNREFUSED postgresql://neondb_owner:npg_s3cret@ep-cool-pooler.neon.tech/neondb?sslmode=require",
      ),
    ).toBe(
      `connect ECONNREFUSED postgresql://${REDACTED}@ep-cool-pooler.neon.tech/neondb?sslmode=require`,
    );
  });

  it.each([
    ["redis://default:AX9sASQpassword@fly-cache.upstash.io:6379", "AX9sASQpassword"],
    ["mongodb+srv://svc:p4ssw0rd@cluster0.mongodb.net/app", "p4ssw0rd"],
    ["amqps://user:rabbitpw@rabbit.internal:5671", "rabbitpw"],
  ])("masks the userinfo in %s", (url, credential) => {
    const masked = String(redactValue(url));
    expect(masked).not.toContain(credential);
    expect(masked).toContain(REDACTED);
    // The host survives, because the host is the diagnosis.
    expect(masked).toContain(url.slice(url.indexOf("@") + 1));
  });

  it("leaves a connection string with no credential alone", () => {
    const url = "postgresql://ep-cool-pooler.neon.tech/neondb";
    expect(redactValue(url)).toBe(url);
  });
});

describe("redactValue — does not destroy the log it is protecting", () => {
  it.each([
    "user_2abc",
    "acct_1H8xKz",
    "evt_3PqRsT",
    "re_run the migration",
    "sk_",
    "Cannot read properties of undefined (reading 'tenantId')",
    "",
  ])("leaves %o untouched", (value) => {
    expect(redactValue(value)).toBe(value);
  });

  it("passes non-strings through unchanged", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
    expect(redactValue(true)).toBe(true);
  });
});

describe("redactValue — structures", () => {
  it("recurses into nested objects and arrays", () => {
    expect(
      redactValue({
        attempts: [
          { key: "sk_live_51H8xKzABCDEFGHijklmnop" },
          { key: "whsec_A1b2C3d4E5f6G7h8I9j0K1l2" },
        ],
        tenant: { id: "t_42" },
      }),
    ).toEqual({
      attempts: [{ key: REDACTED }, { key: REDACTED }],
      tenant: { id: "t_42" },
    });
  });

  it("never mutates its argument", () => {
    const input = { key: "sk_live_51H8xKzABCDEFGHijklmnop" };
    redactValue(input);
    expect(input.key).toBe("sk_live_51H8xKzABCDEFGHijklmnop");
  });

  it("survives a cycle instead of overflowing the stack", () => {
    // A logged request object references its response, which references the
    // request. A recursive walk with no guard takes the process down, and it
    // does it inside the error handler that was trying to report something.
    const node: Record<string, unknown> = { key: "sk_live_51H8xKzABCDEFGHij" };
    node.self = node;
    expect(redactValue(node)).toEqual({ key: REDACTED, self: "[circular]" });
  });

  it("does not mistake a shared reference for a cycle", () => {
    // The same tenant object hung off two entities is a DAG, not a loop.
    // Reporting it as circular deletes real data from the log.
    const tenant = { id: "t_42" };
    expect(redactValue({ a: tenant, b: tenant })).toEqual({
      a: { id: "t_42" },
      b: { id: "t_42" },
    });
  });

  it("keeps an Error's message and stack, which a generic walk would drop", () => {
    // `message` and `stack` are non-enumerable, so `Object.entries` on an
    // Error returns [] — the whole error would vanish to redact nothing.
    const error = new Error(
      "connect failed: postgresql://u:p4ss@ep-x-pooler.neon.tech/db",
    );
    const redacted = redactValue(error) as {
      name: string;
      message: string;
      stack: string;
    };
    expect(redacted.name).toBe("Error");
    expect(redacted.message).toContain(REDACTED);
    expect(redacted.message).not.toContain("p4ss");
    expect(redacted.stack).toContain("Error:");
  });

  it("leaves a Date a Date rather than flattening it to {}", () => {
    const date = new Date("2026-08-28T10:00:00Z");
    expect(redactValue({ at: date })).toEqual({ at: date });
  });

  it("leaves Maps, Sets and Buffers alone", () => {
    const map = new Map([["a", 1]]);
    const set = new Set([1]);
    const buffer = Buffer.from("abc");
    expect(redactValue({ map, set, buffer })).toEqual({ map, set, buffer });
  });
});

describe("credential shapes added after review", () => {
  it.each([
    ["sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Anthropic"],
    ["sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "OpenAI project"],
    ["sk-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", "OpenAI classic"],
    ["AIzaSyDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", "Google"],
    ["ghp_EEEEEEEEEEEEEEEEEEEEEEEEEEEE", "GitHub"],
  ])("masks a %s key (%s)", (key) => {
    const out = redactValue(`request failed with key ${key}`);
    expect(out).not.toContain(key);
  });

  it("does not leave the tail of a hyphenated key behind", () => {
    // A generic `sk-` rule matching first would consume only `sk-` and leave
    // `ant-api03-…` in the log, which is still the whole secret.
    const out = redactValue("sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(out).not.toMatch(/ant-api03/);
  });

  it("names every credential-bearing variable this scaffold declares", () => {
    for (const name of [
      "RESEND_WEBHOOK_SECRET",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "CRON_SECRET",
      "BLOB_READ_WRITE_TOKEN",
    ]) {
      expect(REDACT_PATHS, `${name} is not redacted`).toContain(name);
    }
  });
});
