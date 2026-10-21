import type {
  AdminBlackout,
  AdminBooking,
  AdminBookingEvent,
  AdminBookingType,
  AdminException,
  AdminHost,
  BookingAdminAdapter,
  TeamList,
  WeeklyWindow,
} from "./types.js";

/**
 * THE ADAPTER OVER @adminigloo/booking's ADMIN ROUTES (0.2) —
 * `createBookingAdminHandlers`, mounted by the app (a companies project:
 * /api/app/{company id}/calls; a single business: /api/admin/calls):
 *
 *   const adapter = useMemo(() => createBookingAdminFetchAdapter({ baseUrl: `/api/app/${id}/calls`, emailsEnabled }), [id]);
 *   <BookingAdmin adapter={adapter} bookingPageUrl={`/t/${slug}/book`} />
 *
 * Same-origin JSON with the session's cookie. A refusal throws with the
 * server's sentence, which the screen shows next to the control that asked.
 */
export interface BookingAdminFetchAdapterOptions {
  /** The admin handlers' mount, without the trailing `/v1`. */
  baseUrl: string;
  /** Whether the server really emails people (the buttons stop promising one when false). */
  emailsEnabled: boolean;
  /** Is the week still the placeholder the app seeded? See BookingAdminAdapter.hoursAreDefault. */
  hoursAreDefault?: BookingAdminAdapter["hoursAreDefault"];
  /** For tests, or an app that wraps fetch. Default: the global fetch. */
  fetch?: typeof fetch;
}

/** A refusal from the admin routes, in the server's words. */
export class BookingAdminRequestError extends Error {
  readonly name = "BookingAdminRequestError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export function createBookingAdminFetchAdapter(options: BookingAdminFetchAdapterOptions): BookingAdminAdapter {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const seg = (value: string) => encodeURIComponent(value);

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}/v1/${path}`, {
        method,
        credentials: "same-origin",
        headers: { accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch {
      throw new BookingAdminRequestError("We couldn't reach the server. Check your connection and try again.", 0, "network");
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const error = (data as { error?: { code?: string; message?: string; issues?: Array<{ message?: string }> } } | null)?.error;
      const detail = error?.issues?.[0]?.message;
      const message =
        res.status === 401
          ? "Your sign-in has ended. Sign in again to carry on."
          : detail && error?.code === "invalid"
            ? detail
            : (error?.message ?? statusWords(res.status));
      throw new BookingAdminRequestError(message, res.status, error?.code ?? "server");
    }
    return data as T;
  }

  return {
    emailsEnabled: options.emailsEnabled,
    ...(options.hoursAreDefault !== undefined ? { hoursAreDefault: options.hoursAreDefault } : {}),

    listBookings: async ({ scope }) => (await call<{ bookings: AdminBooking[] }>("GET", `bookings?scope=${seg(scope)}`)).bookings,
    getBooking: async (id) => {
      try {
        return (await call<{ booking: AdminBooking & { events: AdminBookingEvent[] } }>("GET", `bookings/${seg(id)}`)).booking;
      } catch (error) {
        if (error instanceof BookingAdminRequestError && error.status === 404) return null;
        throw error;
      }
    },
    cancelBooking: async ({ id, reason }) => (await call<{ booking: AdminBooking }>("POST", `bookings/${seg(id)}/cancel`, { reason })).booking,
    confirmBooking: async (id) => (await call<{ booking: AdminBooking }>("POST", `bookings/${seg(id)}/confirm`)).booking,
    setOutcome: async ({ id, ...rest }) => (await call<{ booking: AdminBooking }>("POST", `bookings/${seg(id)}/outcome`, rest)).booking,
    rescheduleBooking: async ({ id, start }) => (await call<{ booking: AdminBooking }>("POST", `bookings/${seg(id)}/move`, { start })).booking,
    listRescheduleSlots: async ({ id, from, to }) => call("GET", `bookings/${seg(id)}/slots?from=${seg(from)}&to=${seg(to)}`),

    listHosts: async () => (await call<{ hosts: AdminHost[] }>("GET", "hosts")).hosts,
    upsertHost: async (input) => {
      const { id, ...rest } = input;
      return (await call<{ host: AdminHost }>("POST", id ? `hosts/${seg(id)}` : "hosts", rest)).host;
    },
    testCalendar: (hostId) => call("POST", `hosts/${seg(hostId)}/test-calendar`),
    rotateFeed: (hostId) => call("POST", `hosts/${seg(hostId)}/feed`),

    getAvailability: (hostId) => call<{ weekly: WeeklyWindow[]; exceptions: AdminException[] }>("GET", `hosts/${seg(hostId)}/availability`),
    setWeekly: ({ hostId, windows }) => call("POST", `hosts/${seg(hostId)}/availability`, { windows }),
    addException: async ({ hostId, ...rest }) => (await call<{ exception: AdminException }>("POST", `hosts/${seg(hostId)}/exceptions`, rest)).exception,
    removeException: (id) => call("POST", `exceptions/${seg(id)}/remove`),
    listBlackouts: async () => (await call<{ holidays: AdminBlackout[] }>("GET", "holidays")).holidays,
    addBlackout: async (input) => (await call<{ holiday: AdminBlackout }>("POST", "holidays", input)).holiday,
    removeBlackout: (id) => call("POST", `holidays/${seg(id)}/remove`),

    listTypes: async () => (await call<{ types: AdminBookingType[] }>("GET", "types")).types,
    upsertType: async (input) => {
      const { id, ...rest } = input;
      return (await call<{ type: AdminBookingType }>("POST", id ? `types/${seg(id)}` : "types", rest)).type;
    },

    countLiveHolds: async () => (await call<{ live: number }>("GET", "holds")).live,
    listTeam: () => call<TeamList>("GET", "team"),
    cancelAllFromEmail: (email) => call<{ cancelled: number }>("POST", "bookings/cancel-from-email", { email }),
  };
}

/**
 * An answer that wasn't the package's own (a platform's error page, a proxy,
 * a timeout): what its HTTP status says, in plain words. The generic sentence
 * only when the status says nothing more (polish 3: no "Something went wrong"
 * where the cause is knowable).
 */
function statusWords(status: number, fallback = "Something went wrong. Please try again."): string {
  switch (status) {
    case 401:
      return "You've been signed out. Sign in again to keep working.";
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return "That isn't here any more. Reload the page.";
    case 408:
    case 504:
      return "The site took too long to answer. Please try again in a minute.";
    case 413:
      return "That's too big to send.";
    case 429:
      return "That's a lot of tries in a short time. Wait a minute, then try again.";
    case 502:
    case 503:
      return "The site isn't answering right now. Please try again in a minute.";
    default:
      return fallback;
  }
}
