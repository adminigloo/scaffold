import { createCachedMapsProvider, type CachedMapsOptions } from "./cache.js";
import {
  createHaversineMapsProvider,
  MapsProviderError,
  type DriveTime,
  type LatLng,
  type MapsProvider,
  type MapsProviderErrorKind,
} from "./maps.js";
import type { SchedulingDb } from "./types.js";

/**
 * Google Maps behind the `MapsProvider` seam: the Geocoding API for addresses
 * and the Distance Matrix API for drive times. RAW `fetch`, no SDK and no new
 * dependency — two GET requests don't justify a client library and its
 * transitive tree in every buyer's app.
 *
 * Enable the Geocoding API and the Distance Matrix API on the key, and
 * restrict the key to those two APIs and to your server. It is a SERVER key:
 * it never goes to a browser, and nothing here puts it in an error.
 *
 * THE KEY NEVER LEAVES THE SERVER. The request URLs carry it (Google's REST
 * APIs take it as a query parameter), so no message, `onError` payload, log
 * line or thrown error is ever built from a URL or from the fetch's own
 * error (whose text can include the URL). Messages are built from the API
 * name, the kind of failure and Google's status string only.
 */

export interface GoogleMapsProviderOptions {
  apiKey: string;
  /** Default `globalThis.fetch`. Inject a fake in tests. */
  fetch?: typeof fetch;
  /** Per request. Default 4000 ms. A request that takes longer is abandoned as a `timeout`. */
  timeoutMs?: number;
  /** Geocoding bias, e.g. "us". */
  region?: string;
  /** Geocoding filter, e.g. "country:US". */
  components?: string;
  /** "now": ask for `duration_in_traffic`. Default: the typical (traffic-free) duration. */
  departureTime?: "now";
  /** Told about every failure, for a log or an alert. The error never contains the key. */
  onError?: (error: MapsProviderError) => void;
}

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";
const METERS_PER_MILE = 1609.344;

type Api = "Geocoding" | "Distance Matrix";

function kindForStatus(status: string): MapsProviderErrorKind {
  switch (status) {
    case "OVER_QUERY_LIMIT":
    case "OVER_DAILY_LIMIT":
      return "quota";
    case "REQUEST_DENIED":
      return "denied";
    case "INVALID_REQUEST":
    case "MAX_ELEMENTS_EXCEEDED":
    case "MAX_DIMENSIONS_EXCEEDED":
      return "invalid";
    default:
      return "unknown";
  }
}

function statusError(api: Api, status: string): MapsProviderError {
  // `status` is Google's enum, but treat it as untrusted text: short, plain.
  const safe = status.replace(/[^A-Z_]/g, "").slice(0, 40) || "UNKNOWN";
  return new MapsProviderError(kindForStatus(safe), `Google ${api} API answered ${safe}`, safe);
}

/** Round to one decimal place: 9.24 miles → 9.2. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * A Google-backed provider (`geocodes: true`, `estimates: false`).
 *
 * Geocode: `status: "OK"` gives the first result's location; `ZERO_RESULTS`
 * gives null ("no such place"); anything else — `OVER_QUERY_LIMIT`,
 * `REQUEST_DENIED`, `INVALID_REQUEST`, `UNKNOWN_ERROR`, a non-2xx answer, a
 * timeout, a network failure — THROWS a `MapsProviderError` and calls
 * `onError`. A blank address is null with no request.
 *
 * Drive time: with the top-level and the element status both `OK`, the
 * duration (in traffic when asked for) rounded to minutes and the distance in
 * miles to one decimal. Anything else is null, after `onError` for transport
 * and status failures. It never throws.
 */
