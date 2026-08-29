import { describe, expect, it } from "vitest";
import { aiServer, configuredAiProviders, isAiConfigured } from "../env.js";

const server = aiServer();

describe("aiServer fragment", () => {
  it("accepts an absent key for every provider", () => {
    // The point of the whole fragment. A preview branch working on billing must
    // boot with no inference credentials at all; requiring them is how you get
    // a deployment that will not start over a feature nobody on that branch was
    // using, and the fix people reach for is a fake key.
    expect(server.ANTHROPIC_API_KEY.safeParse(undefined).success).toBe(true);
    expect(server.OPENAI_API_KEY.safeParse(undefined).success).toBe(true);
    expect(server.GOOGLE_GENERATIVE_AI_API_KEY.safeParse(undefined).success).toBe(true);
  });

  it("rejects a key that is set but empty", () => {
    // Absent degrades cleanly; empty does not. The variable exists, so nothing
    // hides the feature, and the failure surfaces as a 401 from the provider on
    // the first user prompt instead of at boot with the variable named.
    expect(server.ANTHROPIC_API_KEY.safeParse("").success).toBe(false);
    expect(server.OPENAI_API_KEY.safeParse("").success).toBe(false);
    expect(server.GOOGLE_GENERATIVE_AI_API_KEY.safeParse("").success).toBe(false);
  });

  it("accepts a real-shaped Anthropic key", () => {
    expect(
      server.ANTHROPIC_API_KEY.safeParse("sk-ant-api03-AbCdEf0123456789").success,
    ).toBe(true);
  });

  it("rejects an OpenAI key pasted into the Anthropic slot", () => {
    // Both are copied from a browser tab into adjacent dashboard rows, and
    // without the prefix check the mistake surfaces as an authentication error
    // from a provider nobody thought they were calling.
    expect(server.ANTHROPIC_API_KEY.safeParse("sk-proj-AbCdEf0123456789").success).toBe(
      false,
    );
  });

  it("accepts every OpenAI key shape, present and future", () => {
    // Only `sk-` is asserted: OpenAI has shipped sk-, sk-proj-, sk-svcacct- and
    // sk-admin-, and pinning today's longest prefix turns tomorrow's valid key
    // into a boot failure.
    for (const key of [
      "sk-AbCdEf0123456789",
      "sk-proj-AbCdEf0123456789",
      "sk-svcacct-AbCdEf0123456789",
      "sk-admin-AbCdEf0123456789",
    ]) {
      expect(server.OPENAI_API_KEY.safeParse(key).success).toBe(true);
    }
  });

  it("rejects an Anthropic key pasted into the OpenAI slot only if it lacks sk-", () => {
    // `sk-ant-…` does start with `sk-`, so this check cannot catch that swap.
    // Stated here so nobody adds a test asserting a guarantee the prefix does
    // not give: the Anthropic slot is the one that catches the pair.
    expect(server.OPENAI_API_KEY.safeParse("sk-ant-api03-AbCdEf0123456789").success).toBe(
      true,
    );
    expect(server.OPENAI_API_KEY.safeParse("AIzaSyA-0123456789abcdefg").success).toBe(
      false,
    );
  });

  it("accepts both Google credential shapes, because a prefix rule would reject one", () => {
    expect(
      server.GOOGLE_GENERATIVE_AI_API_KEY.safeParse("AIzaSyA-0123456789abcdefg").success,
    ).toBe(true);
    expect(
      server.GOOGLE_GENERATIVE_AI_API_KEY.safeParse("ya29.a0AfB_byC-token").success,
    ).toBe(true);
  });
});

describe("configuredAiProviders", () => {
  it("reports nothing when the deployment has no credentials", () => {
    expect(configuredAiProviders({})).toEqual([]);
    expect(isAiConfigured({})).toBe(false);
  });

  it("reports only the providers that are actually usable", () => {
    expect(configuredAiProviders({ ANTHROPIC_API_KEY: "sk-ant-api03-x" })).toEqual([
      "anthropic",
    ]);
    expect(
      configuredAiProviders({
        ANTHROPIC_API_KEY: "sk-ant-api03-x",
        OPENAI_API_KEY: "sk-proj-x",
        GOOGLE_GENERATIVE_AI_API_KEY: "AIza-x",
      }),
    ).toEqual(["anthropic", "openai", "google"]);
  });

  it("treats whitespace as absent", () => {
    // These values also arrive from places no schema has seen: a shell export,
    // a .env copied with a trailing space, a secrets manager that stores " "
    // for a cleared field. Any of them would otherwise present as configured
    // and fail at the provider.
    expect(configuredAiProviders({ OPENAI_API_KEY: "   " })).toEqual([]);
    expect(isAiConfigured({ OPENAI_API_KEY: "" })).toBe(false);
  });

  it("is true as soon as one provider works", () => {
    expect(isAiConfigured({ GOOGLE_GENERATIVE_AI_API_KEY: "AIza-x" })).toBe(true);
  });
});
