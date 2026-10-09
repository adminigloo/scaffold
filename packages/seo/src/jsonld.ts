import { SeoError } from "./errors.js";

/**
 * JSON-LD in, one safe string out.
 *
 * Every node the builders make carries a stable `@id`, and `graph()` puts a
 * page's nodes into ONE `@graph` that links by `@id` (the WebPage is part of
 * the WebSite, published by the Organization, with its BreadcrumbList), where
 * trailcards emitted unlinked blocks and two unrelated TouristAttraction nodes
 * for one trail.
 *
 * `serializeJsonLd` escapes `<` as `\u003c` (and `>`, `&`, U+2028, U+2029),
 * so a value containing `</script>` (a photo caption, a review, a puzzle
 * name) can never close the script element. All three codebases wrote plain
 * `JSON.stringify` into the page.
 */

export const SCHEMA_CONTEXT = "https://schema.org";

/** A reference to a node by its `@id`. */
export interface Ref {
  "@id": string;
}

/** A schema.org node as the builders return it: always typed, always identified. */
export interface JsonLdNode {
  "@type": string | readonly string[];
  "@id": string;
  [property: string]: unknown;
}

export interface JsonLdGraph {
  "@context": typeof SCHEMA_CONTEXT;
  "@graph": JsonLdNode[];
}

export type JsonLdDocument = JsonLdGraph | ({ "@context": typeof SCHEMA_CONTEXT } & JsonLdNode);

/** Anything `serializeJsonLd` and `<JsonLd/>` accept. */
export type JsonLdInput = JsonLdDocument | JsonLdNode | readonly JsonLdNode[] | Record<string, unknown>;

type Nodeish = JsonLdNode | null | undefined | false;

/** `{ "@id": … }` for a node, or for an @id you already know. */
export function ref(target: JsonLdNode | Ref | string): Ref {
  return { "@id": typeof target === "string" ? target : target["@id"] };
}

/**
 * One `@graph` for a page. Skips `null`/`undefined`/`false` (so a node can be
 * conditional inline), flattens arrays, drops an exact duplicate of a node
 * already present, and throws when two DIFFERENT nodes claim one `@id`: two
 * Products on /pricing need their own `id`, and silently keeping one would
 * hide a plan.
 *
 * It also throws when two page nodes (a WebPage or any subtype, FAQPage
 * included) describe one URL: that is two FAQPage nodes (Google reports the
 * duplicate) or two competing "pages" for one address. An FAQ on a page with
 * a `webPage()` node goes in `webPage({ faq })`.
 */
export function graph(...nodes: Array<Nodeish | readonly Nodeish[]>): JsonLdGraph {
  const out: JsonLdNode[] = [];
  const byId = new Map<string, string>();
  const pageByUrl = new Map<string, string>();
  for (const node of nodes.flat() as Nodeish[]) {
    if (!node) continue;
    const id = node["@id"];
    if (typeof id !== "string" || id === "") {
      throw new SeoError("invalid_input", "graph", [`a ${String(node["@type"])} node has no @id; build nodes with the package's builders`]);
    }
    const body = JSON.stringify(node);
    const previous = byId.get(id);
    if (previous !== undefined) {
      if (previous === body) continue;
      throw new SeoError("invalid_input", "graph", [`two different nodes share the @id ${id}; pass a distinct \`id\` to one of them`]);
    }
    const types = typeof node["@type"] === "string" ? [node["@type"]] : [...node["@type"]];
    if (typeof node.url === "string" && types.some((type) => PAGE_TYPES.has(type))) {
      const other = pageByUrl.get(node.url);
      if (other !== undefined) {
        throw new SeoError("invalid_input", "graph", [
          `two page nodes (${other} and ${id}) describe ${node.url}; a page has one node: put an FAQ in webPage({ faq }) rather than beside it`,
        ]);
      }
      pageByUrl.set(node.url, id);
    }
    byId.set(id, body);
    out.push(node);
  }
  return { "@context": SCHEMA_CONTEXT, "@graph": out };
}

