import { afterEach, describe, expect, it, vi } from "vitest";
import { errorSentence, FeedbackTransport } from "../transport.js";
import { reportsInstallId } from "../reports.js";

/**
 * 0.4.0: a company's own feedback page sends no website key, a closed form
 * says so in its config, and a refusal's sentence reaches the screen whatever
 * shape it came in — never an object rendered as text.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function capture(response: Response) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    return response.clone();
  });
  return calls;
}

describe("the transport", () => {
  it("sends the website key when there is one, and no key header without one", async () => {
    const withKey = capture(Response.json({ categories: [] }));
    await new FeedbackTransport("/api/igloo", "aik_abc").fetchConfig();
    expect(withKey[0]?.headers["x-adminigloo-key"]).toBe("aik_abc");
    vi.unstubAllGlobals();
    const without = capture(Response.json({ categories: [] }));
    await new FeedbackTransport("/api/t/green-acres/feedback").fetchConfig();
    expect(without[0]?.url).toBe("/api/t/green-acres/feedback/v1/config");
    expect(Object.keys(without[0]?.headers ?? {})).not.toContain("x-adminigloo-key");
  });

  it("reads a closed form's sentence from its config", async () => {
    capture(Response.json({ categories: [{ key: "bug", label: "Bug" }], closed: "Green Acres isn't taking requests online right now." }));
    expect(await new FeedbackTransport("/x").fetchConfig()).toEqual({
      categories: [{ key: "bug", label: "Bug" }],
      closed: "Green Acres isn't taking requests online right now.",
    });
  });

  it("shows the server's sentence on a refused submit, in either shape", async () => {
    capture(Response.json({ error: "This feedback form isn't taking new reports right now.", code: "feedback_closed" }, { status: 409 }));
    expect(await new FeedbackTransport("/x").submit({} as never)).toEqual({
      ok: false,
      error: "This feedback form isn't taking new reports right now.",
    });
  });
});

describe("errorSentence", () => {
  it("never returns an object", () => {
    expect(errorSentence({ error: { code: "x", message: "Plain words." } }, "fallback")).toBe("Plain words.");
    expect(errorSentence({ error: { code: "x" } }, "fallback")).toBe("fallback");
    expect(errorSentence(null, "fallback")).toBe("fallback");
  });
});

describe("which list a report is kept in", () => {
  it("keeps a keyed install's list where it always was, and gives each keyless page its own", () => {
    expect(reportsInstallId({ baseUrl: "/api/igloo", clientKey: "aik_123" })).toBe("aik_123");
    const a = reportsInstallId({ baseUrl: "/api/t/green-acres/feedback" });
    const b = reportsInstallId({ baseUrl: "/api/t/summit/feedback" });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^p-[0-9a-f]{8}$/);
  });
});

describe("the honeypot", () => {
  it("is sent with the report, so the platform can refuse one a script filled in", async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ ticketNumber: "FB-00001", ticketToken: "aft_x" }, { status: 201 });
    });
    await new FeedbackTransport("/x").submit({ description: "a long enough report", priority: "low", website: "" } as never);
    expect(sent).toHaveProperty("website", "");
  });
});
