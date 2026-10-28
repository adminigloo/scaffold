import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MAX_LIST_ROWS, type CardBrandWords, type CardSpec } from "./types.js";

/**
 * A CARD IN A URL, SIGNED. The image route draws whatever its query says,
 * so the query carries a signature: HMAC-SHA256, with a key only the server
 * holds, over the canonical query (every parameter but `sig`, sorted by name,
 * each value percent-encoded). Change a word, add a parameter, repeat one:
 * the signature no longer matches and nothing is drawn. Nobody can mint a
 * card with words the business didn't write, or in a company's name the app
 * didn't give it (the brand words are signed with the rest).
 */

const CHARACTER = /^[a-z][a-z0-9-]{0,23}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const line = (max: number) => z.string().trim().min(1).max(max);

const page = z
  .string()
  .regex(/^\d{1,2}\/\d{1,2}$/)
  .transform((s) => {
    const [index, count] = s.split("/").map(Number) as [number, number];
    return { index, count };
  })
  .refine((p) => p.index >= 1 && p.index <= p.count, "a page number from 1 to the count");

const rows = z
  .string()
  .max(2000)
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "rows must be JSON" });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(z.tuple([line(60), z.string().trim().max(80).optional(), z.string().trim().max(24).optional()]))
      .min(1)
      .max(MAX_LIST_ROWS),
  )
  .transform((list) => list.map(([label, detail, value]) => ({ label, ...(detail ? { detail } : {}), ...(value ? { value } : {}) })));

/** Every card may carry its page and its brand's words. */
const base = {
  page: page.optional(),
  brand: line(60).optional(),
  site: line(80).optional(),
  handle: line(40).optional(),
  accent: z.string().regex(HEX).optional(),
  on: z.string().regex(HEX).optional(),
};
const size = z.enum(["square", "portrait", "story"]);

/** What the query may say, per kind of card. Anything else is refused. */
const query = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("quote"), size, text: line(400), date: line(24).optional(), ...base }),
  z.strictObject({ kind: z.literal("cover"), size, text: line(200), eyebrow: line(60).optional(), character: z.string().regex(CHARACTER).optional(), cue: line(24).optional(), ...base }),
  z.strictObject({ kind: z.literal("stat"), size, value: line(24), text: line(200), eyebrow: line(60).optional(), note: line(200).optional(), ...base }),
  z.strictObject({ kind: z.literal("list"), size, text: line(120), rows, eyebrow: line(60).optional(), ranked: z.literal("1").optional(), note: line(200).optional(), ...base }),
  z.strictObject({ kind: z.literal("cta"), size, text: line(60), eyebrow: line(60).optional(), character: z.string().regex(CHARACTER).optional(), note: line(200).optional(), ...base }),
]);

/** A spec as query parameters (unsigned), in a fixed order. */
export function cardParams(spec: CardSpec): URLSearchParams {
  const out: [string, string][] = [
    ["kind", spec.kind],
    ["size", spec.size],
  ];
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== "") out.push([key, value]);
  };
  put("text", spec.text);
  switch (spec.kind) {
    case "quote":
      put("date", spec.date);
      break;
    case "cover":
      put("eyebrow", spec.eyebrow);
      put("character", spec.character);
      put("cue", spec.cue);
      break;
    case "stat":
      put("value", spec.value);
      put("eyebrow", spec.eyebrow);
      put("note", spec.note);
      break;
    case "list":
      put("eyebrow", spec.eyebrow);
      put("rows", JSON.stringify(spec.rows.slice(0, MAX_LIST_ROWS).map((r) => [r.label, r.detail ?? "", r.value ?? ""])));
      if (spec.ranked) put("ranked", "1");
      put("note", spec.note);
      break;
    case "cta":
      put("eyebrow", spec.eyebrow);
      put("character", spec.character);
      put("note", spec.note);
      break;
  }
  if (spec.page) put("page", `${spec.page.index}/${spec.page.count}`);
  if (spec.brand) {
    put("brand", spec.brand.name);
    put("site", spec.brand.site);
    put("handle", spec.brand.handle);
    put("accent", spec.brand.accent);
    put("on", spec.brand.onAccent);
  }
  return new URLSearchParams(out);
}

/** What the signature covers: every parameter but `sig`, sorted by name. Null when a name repeats. */
export function canonicalCardQuery(params: URLSearchParams): string | null {
  const keys = [...params.keys()].filter((k) => k !== "sig");
  if (new Set(keys).size !== keys.length) return null;
  return keys
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params.get(k)!)}`)
    .join("&");
}

function signature(canonical: string, secret: string): string {
  return createHmac("sha256", secret).update(`social-card:v1\n${canonical}`).digest("base64url");
}

/** The parameters with their signature added. */
export function signCardParams(params: URLSearchParams, secret: string): URLSearchParams {
  if (!secret) throw new Error("A card's address needs a signing key.");
  const canonical = canonicalCardQuery(params);
  if (canonical === null) throw new Error("A card's parameters may not repeat.");
  const signed = new URLSearchParams(params);
  signed.delete("sig");
  signed.set("sig", signature(canonical, secret));
  return signed;
}

/** Does the signature match the parameters it came with? */
export function verifyCardParams(params: URLSearchParams, secret: string): boolean {
  if (!secret) return false;
  const given = params.getAll("sig");
  const canonical = canonicalCardQuery(params);
  if (given.length !== 1 || canonical === null) return false;
  const expected = Buffer.from(signature(canonical, secret));
  const actual = Buffer.from(given[0]!);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The spec a (verified) query describes, or what's wrong with it. */
export function parseCardParams(params: URLSearchParams): { ok: true; spec: CardSpec } | { ok: false; error: string } {
  const raw: Record<string, string> = {};
  for (const [k, v] of params) if (k !== "sig") raw[k] = v;
  const parsed = query.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") };
  const { ranked, brand, site, handle, accent, on, ...rest } = parsed.data as typeof parsed.data & { ranked?: "1" };
  if ((brand === undefined) !== (site === undefined)) return { ok: false, error: "brand: a card's brand needs both its name and its site" };
  if ((handle !== undefined || accent !== undefined || on !== undefined) && brand === undefined) return { ok: false, error: "brand: a handle or a colour needs the brand's name and site" };
  const words: CardBrandWords | undefined =
    brand !== undefined && site !== undefined
      ? { name: brand, site, ...(handle !== undefined ? { handle } : {}), ...(accent !== undefined ? { accent: accent.toLowerCase() } : {}), ...(on !== undefined ? { onAccent: on.toLowerCase() } : {}) }
      : undefined;
  return { ok: true, spec: { ...rest, ...(ranked ? { ranked: true } : {}), ...(words ? { brand: words } : {}) } as CardSpec };
}