/** WebPage and its schema.org subtypes: one per URL in a graph. */
const PAGE_TYPES = new Set([
  "WebPage",
  "AboutPage",
  "CheckoutPage",
  "CollectionPage",
  "ContactPage",
  "FAQPage",
  "ItemPage",
  "MedicalWebPage",
  "ProfilePage",
  "QAPage",
  "RealEstateListing",
  "SearchResultsPage",
]);

/**
 * The `@id` references in one page's JSON-LD that no node in it defines,
 * sorted. Pass every block the page renders (the layout's graph AND the
 * page's): a reference into the layout's block resolves, a reference to a
 * `person()` node nobody rendered does not, and leaves the author without a
 * name. For a test of each page template: `expect(unresolvedRefs(layout,
 * page)).toEqual([])`.
 */
export function unresolvedRefs(...documents: ReadonlyArray<JsonLdInput | null | undefined | false>): string[] {
  const defined = new Set<string>();
  const referenced = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (typeof record["@id"] === "string") {
      if (keys.length === 1) referenced.add(record["@id"]);
      else defined.add(record["@id"]);
    }
    for (const [key, entry] of Object.entries(record)) if (key !== "@id") walk(entry);
  };
  for (const document of documents) if (document) walk(document);
  return [...referenced].filter((id) => !defined.has(id)).sort();
}

/** A single node as its own document (with `@context`), when a graph is not wanted. */
export function jsonLd(node: JsonLdNode): { "@context": typeof SCHEMA_CONTEXT } & JsonLdNode {
  return { "@context": SCHEMA_CONTEXT, ...node };
}

const ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * JSON for the inside of `<script type="application/ld+json">`. Escapes the
 * five characters that can end the element or break a script context; the
 * result parses back with `JSON.parse` to exactly the input.
 */
export function serializeJsonLd(data: JsonLdInput): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch (error) {
    throw new SeoError("invalid_input", "serializeJsonLd", [`not serializable: ${(error as Error).message}`]);
  }
  if (json === undefined) throw new SeoError("invalid_input", "serializeJsonLd", ["nothing to serialize"]);
  return json.replace(/[<>&\u2028\u2029]/g, (char) => ESCAPES[char]!);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The whole `<script>` element as HTML, for a route handler or any non-React renderer. */
export function jsonLdScript(data: JsonLdInput, options: { id?: string; nonce?: string } = {}): string {
  const attributes = [
    'type="application/ld+json"',
    ...(options.id ? [`id="${escapeAttribute(options.id)}"`] : []),
    ...(options.nonce ? [`nonce="${escapeAttribute(options.nonce)}"`] : []),
  ].join(" ");
  return `<script ${attributes}>${serializeJsonLd(data)}</script>`;
}

/** Props for a hand-written `<script {...jsonLdScriptProps(data)} />`, escaped. */
export function jsonLdScriptProps(data: JsonLdInput): { type: "application/ld+json"; dangerouslySetInnerHTML: { __html: string } } {
  return { type: "application/ld+json", dangerouslySetInnerHTML: { __html: serializeJsonLd(data) } };
}

/**
 * Build a node from data that may be bad (a row with an empty name, a date
 * that is not one) without letting it fail the page: returns null and
 * reports instead of throwing. `graph()` skips the null. The default report
 * is console.error, so a dropped node is never silent; pass your logger, or
 * `() => {}` where a dropped node is expected and logging it on every render
 * is noise. Data that is merely incomplete has a better answer: an event
 * with no date yet is `event(site, { …, richResult: false })`, a node
 * without the date rather than no node.
 */
export function tryNode<T extends JsonLdNode>(build: () => T, onError: (error: unknown) => void = (error) => console.error(error)): T | null {
  try {
    return build();
  } catch (error) {
    onError(error);
    return null;
  }
}
