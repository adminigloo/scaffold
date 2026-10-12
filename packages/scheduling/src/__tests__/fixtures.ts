import type { OutboundEmail } from "@adminigloo/comms";
import type { SchedulingEvent } from "../events.js";
import type { LatLng } from "../maps.js";

/**
 * Shared fakes for the 0.4 suites: a Google Maps API that answers from a
 * table (and counts every request), a recording email sender, an event
 * recorder, and Request builders. Not a suite (vitest runs *.test.ts only).
 */

export const GOOGLE_KEY = "AIzaTEST-secret-key-0123456789";

export interface FakeGoogleOptions {
  /** Address → coordinates. An address not listed answers ZERO_RESULTS. */
  places?: Record<string, LatLng>;
  /** Fixed drive minutes for every pair (default 15), or a function of the pair. */
  driveMinutes?: number | ((origin: LatLng, dest: LatLng) => number);
  /** Miles for every pair (default 6.2). */
  miles?: number;
  /** Addresses whose geocode answers with this failure instead. */
  geocodeFailures?: Record<string, { status?: string; http?: number; network?: boolean; hang?: boolean }>;
  /** Every Distance Matrix call answers this instead. */
  matrixFailure?: { status?: string; http?: number; network?: boolean; hang?: boolean; elementStatus?: string };
}

export interface FakeGoogle {
  fetch: typeof fetch;
  /** Every URL requested, in order. */
  urls: string[];
  geocodes: () => string[];
  matrices: () => string[];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
  const urls: string[] = [];
  const fail = (failure: { status?: string; http?: number; network?: boolean; hang?: boolean }): Promise<Response> => {
    if (failure.hang) return new Promise<Response>(() => undefined);
    if (failure.network) return Promise.reject(new TypeError(`fetch failed for ${urls.at(-1)}`));
    if (failure.http) return Promise.resolve(json({ error: "boom" }, failure.http));
    return Promise.resolve(json({ status: failure.status ?? "UNKNOWN_ERROR", results: [], error_message: "nope" }));
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/geocode/json")) {
      const address = parsed.searchParams.get("address") ?? "";
      const failure = options.geocodeFailures?.[address];
      if (failure) return fail(failure);
      const place = options.places?.[address];
      if (!place) return json({ status: "ZERO_RESULTS", results: [] });
      return json({ status: "OK", results: [{ geometry: { location: place } }] });
    }
    if (parsed.pathname.endsWith("/distancematrix/json")) {
      if (options.matrixFailure && !options.matrixFailure.elementStatus) return fail(options.matrixFailure);
      const [oLat, oLng] = (parsed.searchParams.get("origins") ?? "0,0").split(",").map(Number);
      const [dLat, dLng] = (parsed.searchParams.get("destinations") ?? "0,0").split(",").map(Number);
      const minutes =
        typeof options.driveMinutes === "function"
          ? options.driveMinutes({ lat: oLat ?? 0, lng: oLng ?? 0 }, { lat: dLat ?? 0, lng: dLng ?? 0 })
          : (options.driveMinutes ?? 15);
      const element = options.matrixFailure?.elementStatus
        ? { status: options.matrixFailure.elementStatus }
        : {
            status: "OK",
            duration: { value: minutes * 60, text: `${minutes} mins` },
            distance: { value: Math.round((options.miles ?? 6.2) * 1609.344), text: "6.2 mi" },
            ...(parsed.searchParams.get("departure_time") === "now"
              ? { duration_in_traffic: { value: (minutes + 5) * 60, text: "traffic" } }
              : {}),
          };
      return json({ status: "OK", rows: [{ elements: [element] }] });
    }
    return json({ status: "NOT_FOUND" }, 404);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    urls,
    geocodes: () => urls.filter((u) => u.includes("/geocode/json")),
    matrices: () => urls.filter((u) => u.includes("/distancematrix/json")),
  };
}

/** An email sender that records every message (and can be told to fail). */
export function recordingSender() {
  const sent: OutboundEmail[] = [];
  let failing = false;
  return {
    sent,
    fail(on: boolean) {
      failing = on;
    },
    senders: {
      email: async (message: OutboundEmail) => {
        if (failing) throw new Error("mail server down");
        sent.push(message);
        return { id: `msg-${sent.length}` };
      },
    },
  };
}

/** Records events; `fail` makes the listener throw (after recording). */
export function eventRecorder(options: { fail?: boolean } = {}) {
  const events: SchedulingEvent[] = [];
  return {
    events,
    onEvent: async (event: SchedulingEvent) => {
      events.push(event);
      if (options.fail) throw new Error("listener broke");
    },
    types: () => events.map((event) => event.type),
  };
}

const BASE = "https://acme.test/api/schedule";

/** A same-origin browser request (Sec-Fetch-Site: same-origin) to the handler. */
export function apiRequest(
  method: "GET" | "POST" | "OPTIONS",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

export async function readJson<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
