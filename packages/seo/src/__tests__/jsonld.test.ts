import { describe, expect, it, vi } from "vitest";
import { graph, jsonLd, jsonLdScript, jsonLdScriptProps, organization, ref, serializeJsonLd, SeoError, tryNode, webPage } from "../index.js";
import { site } from "./fixtures.js";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BS = String.fromCharCode(92);
const ATTACK = '</script><script>alert("pwned")</script><!--';

describe("serializeJsonLd: a value can never close the script element", () => {
  it("escapes < > & so a </script> payload stays inside the string, and parses back to exactly the input", () => {
    const data = { "@type": "Thing", "@id": "x", name: ATTACK, description: "Tom & Jerry > Spike" };
    const out = serializeJsonLd(data);
    expect(out).not.toMatch(/[<>&]/);
    expect(out).toContain(`${BS}u003c/script${BS}u003e`);
    expect(out).toContain(`Tom ${BS}u0026 Jerry ${BS}u003e Spike`);
    expect(JSON.parse(out)).toEqual(data);
  });

  it("escapes U+2028 and U+2029, which end a line in a JavaScript context", () => {
    const data = { text: `one${LS}two${PS}three` };
    const out = serializeJsonLd(data);
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
    expect(out).toContain(`one${BS}u2028two${BS}u2029three`);
    expect(JSON.parse(out)).toEqual(data);
  });

  it("escapes a payload that arrives through a builder (a review, a caption, a name)", () => {
    const node = organization(site, { name: ATTACK });
    const html = jsonLdScript(graph(node));
    expect(html.indexOf("</script")).toBe(html.length - "</script>".length);
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("refuses what JSON cannot carry", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeJsonLd(circular)).toThrow(SeoError);
  });
});

describe("script helpers", () => {
  it("jsonLdScript writes one element with escaped attributes", () => {
    expect(jsonLdScript({ a: 1 }, { id: 'ld"x', nonce: "n<1" })).toBe('<script type="application/ld+json" id="ld&quot;x" nonce="n&lt;1">{"a":1}</script>');
  });

  it("jsonLdScriptProps is the escaped string for a hand-written <script>", () => {
    expect(jsonLdScriptProps({ name: "</script>" })).toEqual({
      type: "application/ld+json",
      dangerouslySetInnerHTML: { __html: `{"name":"${BS}u003c/script${BS}u003e"}` },
    });
  });
});

describe("graph", () => {
  const org = organization(site, { logo: "/logo.png" });
  const page = webPage(site, { path: "/pricing", name: "Pricing" });

  it("emits ONE @graph with the schema.org context", () => {
    expect(graph(org, page)).toEqual({ "@context": "https://schema.org", "@graph": [org, page] });
  });

  it("skips null/false/undefined, flattens arrays and drops an exact duplicate", () => {
    expect(graph(null, [org, false, undefined], page, org)["@graph"]).toEqual([org, page]);
  });

  it("throws when two different nodes claim one @id", () => {
    const other = organization(site, { name: "Someone else" });
    expect(() => graph(org, other)).toThrow(/two different nodes share the @id https:\/\/riddlergo.com\/#organization/);
  });

  it("requires an @id on every node", () => {
    expect(() => graph({ "@type": "Thing" } as never)).toThrow(/has no @id/);
  });

  it("ref() points at a node or an id; jsonLd() makes a single-node document", () => {
    expect(ref(org)).toEqual({ "@id": "https://riddlergo.com/#organization" });
    expect(ref("https://x/#y")).toEqual({ "@id": "https://x/#y" });
    expect(jsonLd(org)["@context"]).toBe("https://schema.org");
  });
});

describe("tryNode", () => {
  it("returns the node, or null with a report when the data is incomplete", () => {
    const report = vi.fn();
    expect(tryNode(() => organization(site), report)?.["@type"]).toBe("Organization");
    expect(tryNode(() => webPage(site, { path: "/x", name: "" }), report)).toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(SeoError);
  });
});
