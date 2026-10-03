import { isValidEmail, networkError, normalizeCallingCode, toBookingError, type BookingError } from "./requests.js";
import type {
  BookingConfig,
  BookRequest,
  BookResponse,
  CancelRequest,
  HoldRequest,
  HoldResponse,
  ManageResponse,
  Medium,
  PublicBooking,
  PublicBookingType,
  RescheduleRequest,
  SlotsResponse,
} from "./types.js";

/**
 * The whole client side of the wire contract in one place.
 *
 * Every method RETURNS its failure instead of throwing — a booking widget that
 * crashes the marketing page it sits on has inverted its job — and checks the
 * shape of what came back, so a proxy's HTML error page or a half-deployed
 * server degrades to an error message rather than a TypeError mid-render.
 *
 * The optional client key rides in `x-adminigloo-key`, the header every
 * AdminIgloo widget uses for keyed cross-origin embeds. GETs without a key send
 * no custom headers at all, so a same-origin or keyless embed never pays for a
 * CORS preflight on the hot path (config + slots on every page view).
 */

export const CLIENT_KEY_HEADER = "x-adminigloo-key";

export type Result<T> = { ok: true; data: T } | { ok: false; error: BookingError };

/**
 * All the time picker needs: a list of open times for a type and window.
 * `BookingClient` is one (the public route); the admin's "Move call" panel
 * wraps its adapter as another, so the host moves a call with the very same
 * picker the invitee uses — not a second, drifting copy of it.
 */
export interface SlotSource {
  slots(input: { type: string; from: string; to: string; manage?: string }): Promise<Result<SlotsResponse>>;
}

