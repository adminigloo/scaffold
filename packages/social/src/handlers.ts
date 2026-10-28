import { composeUrl, PLATFORMS } from "./platforms.js";
import type { SocialPermission } from "./permissions.js";
import { SOCIAL_ADMIN_ROUTE_PERMISSIONS, type SocialAdminRouteKind } from "./routes.js";
import type { SocialPostTable } from "./schema.js";
import { LAUNCH_FACTS_MAX, parseHashtags } from "./sources.js";
import { isWebAddress, postStore, type QueuedPost, type SocialDb } from "./store.js";
import type { PostSource } from "./types.js";
import { postView } from "./view.js";
import type { CardFormatSet, ComposeWire, PostingSessionWire, QueueWire } from "./wire.js";
import { writePost, type WriterOptions } from "./writer.js";

/**
 * THE POSTS SCREEN'S HANDLER (social 0.1), mounted by the app at
 * /api/app/{company id}/posts (a company's) or /api/admin/posts (the site's
 * own, or one business's). Every route asks `authorize(req, permission,
 * tenantId)` for its one key (SOCIAL_ADMIN_ROUTE_PERMISSIONS: social.view to
 * look, social.manage to change). A post named in the path is read INSIDE
 * the company the request resolved to: another company's is "not found",
 * exactly like one that doesn't exist; ids in a body (approve's) only ever
 * match the company's own. POSTs from another site are refused. No CORS.
 *
 * NOTHING HERE POSTS ANYTHING. The app builds drafts, a person approves
 * them, and a person (or an agent in their browser) posts them by hand and
 * marks each posted with its link. No platform's API is called, ever.
 */

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

class HttpRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const NOT_HERE = "That isn't here.";
const INTERNAL = "Something went wrong. Please try again.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" } });
}

function failure(error: unknown): Response {
  if (error instanceof HttpRefusal) return json({ error: { code: error.code, message: error.message } }, error.status);
  return json({ error: { code: "internal", message: INTERNAL } }, 500);
}

/** COPIED FROM @adminigloo/customers' admin-handlers.ts (readBodyCapped): the body, refused once it passes `cap` while it streams. */
async function readBodyCapped(req: Request, cap: number): Promise<Uint8Array> {
  const tooLarge = () => new HttpRefusal("invalid", 413, "That's too much to send at once.");
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\s*\d+\s*$/.test(declared) && Number(declared) > cap) throw tooLarge();
  const body = req.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** A JSON body, at most `cap` bytes. */
