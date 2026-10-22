import { escapeHtml } from "./html.js";
import { DigestInputError, type Digests, type EmailPreferences } from "./instance.js";
import type { EmailKind } from "./registry.js";
import { hourLabel, isDay } from "./time.js";

/**
 * THE DIGEST'S HTTP HANDLERS (digest 0.1), mounted by the app under one
 * catch-all (create-app: app/api/email/[...path]/route.ts → /api/email):
 *
 *   POST /v1/unsubscribe?t=…   RFC 8058 one-click (the body
 *                              `List-Unsubscribe=One-Click`, from Gmail,
 *                              Yahoo or a mail app), and the unsubscribe
 *                              page's own form (`from=page`, answered with a
 *                              303 back to the page). No sign-in: the signed
 *                              token says whose and which. Never refused for
 *                              coming from another site — a mailbox provider
 *                              posts it from its own servers.
 *   GET  /v1/unsubscribe?t=…   a header link opened in a browser: 303 to the
 *                              page, which asks first (a GET never
 *                              unsubscribes — link scanners open every link)
 *   GET  /v1/preferences       the signed-in person's choices, and what's on offer
 *   PUT  /v1/preferences       save them (same site only)
 *   GET  /v1/preview?person=…&digest=…&day=YYYY-MM-DD
 *                              STAFF ONLY: one person's digest for one day,
 *                              built and rendered exactly as it would go, and
 *                              never sent (`format=json` for the parts)
 */

export interface CreateDigestHandlersOptions {
  readonly digests: Digests;
  /** The person signed in on this request, or null. */
  readonly person: (req: Request) => Promise<string | null>;
  /** May this request preview anybody's digest? "signed-out" when nobody is signed in. */
  readonly staff: (req: Request) => Promise<boolean | "signed-out">;
  /** The unsubscribe page. Default "/unsubscribe". */
  readonly unsubscribePage?: string;
  readonly onError?: (error: unknown, context: { readonly route: string }) => void;
}

/** The routes, for an app's own tests and docs. */
export const DIGEST_ROUTES = [
  { method: "POST", path: "/v1/unsubscribe", who: "anyone with the link" },
  { method: "GET", path: "/v1/unsubscribe", who: "anyone with the link" },
  { method: "GET", path: "/v1/preferences", who: "the signed-in person" },
  { method: "PUT", path: "/v1/preferences", who: "the signed-in person" },
  { method: "GET", path: "/v1/preview", who: "staff" },
] as const;

/** What the preferences routes answer. */
export interface PreferencesResponse {
  readonly preferences: EmailPreferences;
  readonly kinds: readonly EmailKind[];
  readonly siteTimeZone: string;
}

const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" } });
}

function refuse(status: number, code: string, messageText: string): Response {
  return json({ error: { code, message: messageText } }, status);
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } });
}

/** COPIED FROM @adminigloo/customers' admin-handlers.ts (isCrossSiteRequest); change both or neither. */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    const verdict = site.trim().toLowerCase();
    return !(verdict === "same-origin" || verdict === "none");
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin.trim().toLowerCase() === "null") return true;
  const source = origin ?? req.headers.get("referer");
  if (source) {
    const host = (value: string) => {
      try {
        return new URL(value).host.toLowerCase();
      } catch {
        return null;
      }
    };
    const from = host(source);
    if (!from) return true;
    const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
    return !(from === host(req.url) || (forwarded !== undefined && forwarded !== "" && from === forwarded));
  }
  for (const name of req.headers.keys()) {
    if (name.toLowerCase().startsWith("sec-fetch-")) return true;
  }
  return false;
}

/** The route after the mount: "/api/email/v1/preferences" → "/v1/preferences". */
function routeOf(pathname: string): string | null {
  const at = pathname.indexOf("/v1/");
  return at === -1 ? null : pathname.slice(at).replace(/\/+$/, "");
}

async function formOf(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      const data = await req.formData();
      const out = new URLSearchParams();
      for (const [key, value] of data.entries()) if (typeof value === "string") out.append(key, value);
      return out;
    }
    const body = await req.text();
    return new URLSearchParams(body);
  } catch {
    return new URLSearchParams();
  }
}