export function createGoogleMapsProvider(options: GoogleMapsProviderOptions): MapsProvider {
  const apiKey = options.apiKey?.trim() ?? "";
  if (!apiKey) throw new Error("createGoogleMapsProvider: apiKey is required");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 4000;

  const report = (error: MapsProviderError): MapsProviderError => {
    try {
      options.onError?.(error);
    } catch {
      /* a broken reporter must not change the answer */
    }
    return error;
  };

  /**
   * One GET, bounded by the timeout even when the fetch ignores its signal (a
   * hung socket, a fake): the race settles at the deadline either way. Throws
   * only `MapsProviderError`s with key-free messages.
   */
  async function getJson(api: Api, url: string): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MapsProviderError("timeout", `Google ${api} API timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    let response: Response;
    try {
      response = await Promise.race([fetchImpl(url, { signal, headers: { accept: "application/json" } }), deadline]);
    } catch (error) {
      if (error instanceof MapsProviderError) throw error;
      const name = (error as { name?: unknown } | null)?.name;
      const timedOut = name === "TimeoutError" || name === "AbortError";
      // Never the fetch error's own message: it can quote the URL, key included.
      throw new MapsProviderError(
        timedOut ? "timeout" : "network",
        timedOut ? `Google ${api} API timed out after ${timeoutMs} ms` : `Couldn't reach the Google ${api} API`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!response.ok) {
      throw new MapsProviderError("http", `Google ${api} API answered HTTP ${response.status}`, String(response.status));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MapsProviderError("unknown", `Google ${api} API answered something that isn't JSON`);
    }
    if (!body || typeof body !== "object") {
      throw new MapsProviderError("unknown", `Google ${api} API answered an unexpected shape`);
    }
    return body as Record<string, unknown>;
  }

  return {
    geocodes: true,
    estimates: false,

    async geocode(address: string): Promise<LatLng | null> {
      const query = address?.trim() ?? "";
      if (!query) return null;
      let url = `${GEOCODE_URL}?address=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;
      if (options.region) url += `&region=${encodeURIComponent(options.region)}`;
      if (options.components) url += `&components=${encodeURIComponent(options.components)}`;
      let body: Record<string, unknown>;
      try {
        body = await getJson("Geocoding", url);
      } catch (error) {
        throw report(error as MapsProviderError);
      }
      const status = typeof body["status"] === "string" ? (body["status"] as string) : "";
      if (status === "ZERO_RESULTS") return null;
      if (status !== "OK") throw report(statusError("Geocoding", status));
      const results = Array.isArray(body["results"]) ? (body["results"] as unknown[]) : [];
      const location = (results[0] as { geometry?: { location?: { lat?: unknown; lng?: unknown } } } | undefined)
        ?.geometry?.location;
      if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") return null;
      return { lat: location.lat, lng: location.lng };
    },

    async driveTime(origin: LatLng, dest: LatLng): Promise<DriveTime | null> {
      let url =
        `${DISTANCE_MATRIX_URL}?origins=${origin.lat},${origin.lng}&destinations=${dest.lat},${dest.lng}` +
        `&mode=driving&units=imperial&key=${encodeURIComponent(apiKey)}`;
      if (options.departureTime === "now") url += "&departure_time=now";
      let body: Record<string, unknown>;
      try {
        body = await getJson("Distance Matrix", url);
      } catch (error) {
        report(error as MapsProviderError);
        return null;
      }
      const status = typeof body["status"] === "string" ? (body["status"] as string) : "";
      if (status !== "OK") {
        report(statusError("Distance Matrix", status));
        return null;
      }
      const rows = Array.isArray(body["rows"]) ? (body["rows"] as Array<{ elements?: unknown[] }>) : [];
      const element = rows[0]?.elements?.[0] as
        | {
            status?: unknown;
            duration?: { value?: unknown };
            duration_in_traffic?: { value?: unknown };
            distance?: { value?: unknown };
          }
        | undefined;
      // CONTRACT: an element that isn't OK (no road between the two, a point
      // it can't place) is an answer, not an outage: null, with nothing
      // reported. Top-level statuses and transport failures are reported.
      if (!element || element.status !== "OK") return null;
      const seconds =
        typeof element.duration_in_traffic?.value === "number" ? element.duration_in_traffic.value : element.duration?.value;
      const meters = element.distance?.value;
      if (typeof seconds !== "number" || typeof meters !== "number") return null;
      return { durationMinutes: Math.round(seconds / 60), distanceMiles: round1(meters / METERS_PER_MILE) };
    },
  };
}

export interface SelectMapsProviderOptions {
  /** The Google key, or nothing. Blank counts as nothing. */
  googleMapsApiKey?: string | null;
  /** With a key: cache drive times in this database (`createCachedMapsProvider`). */
  db?: SchedulingDb;
  fetch?: typeof fetch;
  cache?: CachedMapsOptions;
}

/**
 * The provider a deployment should use, chosen by whether a key is present:
 *
 *   - key + db → Google, with drive times cached in the database;
 *   - key only → Google, uncached;
 *   - no key   → the keyless Haversine estimates (no geocoding).
 *
 * So `GOOGLE_MAPS_API_KEY` in the environment is the whole switch.
 */
export function selectMapsProvider(options: SelectMapsProviderOptions = {}): MapsProvider {
  const key = options.googleMapsApiKey?.trim();
  if (!key) return createHaversineMapsProvider();
  const google = createGoogleMapsProvider({ apiKey: key, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return options.db ? createCachedMapsProvider(google, options.db, options.cache) : google;
}
