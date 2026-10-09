import type { ReactElement } from "react";
import { serializeJsonLd, type JsonLdInput } from "./jsonld.js";

/**
 * `<JsonLd data={graph(...)} />`: one `<script type="application/ld+json">`
 * with the payload escaped by `serializeJsonLd`, so `</script>` inside a
 * value cannot close the element.
 *
 * Server-safe: no hooks, no state, no "use client". It renders in a Server
 * Component (where it belongs: structured data must be in the server HTML)
 * and in a client component alike.
 */
export interface JsonLdProps {
  data: JsonLdInput;
  /** An element id, e.g. to find the block in a test. */
  id?: string;
  /** A CSP nonce, if your policy wants one on every script element. */
  nonce?: string;
}

export function JsonLd({ data, id, nonce }: JsonLdProps): ReactElement {
  return <script type="application/ld+json" id={id} nonce={nonce} dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