function nothingToSend(preview: Awaited<ReturnType<Digests["preview"]>>): string {
  const rows = preview.sections
    .map((section) => `<li><code>${escapeHtml(section.key)}</code>: ${section.error ? `failed (${escapeHtml(section.error)})` : "nothing to say that day"}</li>`)
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Nothing to send</title></head><body style="font:15px/1.5 sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Nothing to send on ${escapeHtml(preview.day)}</h1>
<p>Every section of this digest had nothing to say for this person that day, so no email would go.</p>
<ul>${rows}</ul></body></html>`;
}

export function createDigestHandlers(options: CreateDigestHandlersOptions) {
  const digests = options.digests;
  const page = options.unsubscribePage ?? "/unsubscribe";
  const report = (error: unknown, route: string) => {
    try {
      (options.onError ?? ((e, c) => console.error("digest:", c, e)))(error, { route });
    } catch {
      // never breaks the answer
    }
  };

  function backToPage(req: Request, token: string, done: string): Response {
    const url = new URL(page, req.url);
    url.searchParams.set("t", token);
    url.searchParams.set("done", done);
    return new Response(null, { status: 303, headers: { ...NO_STORE, location: url.toString() } });
  }

  async function unsubscribePost(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const form = await formOf(req);
    const token = url.searchParams.get("t") ?? form.get("t") ?? "";
    const fromPage = form.get("from") === "page";
    const oneClick = form.get("List-Unsubscribe") === "One-Click";
    if (!fromPage && !oneClick) {
      return text("This address takes a one-click unsubscribe (List-Unsubscribe=One-Click) or the unsubscribe page's form.", 400);
    }
    if (fromPage && form.get("action") === "resubscribe") {
      const result = await digests.resubscribe(token);
      return result === null ? backToPage(req, token, "invalid") : backToPage(req, token, "resubscribed");
    }
    const result = await digests.unsubscribe(token, fromPage ? "link" : "one-click");
    if (result === null) return fromPage ? backToPage(req, token, "invalid") : text("That unsubscribe link isn't valid.", 400);
    if (fromPage) return backToPage(req, token, "unsubscribed");
    return text(`Unsubscribed from ${result.kind.type === "digest" ? `the ${result.kind.title}` : result.kind.title}.`);
  }

  async function preferencesGet(req: Request): Promise<Response> {
    const userId = await options.person(req);
    if (!userId) return refuse(401, "signed_out", "Sign in to choose your emails.");
    const body: PreferencesResponse = { preferences: await digests.preferencesOf(userId), kinds: digests.kinds.offered, siteTimeZone: digests.siteTimeZone };
    return json(body);
  }

  async function preferencesPut(req: Request): Promise<Response> {
    if (isCrossSiteRequest(req)) return refuse(403, "cross_site", "That came from another site, so nothing was changed.");
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) return refuse(415, "json_only", "Send the choices as JSON.");
    const userId = await options.person(req);
    if (!userId) return refuse(401, "signed_out", "Sign in to choose your emails.");
    let input: unknown;
    try {
      input = await req.json();
    } catch {
      return refuse(400, "bad_json", "That couldn't be read.");
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) return refuse(400, "bad_input", "Send an object of choices.");
    const body = input as { timeZone?: unknown; deliveryHour?: unknown; choices?: unknown };
    try {
      const preferences = await digests.savePreferences(userId, {
        ...(body.timeZone !== undefined ? { timeZone: body.timeZone as string | null } : {}),
        ...(body.deliveryHour !== undefined ? { deliveryHour: body.deliveryHour as number } : {}),
        ...(body.choices !== undefined ? { choices: body.choices as Record<string, boolean> } : {}),
      });
      const answer: PreferencesResponse = { preferences, kinds: digests.kinds.offered, siteTimeZone: digests.siteTimeZone };
      return json(answer);
    } catch (error) {
      if (error instanceof DigestInputError) return refuse(400, "bad_input", error.message);
      throw error;
    }
  }

  async function previewGet(req: Request): Promise<Response> {
    const allowed = await options.staff(req);
    if (allowed === "signed-out") return refuse(401, "signed_out", "Sign in to preview emails.");
    if (!allowed) return refuse(403, "forbidden", "You can't preview other people's emails.");
    const url = new URL(req.url);
    const userId = url.searchParams.get("person") ?? "";
    const digest = url.searchParams.get("digest") ?? digests.kinds.offered.find((kind) => kind.type === "digest")?.key ?? "";
    const day = url.searchParams.get("day") ?? undefined;
    if (!userId) return refuse(400, "bad_input", "Say whose digest: ?person={their id}.");
    if (day !== undefined && !isDay(day)) return refuse(400, "bad_input", "Say the day as YYYY-MM-DD.");
    try {
      const preview = await digests.preview({ userId, digest, ...(day ? { day } : {}) });
      if (url.searchParams.get("format") === "json") {
        return json({ ...preview, deliveryHourLabel: hourLabel(preview.deliveryHour) });
      }
      return new Response(preview.email?.html ?? nothingToSend(preview), {
        headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      if (error instanceof DigestInputError) return refuse(400, "bad_input", error.message);
      throw error;
    }
  }

  async function handle(req: Request): Promise<Response> {
    const route = routeOf(new URL(req.url).pathname);
    try {
      if (route === "/v1/unsubscribe" && req.method === "POST") return await unsubscribePost(req);
      if (route === "/v1/unsubscribe" && req.method === "GET") {
        const token = new URL(req.url).searchParams.get("t") ?? "";
        const url = new URL(page, req.url);
        url.searchParams.set("t", token);
        return new Response(null, { status: 303, headers: { ...NO_STORE, location: url.toString() } });
      }
      if (route === "/v1/preferences" && req.method === "GET") return await preferencesGet(req);
      if (route === "/v1/preferences" && req.method === "PUT") return await preferencesPut(req);
      if (route === "/v1/preview" && req.method === "GET") return await previewGet(req);
      return refuse(404, "not_found", "That isn't here.");
    } catch (error) {
      report(error, route ?? "unknown");
      return refuse(500, "internal", "Something went wrong. Please try again.");
    }
  }

  return { handle };
}

export type DigestHandlers = ReturnType<typeof createDigestHandlers>;
