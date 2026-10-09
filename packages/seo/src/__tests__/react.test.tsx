import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { graph, organization, webPage } from "../index.js";
import { JsonLd } from "../react.js";
import { site } from "./fixtures.js";

const ATTACK = '</script><script>alert("pwned")</script>';

function scripts(html: string): string[] {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

describe("<JsonLd/>", () => {
  it("renders one ld+json script whose text parses back to the graph", () => {
    const data = graph(organization(site), webPage(site, { path: "/pricing", name: "Pricing" }));
    const html = renderToStaticMarkup(<JsonLd data={data} id="ld-page" />);
    expect(html.startsWith('<script type="application/ld+json" id="ld-page">')).toBe(true);
    expect(scripts(html)).toHaveLength(1);
    expect(JSON.parse(scripts(html)[0]!)).toEqual(data);
  });

  it("keeps a </script> payload inside the element", () => {
    const data = graph(organization(site, { name: ATTACK, description: ATTACK }));
    const html = renderToStaticMarkup(<JsonLd data={data} />);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(scripts(html)[0]!)).toEqual(data);
  });

  it("passes a CSP nonce through", () => {
    expect(renderToStaticMarkup(<JsonLd data={{ a: 1 }} nonce="abc" />)).toBe('<script type="application/ld+json" nonce="abc">{"a":1}</script>');
  });

  it("is server-safe: no hooks and no 'use client' directive", () => {
    const source = readFileSync(fileURLToPath(new URL("../react.tsx", import.meta.url)), "utf8");
    expect(source.trimStart()).not.toMatch(/^["']use client["']/);
    expect(source).not.toMatch(/\buse(State|Effect|LayoutEffect|Ref|Context|Memo|Callback)\b/);
  });
});