export interface BookingClientOptions {
  /** The mounted handlers' base, e.g. "/api/booking" or "https://example.com/api/booking". */
  baseUrl: string;
  /** Sent as `x-adminigloo-key` when set. */
  clientKey?: string;
  /** For tests and unusual runtimes; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** `base` + `path` with exactly one slash between them. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The manage routes carry the token in the PATH, per the contract. */
function managePath(token: string, suffix = ""): string {
  return `/v1/manage/${encodeURIComponent(token)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Shape checks — narrow, and only what the widget reads
// ---------------------------------------------------------------------------

const MEDIA = new Set<Medium>(["video", "phone", "prospect_hosted"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): value is string {
  return typeof value === "string";
}

/** A whole number ≥ `min`, or undefined — a newer field an older server leaves out. */
function wholeAtLeast(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : undefined;
}

function parseType(raw: unknown): PublicBookingType | null {
  if (!isObject(raw) || !str(raw.key) || !str(raw.name)) return null;
  const media = Array.isArray(raw.media) ? raw.media.filter((m): m is Medium => MEDIA.has(m as Medium)) : [];
  const minNoticeMinutes = wholeAtLeast(raw.minNoticeMinutes, 0);
  const horizonDays = wholeAtLeast(raw.horizonDays, 1);
  return {
    key: raw.key,
    name: raw.name,
    description: str(raw.description) ? raw.description : null,
    durationMinutes: typeof raw.durationMinutes === "number" ? raw.durationMinutes : 0,
    media,
    ...(minNoticeMinutes !== undefined ? { minNoticeMinutes } : {}),
    ...(horizonDays !== undefined ? { horizonDays } : {}),
  };
}

export function parseConfig(body: unknown): BookingConfig | null {
  if (!isObject(body) || !Array.isArray(body.types)) return null;
  const defaultCallingCode = normalizeCallingCode(body.defaultCallingCode);
  // Only an explicit boolean counts: anything else is "not said", which
  // keeps an older server's behaviour (emails on).
  const emailsEnabled = typeof body.emailsEnabled === "boolean" ? body.emailsEnabled : undefined;
  // A contact address is printed as a mailto: link, so only a plausible
  // address survives; a malformed one reads as "none".
  const contactEmail =
    "contactEmail" in body ? (str(body.contactEmail) && isValidEmail(body.contactEmail) ? body.contactEmail.trim() : null) : undefined;
  return {
    sandbox: body.sandbox === true,
    hostDisplayName: str(body.hostDisplayName) ? body.hostDisplayName : "",
    hostTimezone: str(body.hostTimezone) ? body.hostTimezone : "UTC",
    types: body.types.map(parseType).filter((t): t is PublicBookingType => t !== null),
    ...(defaultCallingCode ? { defaultCallingCode } : {}),
    ...(emailsEnabled !== undefined ? { emailsEnabled } : {}),
    ...(contactEmail !== undefined ? { contactEmail } : {}),
  };
}

export function parseSlots(body: unknown): SlotsResponse | null {
  if (!isObject(body) || !Array.isArray(body.slots)) return null;
  const slots = body.slots.filter(
    (slot): slot is { start: string; end: string } => isObject(slot) && str(slot.start) && str(slot.end),
  );
  const busySync = body.busySync === "ok" || body.busySync === "degraded" ? body.busySync : "off";
  return { slots: slots.map(({ start, end }) => ({ start, end })), busySync };
}

function parseHold(body: unknown): HoldResponse | null {
  if (!isObject(body) || !str(body.holdToken) || !str(body.expiresAt) || !str(body.start)) return null;
  return {
    holdToken: body.holdToken,
    expiresAt: body.expiresAt,
    start: body.start,
    end: str(body.end) ? body.end : body.start,
  };
}

export function parseBooking(raw: unknown): PublicBooking | null {
  if (!isObject(raw) || !str(raw.status) || !str(raw.start) || !str(raw.end)) return null;
  const nullableStr = (value: unknown) => (str(value) && value ? value : null);
  return {
    status: raw.status as PublicBooking["status"],
    start: raw.start,
    end: raw.end,
    typeName: str(raw.typeName) ? raw.typeName : "Call",
    // Kept even when "" — that means "the server has no such type any more",
    // which is different from a server too old to send the field at all.
    ...(str(raw.typeKey) ? { typeKey: raw.typeKey } : {}),
    durationMinutes:
      typeof raw.durationMinutes === "number"
        ? raw.durationMinutes
        : Math.round((Date.parse(raw.end) - Date.parse(raw.start)) / 60_000),
    hostDisplayName: str(raw.hostDisplayName) ? raw.hostDisplayName : "",
    hostTimezone: str(raw.hostTimezone) ? raw.hostTimezone : "UTC",
    inviteeName: str(raw.inviteeName) ? raw.inviteeName : "",
    inviteeTimezone: str(raw.inviteeTimezone) ? raw.inviteeTimezone : "UTC",
    medium: MEDIA.has(raw.medium as Medium) ? (raw.medium as Medium) : "video",
    meetingLink: nullableStr(raw.meetingLink),
    hostPhone: nullableStr(raw.hostPhone),
    inviteMailbox: nullableStr(raw.inviteMailbox),
    googleCalendarUrl: str(raw.googleCalendarUrl) ? raw.googleCalendarUrl : "",
    canCancel: raw.canCancel === true,
    canReschedule: raw.canReschedule === true,
    sandbox: raw.sandbox === true,
  };
}

function parseManage(body: unknown): ManageResponse | null {
  const booking = isObject(body) ? parseBooking(body.booking) : null;
  return booking ? { booking } : null;
}

function parseBook(body: unknown): BookResponse | null {
  if (!isObject(body) || !str(body.manageToken)) return null;
  const booking = parseBooking(body.booking);
  if (!booking) return null;
  return { booking, manageToken: body.manageToken, manageUrl: str(body.manageUrl) ? body.manageUrl : "" };
}

/**
 * The type a booking was made for, as the slots route wants it (a key).
 *
 * A current server sends `typeKey` on the booking, and then it is the whole
 * answer: offered in the config → that key; not offered (the type was
 * retired, or "" because it is gone) → null, and the manage page says the
 * booking can't be moved online. Guessing by name there could offer times of
 * a DIFFERENT type that happens to share the name — which the server would
 * then refuse to move into.
 *
 * Only a server too old to send `typeKey` gets the fallback: match name and
 * duration, then name alone, then the only type when there is just one.
 */
export function resolveBookingTypeKey(booking: PublicBooking, types: readonly PublicBookingType[]): string | null {
  if (typeof booking.typeKey === "string") {
    const sent = booking.typeKey;
    return sent && types.some((type) => type.key === sent) ? sent : null;
  }
  const exact = types.find((type) => type.name === booking.typeName && type.durationMinutes === booking.durationMinutes);
  if (exact) return exact.key;
  const byName = types.find((type) => type.name === booking.typeName);
  if (byName) return byName.key;
  return types.length === 1 ? types[0]!.key : null;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class BookingClient {
  readonly baseUrl: string;
  readonly clientKey: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: BookingClientOptions) {
    this.baseUrl = options.baseUrl;
    this.clientKey = options.clientKey || undefined;
    this.fetchImpl = options.fetchImpl;
  }

  url(path: string): string {
    return joinUrl(this.baseUrl, path);
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers["content-type"] = "application/json";
    if (this.clientKey) headers[CLIENT_KEY_HEADER] = this.clientKey;
    return headers;
  }

  private getFetch(): typeof fetch | undefined {
    if (this.fetchImpl) return this.fetchImpl;
    return typeof fetch === "function" ? fetch : undefined;
  }

  private async request<T>(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
    parse: (body: unknown) => T | null,
  ): Promise<Result<T>> {
    const doFetch = this.getFetch();
    if (!doFetch) return { ok: false, error: networkError("fetch is not available") };
    let res: Response;
    try {
      res = await doFetch(this.url(path), {
        method: init.method,
        headers: this.headers(init.body !== undefined),
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        // Slots and bookings change by the second; a cached copy offers a
        // time that is already gone.
        cache: "no-store",
      });
    } catch {
      return { ok: false, error: networkError() };
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: toBookingError(res.status, body) };
    const data = parse(body);
    if (data === null) {
      return { ok: false, error: { code: "server", message: "unexpected response", status: res.status, issues: [] } };
    }
    return { ok: true, data };
  }

  config(): Promise<Result<BookingConfig>> {
    return this.request("/v1/config", { method: "GET" }, parseConfig);
  }

  /**
   * Open times. `manage` is the invitee's manage token on a reschedule: the
   * server then leaves their own booking out of busy, so times next to it are
   * offered. Only sent when given — the hot path (config + slots on every
   * page view) never carries a token.
   */
  slots(input: { type: string; from: string; to: string; manage?: string }): Promise<Result<SlotsResponse>> {
    const query = new URLSearchParams({ type: input.type, from: input.from, to: input.to });
    if (input.manage) query.set("manage", input.manage);
    return this.request(`/v1/slots?${query.toString()}`, { method: "GET" }, parseSlots);
  }

  hold(input: HoldRequest): Promise<Result<HoldResponse>> {
    return this.request("/v1/hold", { method: "POST", body: input }, parseHold);
  }

  /**
   * Hand a hold back. Best-effort by design: a release that never arrives just
   * means the hold lapses on its own after ten minutes, so nothing waits on it
   * and nothing reports its failure.
   *
   * `fetch` with `keepalive` first — it survives the page unloading AND carries
   * the client key and a JSON content type. `sendBeacon` is the fallback for a
   * runtime whose fetch refuses keepalive; it cannot set headers, so it sends
   * the JSON as text/plain (a CORS-safelisted type: no preflight to lose during
   * unload) and will only land on servers that read the body regardless of its
   * declared type and do not require the key on this route.
   */
  release(holdToken: string): void {
    const url = this.url("/v1/hold/release");
    const body = JSON.stringify({ holdToken });
    const doFetch = this.getFetch();
    if (doFetch) {
      try {
        void doFetch(url, { method: "POST", headers: this.headers(true), body, keepalive: true }).catch(() => {});
        return;
      } catch {
        /* fall through to the beacon */
      }
    }
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(url, new Blob([body], { type: "text/plain;charset=UTF-8" }));
      }
    } catch {
      /* the hold expires by itself */
    }
  }

  /**
   * Release a hold and WAIT for the answer — for the one caller that must know
   * the hold is gone before its next request (the reschedule retry).
   */
  releaseHold(holdToken: string): Promise<Result<{ ok: true }>> {
    return this.request("/v1/hold/release", { method: "POST", body: { holdToken } }, () => ({ ok: true as const }));
  }

  book(input: BookRequest): Promise<Result<BookResponse>> {
    return this.request("/v1/book", { method: "POST", body: input }, parseBook);
  }

  getBooking(token: string): Promise<Result<ManageResponse>> {
    return this.request(managePath(token), { method: "GET" }, parseManage);
  }

  cancel(token: string, input: CancelRequest): Promise<Result<ManageResponse>> {
    return this.request(managePath(token, "/cancel"), { method: "POST", body: input }, parseManage);
  }

  reschedule(token: string, input: RescheduleRequest): Promise<Result<ManageResponse>> {
    return this.request(managePath(token, "/reschedule"), { method: "POST", body: input }, parseManage);
  }

  /** The .ics download link for a booking. */
  icsUrl(token: string): string {
    return this.url(managePath(token, "/ics"));
  }

  /**
   * A plain link cannot carry the client key, so a keyed embed downloads the
   * .ics through fetch and hands the browser a blob. False when that failed;
   * the caller then lets the plain link try.
   */
  async downloadIcs(token: string, filename = "booking.ics"): Promise<boolean> {
    const doFetch = this.getFetch();
    if (!doFetch || typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
    try {
      const res = await doFetch(this.icsUrl(token), { headers: this.headers(false), cache: "no-store" });
      if (!res.ok) return false;
      const blob = await res.blob();
      const href = URL.createObjectURL(new Blob([blob], { type: "text/calendar;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = filename;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      return true;
    } catch {
      return false;
    }
  }
}