async function readJson(req: Request, cap = 16 * 1024): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await readBodyCapped(req, cap));
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpRefusal("invalid", 400, "Expected a JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpRefusal("invalid", 400, "Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function segmentsAfter(pathname: string, marker: string): string[] | null {
  const path = pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = path
    .slice(at + marker.length)
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
  return parts.some((part) => part === "") ? null : parts;
}

function adminRoute(method: string, pathname: string): { kind: SocialAdminRouteKind; id: string | null } | null {
  const parts = segmentsAfter(pathname, "/v1/admin/");
  if (!parts) return null;
  const [a, b, c] = parts;
  const n = parts.length;
  if (method === "GET") {
    if (n === 1 && a === "posts") return { kind: "list", id: null };
    if (n === 1 && a === "approved") return { kind: "approved", id: null };
    if (n === 1 && a === "card-formats") return { kind: "card-formats", id: null };
    return null;
  }
  if (method !== "POST") return null;
  if (n === 1 && a === "compose") return { kind: "compose", id: null };
  if (n === 1 && a === "approve") return { kind: "approve", id: null };
  if (n === 2 && a === "posts") return { kind: "edit", id: b! };
  if (n === 3 && a === "posts" && c === "posted") return { kind: "posted", id: b! };
  if (n === 3 && a === "posts" && c === "skip") return { kind: "skip", id: b! };
  return null;
}

/** Where the handler is mounted, from a request to it: everything before "/v1/admin/". */
function mountOf(req: Request): string {
  const path = new URL(req.url).pathname;
  const at = path.lastIndexOf("/v1/admin/");
  return at < 0 ? path : path.slice(0, at);
}

/** Today in a time zone, as YYYY-MM-DD (UTC for a zone this runtime doesn't know). */
export function dayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export type SocialAuthorizeResult = boolean | { userId?: string | number | null } | Response;

/** What a person composed, as the handler hands it to the app's `compose`. */
export interface ComposeRequest {
  readonly tenantId: string;
  readonly userId: string | null;
  /** The facts as typed, whitespace tidied: 1 to 1,200 characters. */
  readonly facts: string;
  /** The page it points to, checked to be a web address; null: the app's default. */
  readonly link: string | null;
  /** Five at most, each "#word". */
  readonly hashtags: readonly string[];
  /** The post's key, new for every compose: "launch:<time><random>". */
  readonly key: string;
  /** Today in the business's own time zone. */
  readonly day: string;
  readonly now: Date;
}

export interface CreateSocialAdminHandlersOptions {
  readonly db: SocialDb;
  /** The table, when the app named its own (`defineSocialTables({ prefix })`). */
  readonly table?: SocialPostTable;
  /** A fixed company (the site's own "*", or one business). Pass this or `resolveTenant`. */
  readonly tenantId?: string;
  readonly resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  readonly authorize: (req: Request, permission: SocialPermission, tenantId: string) => SocialAuthorizeResult | Promise<SocialAuthorizeResult>;
  /** The post a person's facts become: the app's author, voice, platforms, link default and images (`launchSource` does most of it). */
  readonly compose: (input: ComposeRequest) => PostSource | Promise<PostSource>;
  /** How the AI writes for this company: its metered `complete` (or null for none), its honesty check, the mode. */
  readonly writer: (ctx: { readonly tenantId: string; readonly userId: string | null }) => WriterOptions | Promise<WriterOptions>;
  /** Every card format, as samples in the company's own brand, for "See every card format". None: an empty list. */
  readonly cardFormats?: (tenantId: string) => readonly CardFormatSet[] | Promise<readonly CardFormatSet[]>;
  /** Today for the company (YYYY-MM-DD), in its own time zone. Default UTC. */
  readonly today?: (tenantId: string, now: Date) => string | Promise<string>;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
}

/** A compose key nobody can guess or repeat by accident: the time, then a little randomness. */
function composeKey(now: Date): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(36).padStart(2, "0")).join("");
  return `launch:${now.getTime().toString(36)}${random}`;
}

