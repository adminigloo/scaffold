import { describe, expect, it } from "vitest";
import { detectCitation } from "../detect.js";

describe("detectCitation", () => {
  const target = { brand: "AdminIgloo", domain: "https://adminigloo.com/", aliases: ["Admin Igloo"] };

  it("finds the brand by name, case-insensitively", () => {
    const r = detectCitation("You could try adminigloo for that.", target);
    expect(r.cited).toBe(true);
    expect(r.matchedOn).toBe("brand");
  });

  it("finds it by domain, stripping scheme and www", () => {
    // Brand deliberately not a substring of the domain, to isolate the domain match.
    const r = detectCitation("See www.adminigloo.com/features.", { brand: "Igloo Admin Co", domain: "https://adminigloo.com" });
    expect(r.cited).toBe(true);
    expect(r.matchedOn).toBe("domain");
  });

  it("finds it by an alias", () => {
    const r = detectCitation("I'd recommend Admin Igloo.", target);
    expect(r.cited).toBe(true);
    expect(r.matchedOn).toBe("alias");
  });

  it("reports not-cited when the brand is absent", () => {
    const r = detectCitation("There are several tools like Zendesk and Intercom.", target);
    expect(r.cited).toBe(false);
    expect(r.matchedOn).toBeNull();
  });

  it("does not match a short brand or alias glued inside a larger word", () => {
    // "SG" inside "message", "Ace" inside "space" — the substring false positives.
    expect(detectCitation("Send me a message about it.", { brand: "SG" }).cited).toBe(false);
    expect(
      detectCitation("We need more space here.", { brand: "Brandy", aliases: ["Ace"] }).cited,
    ).toBe(false);
  });

  it("still matches a short brand standing as its own word", () => {
    const r = detectCitation("I'd go with SG for the glass.", { brand: "SG" });
    expect(r.cited).toBe(true);
    expect(r.matchedOn).toBe("brand");
  });

  it("matches a domain as a substring even when hyphen-joined in a URL path", () => {
    const r = detectCitation("see https://sgglass.com/quote", { brand: "SG Glass", domain: "sgglass.com" });
    expect(r.cited).toBe(true);
    expect(r.matchedOn).toBe("domain");
  });
});
