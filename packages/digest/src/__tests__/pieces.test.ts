import { describe, expect, it } from "vitest";
import { escapeHtml, html, isSafeHtml, raw } from "../html.js";
import { defineEmailKinds, InvalidEmailKindError } from "../registry.js";
import { encodeSignUpChoice, parseSignUpChoice } from "../signup.js";
import { readUnsubscribe, signUnsubscribe } from "../tokens.js";

const SECRET = "a-secret-that-is-long-enough-0123456789";

describe("the html tag escapes every value", () => {
  it("escapes text and attributes, and keeps markup it made itself", () => {
    const name = `<script>alert("x")</script> & 'Co'`;
    const inner = html`<em>${name}</em>`;
    const out = html`<p title="${name}">${inner} ${[html`<b>1</b>`, "<i>"]} ${null}${undefined}${false}</p>`;
    expect(out.html).toBe(
      `<p title="${escapeHtml(name)}"><em>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;</em> <b>1</b>&lt;i&gt; </p>`,
    );
    expect(isSafeHtml(out)).toBe(true);
    expect(isSafeHtml("<p>plain</p>")).toBe(false);
    expect(raw("<hr>").html).toBe("<hr>");
  });
});

describe("the kinds are checked once, at load", () => {
  const section = { key: "today", render: () => null };
  it("refuses a key used twice, across digests and alerts", () => {
    expect(() =>
      defineEmailKinds({
        digests: [{ key: "morning", title: "Morning summary", description: "Yesterday's results.", sections: [section] }],
        alerts: [{ key: "morning", title: "Morning alerts", description: "x" }],
      }),
    ).toThrow(InvalidEmailKindError);
  });
  it("refuses a key that isn't lowercase letters, digits and hyphens", () => {
    expect(() => defineEmailKinds({ alerts: [{ key: "Price_Alerts", title: "Price alerts", description: "x" }] })).toThrow(/lowercase/);
  });
  it("refuses two sections with one key, and a section with no render", () => {
    expect(() =>
      defineEmailKinds({ digests: [{ key: "morning", title: "M", description: "d", sections: [section, section] }] }),
    ).toThrow(/two sections/);
    expect(() =>
      defineEmailKinds({ digests: [{ key: "morning", title: "M", description: "d", sections: [{ key: "x" } as never] }] }),
    ).toThrow(/render/);
  });
  it("offers a digest only once it has a section", () => {
    const kinds = defineEmailKinds({
      digests: [
        { key: "morning", title: "Morning summary", description: "d", sections: [section] },
        { key: "evening", title: "Evening summary", description: "d", sections: [] },
      ],
      alerts: [{ key: "price-alerts", title: "Price alerts", description: "d" }],
    });
    expect(kinds.offered.map((kind) => kind.key)).toEqual(["morning", "price-alerts"]);
    expect(kinds.kind("evening")).toBeNull();
    expect(kinds.digest("evening")?.key).toBe("evening");
  });
});

describe("a signed unsubscribe link is one person's, for one email", () => {
  it("reads back who and which", () => {
    const token = signUnsubscribe(SECRET, "user_ann", "morning");
    expect(readUnsubscribe(SECRET, token)).toEqual({ userId: "user_ann", kind: "morning" });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("refuses another person's id under this person's signature", () => {
    const token = signUnsubscribe(SECRET, "user_ann", "morning");
    const signature = token.split(".")[1];
    const forged = `${Buffer.from("user_bo\nmorning").toString("base64url")}.${signature}`;
    expect(readUnsubscribe(SECRET, forged)).toBeNull();
  });

  it("refuses another email kind under the same signature, a wrong secret, and anything else", () => {
    const token = signUnsubscribe(SECRET, "user_ann", "morning");
    const [, signature] = token.split(".");
    expect(readUnsubscribe(SECRET, `${Buffer.from("user_ann\nprice-alerts").toString("base64url")}.${signature}`)).toBeNull();
    expect(readUnsubscribe("another-secret-that-is-long-enough-012345", token)).toBeNull();
    for (const bad of ["", "abc", "a.b.c", `${token}x`, `${token.split(".")[0]}.`, null, 7]) expect(readUnsubscribe(SECRET, bad)).toBeNull();
  });
});

describe("the sign-up choice cookie", () => {
  it("round-trips, keeping only a real zone and plain keys", () => {
    expect(parseSignUpChoice(encodeSignUpChoice({ timeZone: "America/Chicago", digests: ["morning"] }))).toEqual({
      timeZone: "America/Chicago",
      digests: ["morning"],
    });
    expect(parseSignUpChoice(encodeSignUpChoice({ timeZone: "Mars/Olympus", digests: ["morning", "<b>"] }))).toEqual({
      timeZone: null,
      digests: ["morning"],
    });
    expect(parseSignUpChoice("not json")).toBeNull();
    expect(parseSignUpChoice(undefined)).toBeNull();
  });
});