export function createSocialAdminHandlers(options: CreateSocialAdminHandlersOptions): { handle: (req: Request) => Promise<Response> } {
  if (!options.tenantId && !options.resolveTenant) throw new Error("createSocialAdminHandlers: pass tenantId or resolveTenant");
  if (typeof options.authorize !== "function") throw new Error("createSocialAdminHandlers: pass authorize (your permission check)");
  if (typeof options.compose !== "function" || typeof options.writer !== "function") throw new Error("createSocialAdminHandlers: pass compose and writer");
  const report = (error: unknown, tenantId: string | null, route: string) => {
    try {
      options.onError?.(error, { tenantId, route });
    } catch {
      /* never let a reporter break an answer */
    }
  };
  const clock = options.now ?? (() => new Date());
  const notFound = () => new HttpRefusal("not_found", 404, NOT_HERE);

  async function handle(req: Request): Promise<Response> {
    const matched = adminRoute(req.method, new URL(req.url).pathname);
    if (!matched) return failure(notFound());
    if (req.method === "POST" && isCrossSiteRequest(req)) return failure(new HttpRefusal("cross_site", 403, "This request came from another site, so it was refused."));
    let tenantId: string | null = null;
    try {
      tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return failure(notFound());
      const verdict = await options.authorize(req, SOCIAL_ADMIN_ROUTE_PERMISSIONS[matched.kind], tenantId);
      if (verdict instanceof Response) return verdict;
      if (!verdict) return failure(new HttpRefusal("forbidden", 403, "You don't have permission to do that."));
      const userId = typeof verdict === "object" && verdict.userId !== undefined && verdict.userId !== null ? String(verdict.userId) : null;
      const scoped: string = tenantId;
      const queue = postStore(options.db, { tenantId: scoped, ...(options.table ? { table: options.table } : {}) });
      const now = clock();
      const today = async () => (options.today ? await options.today(scoped, now) : dayIn("UTC", now));
      /** One of this company's posts, or "not found". */
      const own = async (id: string): Promise<QueuedPost> => {
        const post = await queue.get(id);
        if (!post) throw notFound();
        return post;
      };

      switch (matched.kind) {
        case "list": {
          const day = await today();
          const sections = await queue.sections(day);
          const wire: QueueWire = {
            today: day,
            sections: { today: sections.today.map(postView), earlier: sections.earlier.map(postView), ready: sections.ready.map(postView), history: sections.history.map(postView) },
          };
          return json(wire);
        }
        case "compose": {
          const body = await readJson(req);
          const facts = typeof body.facts === "string" ? body.facts.replace(/\s+/g, " ").trim() : "";
          if (!facts) throw new HttpRefusal("invalid", 400, "Write the facts first: a sentence or two.");
          if ([...facts].length > LAUNCH_FACTS_MAX) throw new HttpRefusal("invalid", 400, `Keep the facts under ${LAUNCH_FACTS_MAX.toLocaleString("en-US")} characters.`);
          const linkText = typeof body.link === "string" ? body.link.trim() : "";
          if (linkText && !isWebAddress(linkText)) throw new HttpRefusal("invalid", 400, "The link has to be a web address (https://…).");
          const hashtags = parseHashtags(typeof body.hashtags === "string" ? body.hashtags : "");
          const key = composeKey(now);
          const source = await options.compose({ tenantId: scoped, userId, facts, link: linkText || null, hashtags, key, day: await today(), now });
          const drafts = await writePost(source, await options.writer({ tenantId: scoped, userId }));
          let written = 0;
          let kept = 0;
          for (const draft of drafts) {
            const outcome = await queue.upsertDraft({ ...draft, key: source.key, kind: source.kind, author: source.author, day: source.day, linkUrl: source.linkUrl, facts: source.facts, createdBy: userId });
            if (outcome === "written") written += 1;
            else kept += 1;
          }
          const wire: ComposeWire = { key: source.key, written, kept, note: drafts.find((d) => d.note)?.note ?? null };
          return json(wire, 201);
        }
        case "approve": {
          const body = await readJson(req);
          const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 200) : [];
          if (!ids.length) throw new HttpRefusal("invalid", 400, "Choose the posts to approve.");
          return json({ approved: await queue.approve(ids, userId) });
        }
        case "edit": {
          const post = await own(matched.id ?? "");
          const body = await readJson(req);
          const text = typeof body.text === "string" ? body.text : "";
          const hook = typeof body.hook === "string" ? body.hook : "";
          const firstComment = typeof body.firstComment === "string" ? body.firstComment : null;
          if (!(await queue.edit(post.id, { text, hook, firstComment }))) {
            throw new HttpRefusal("conflict", 409, text.trim() ? "That post can't be edited now: it's been posted or skipped." : "A post needs its text.");
          }
          return json({ post: postView(await own(post.id)) });
        }
        case "posted": {
          const post = await own(matched.id ?? "");
          const body = await readJson(req);
          const url = typeof body.url === "string" ? body.url : "";
          if (!(await queue.markPosted(post.id, url, userId))) {
            throw post.status === "skipped"
              ? new HttpRefusal("conflict", 409, "That post was skipped, so it can't be marked posted.")
              : new HttpRefusal("invalid", 400, "Paste the post's own link (https://…).");
          }
          return json({ post: postView(await own(post.id)) });
        }
        case "skip": {
          const post = await own(matched.id ?? "");
          if (!(await queue.skip(post.id))) throw new HttpRefusal("conflict", 409, "That post has already been posted or skipped.");
          return json({ post: postView(await own(post.id)) });
        }
        case "approved": {
          const rows = await queue.list({ statuses: ["approved"] });
          const wire: PostingSessionWire = {
            posts: rows.map((p) => ({
              id: p.id,
              key: p.key,
              kind: p.kind,
              author: p.author,
              day: p.day,
              platform: p.platform,
              platformName: PLATFORMS[p.platform]?.name ?? p.platform,
              text: p.text,
              hook: p.hook,
              images: p.images,
              firstComment: p.firstComment,
              linkUrl: p.linkUrl,
              composeUrl: PLATFORMS[p.platform] ? composeUrl(p.platform, p.text) : null,
            })),
            markPosted: { method: "POST", url: `${mountOf(req)}/v1/admin/posts/{id}/posted`, body: { url: "<the post's own link>" } },
          };
          return json(wire);
        }
        case "card-formats":
          return json({ sets: options.cardFormats ? await options.cardFormats(scoped) : [] });
      }
    } catch (error) {
      if (!(error instanceof HttpRefusal)) report(error, tenantId, matched.kind);
      return failure(error);
    }
  }

  return { handle };
}
