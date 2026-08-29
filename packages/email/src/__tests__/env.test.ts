import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EMAIL_ENV_GROUP, emailServer } from "../env.js";

const server = emailServer();

describe("RESEND_API_KEY", () => {
  it("is OPTIONAL, so a deployment with no email credential still boots", () => {
    // The decision the whole package rests on. Required here means a preview
    // branch, a fresh clone and a self-hosted install all fail at boot on a
    // credential they do not need.
    expect(server.RESEND_API_KEY.safeParse(undefined).success).toBe(true);
  });

  it("accepts a real-shaped key", () => {
    expect(server.RESEND_API_KEY.safeParse("re_TestKey_000000000000").success).toBe(
      true,
    );
  });

  it("rejects a key from a different provider pasted into the slot", () => {
    expect(server.RESEND_API_KEY.safeParse("sk_test_51Abc123Def456").success).toBe(
      false,
    );
  });

  it("rejects a truncated key that still starts with re_", () => {
    expect(server.RESEND_API_KEY.safeParse("re_abc").success).toBe(false);
  });
});

describe("EMAIL_FROM", () => {
  it("accepts a bare address", () => {
    expect(server.EMAIL_FROM.safeParse("hello@riddlergo.com").success).toBe(true);
  });

  it("accepts the display-name form, which z.email() rejects", () => {
    // The regression, at the layer where it actually took the server down.
    // riddler-go validated this variable with z.string().email(), so setting
    // the recommended value stopped the app from booting and the error was
    // "Invalid email" — a message that blames a correct value.
    const value = "Riddler Go <hello@riddlergo.com>";
    expect(z.email().safeParse(value).success).toBe(false);
    expect(server.EMAIL_FROM.safeParse(value).success).toBe(true);
  });

  it("accepts a quoted display name containing a comma", () => {
    expect(
      server.EMAIL_FROM.safeParse('"Riddler, Go" <hello@riddlergo.com>').success,
    ).toBe(true);
  });

  it("is REQUIRED, because even a skipped row records who it came from", () => {
    expect(server.EMAIL_FROM.safeParse(undefined).success).toBe(false);
  });

  it("rejects rubbish", () => {
    for (const value of ["", "   ", "hello", "hello@", "Riddler Go <hello@x.com"]) {
      expect(server.EMAIL_FROM.safeParse(value).success).toBe(false);
    }
  });

  it("rejects an unquoted comma, which would make the header two addresses", () => {
    expect(server.EMAIL_FROM.safeParse("Riddler, Go <hello@x.com>").success).toBe(
      false,
    );
  });

  it("explains both accepted forms in the error", () => {
    // The failure this replaces said only "Invalid email", which points the
    // reader at the value rather than at the validator that could not read it.
    const result = server.EMAIL_FROM.safeParse("nope");
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues[0]?.message ?? "";
    expect(message).toMatch(/display name/);
    expect(message).toMatch(/</);
  });
});

describe("EMAIL_REPLY_TO", () => {
  it("is optional", () => {
    expect(server.EMAIL_REPLY_TO.safeParse(undefined).success).toBe(true);
  });

  it("takes a display name too, so replies are not held to a stricter rule", () => {
    expect(server.EMAIL_REPLY_TO.safeParse("Support <help@x.com>").success).toBe(true);
  });

  it("is still validated when it is set", () => {
    expect(server.EMAIL_REPLY_TO.safeParse("nope").success).toBe(false);
  });
});

describe("RESEND_WEBHOOK_SECRET", () => {
  it("is optional in the schema", () => {
    expect(server.RESEND_WEBHOOK_SECRET.safeParse(undefined).success).toBe(true);
  });

  it("accepts a whsec_ secret and rejects anything else", () => {
    expect(
      server.RESEND_WEBHOOK_SECRET.safeParse("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2La")
        .success,
    ).toBe(true);
    expect(server.RESEND_WEBHOOK_SECRET.safeParse("re_TestKey_00000000").success).toBe(
      false,
    );
    expect(server.RESEND_WEBHOOK_SECRET.safeParse("").success).toBe(false);
  });
});

describe("EMAIL_ENV_GROUP", () => {
  it("names the pair that only makes sense set together", () => {
    expect([...EMAIL_ENV_GROUP]).toEqual([
      "RESEND_API_KEY",
      "RESEND_WEBHOOK_SECRET",
    ]);
  });

  it("does not include EMAIL_FROM, which is unconditionally required", () => {
    // Listing it would imply it is optional when the others are unset, and it
    // is not: a skipped row still has to record the sender.
    expect([...EMAIL_ENV_GROUP]).not.toContain("EMAIL_FROM");
  });

  it("every name in the group is a variable this package actually declares", () => {
    // A group naming a variable nothing validates is a check that silently
    // passes forever.
    for (const key of EMAIL_ENV_GROUP) {
      expect(Object.keys(server)).toContain(key);
    }
  });
});
