import { useCallback, useEffect, useRef } from "react";
import { describeElement, generateId, RingBuffer } from "./recorder.js";
import { isSensitive } from "./redaction.js";
import type { CapturedError, SessionEvent } from "./types.js";

export interface UseSessionRecorderReturn {
  getSessionId: () => string;
  getEvents: () => SessionEvent[];
  getErrors: () => CapturedError[];
  clearSession: () => void;
}

/**
 * Ambient recording so a submitted ticket carries what led up to it: the last
 * 50 clicks (described as readable phrases), route changes, and the last 20
 * browser errors from window.onerror / unhandledrejection / a patched
 * console.error. Counts are never React state — a setState inside the
 * console.error interceptor would re-render mid-log (Ask Lou learned this as
 * a hydration bug).
 *
 * Navigation is tracked framework-free: history.pushState/replaceState are
 * wrapped and popstate observed, because the widget cannot assume Next.js —
 * or any router at all.
 *
 * FAILED REQUESTS are recorded too (fetch and XMLHttpRequest, status >= 400 or
 * a network failure), as `failedRequest` entries beside the errors. Ask Lou's
 * bug reporter ranked the server error linked to a report as its single most
 * useful debug signal ("the button did nothing" is usually a 500 nobody saw);
 * the port had dropped it. Only the method, the path and the status are kept —
 * never a body, never the query string (tokens live there) — and the widget's
 * own calls to its platform are left out.
 */
export function useSessionRecorder(
  options: {
    /** The feedback platform's base URL; its requests are not the story. */
    ignoreUrlPrefix?: string;
  } = {},
): UseSessionRecorderReturn {
  const ignoreUrlPrefix = options.ignoreUrlPrefix;
  const eventsRef = useRef<RingBuffer<SessionEvent> | null>(null);
  const errorsRef = useRef<RingBuffer<CapturedError> | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const capturingRef = useRef(false);

  const events = () => (eventsRef.current ??= new RingBuffer<SessionEvent>(50));
  const errors = () => (errorsRef.current ??= new RingBuffer<CapturedError>(20));

  const addEvent = useCallback((event: Omit<SessionEvent, "timestamp">) => {
    events().push({ ...event, timestamp: Date.now() });
  }, []);

  const addError = useCallback((error: Omit<CapturedError, "id" | "timestamp">) => {
    errors().push({ ...error, id: generateId("err"), timestamp: Date.now() });
  }, []);

  // Clicks
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Clicks inside the widget are the reporting flow, not the story being
      // reported; a host's `data-feedback-ignore` keeps an element out of the
      // report entirely — screenshot AND trail.
      if (target.closest("[data-aif-modal],[data-aif-button],[data-feedback-ui],[data-feedback-ignore]")) return;
      // Secret content is redacted in the screenshot; the trail must not undo
      // that by quoting it (a user clicks a revealed API key to copy it, then
      // reports). Record that a sensitive thing was clicked, not what it said.
      if (isSensitive(target)) {
        addEvent({ type: "click", target: `${target.tagName.toLowerCase()} (sensitive)` });
        return;
      }
      addEvent({ type: "click", target: describeElement(target).slice(0, 200) });
    };
    document.addEventListener("click", handleClick, { passive: true });
    return () => document.removeEventListener("click", handleClick);
  }, [addEvent]);

  // Navigation
  useEffect(() => {
    let last = window.location.pathname;
    const record = () => {
      const next = window.location.pathname;
      if (next !== last) {
        addEvent({ type: "navigation", value: next, target: last });
        last = next;
      }
    };
    const originalPush = history.pushState.bind(history);
    const originalReplace = history.replaceState.bind(history);
    history.pushState = (...args) => {
      originalPush(...args);
      record();
    };
    history.replaceState = (...args) => {
      originalReplace(...args);
      record();
    };
    window.addEventListener("popstate", record);
    return () => {
      history.pushState = originalPush;
      history.replaceState = originalReplace;
      window.removeEventListener("popstate", record);
    };
  }, [addEvent]);

  // Errors
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      addError({
        type: "error",
        message: event.message || "Unknown error",
        stack: event.error instanceof Error ? event.error.stack : undefined,
        url: event.filename || undefined,
        lineNumber: event.lineno || undefined,
        columnNumber: event.colno || undefined,
      });
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      addError({
        type: "unhandledRejection",
        message:
          reason instanceof Error
            ? reason.message
            : typeof reason === "string"
              ? reason
              : "Unhandled promise rejection",
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    };

    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (!capturingRef.current) {
        capturingRef.current = true;
        const message = args
          .map((arg) => {
            if (arg instanceof Error) return arg.message;
            if (typeof arg === "string") return arg;
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          })
          .join(" ");
        const errorArg = args.find((arg): arg is Error => arg instanceof Error);
        addError({ type: "consoleError", message: message.slice(0, 500), stack: errorArg?.stack });
        capturingRef.current = false;
      }
      originalConsoleError.apply(console, args);
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      console.error = originalConsoleError;
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, [addError]);

  // Failed requests
  useEffect(() => {
    /** Method + path (same-origin) or origin + path; no query, no hash. */
    const describeUrl = (raw: string): { label: string; full: string } | null => {
      let url: URL;
      try {
        url = new URL(raw, window.location.href);
      } catch {
        return null;
      }
      const full = url.href;
      if (ignoreUrlPrefix && full.startsWith(new URL(ignoreUrlPrefix, window.location.href).href)) return null;
      const label = url.origin === window.location.origin ? url.pathname : `${url.origin}${url.pathname}`;
      return { label: label.slice(0, 300), full };
    };
    const record = (method: string, raw: string, outcome: string) => {
      const where = describeUrl(raw);
      if (!where) return;
      addError({
        type: "failedRequest",
        message: `${method.toUpperCase()} ${where.label} → ${outcome}`.slice(0, 500),
        url: where.label,
      });
    };

    const originalFetch = window.fetch;
    const patchedFetch: typeof window.fetch = async function (this: unknown, input, init) {
      const method =
        init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      try {
        const response = await originalFetch.call(this as typeof window, input, init);
        if (!response.ok && response.type !== "opaque") {
          record(method, raw, `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
        }
        return response;
      } catch (err) {
        // A navigation or a component unmounting cancels requests on purpose.
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          record(method, raw, `network error${err instanceof Error ? `: ${err.message}` : ""}`);
        }
        throw err;
      }
    };
    window.fetch = patchedFetch;

    const xhrProto = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype : null;
    const originalOpen = xhrProto?.open;
    const originalSend = xhrProto?.send;
    const requestInfo = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    if (xhrProto && originalOpen && originalSend) {
      xhrProto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        requestInfo.set(this, { method, url: String(url) });
        return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
      } as typeof xhrProto.open;
      xhrProto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        const info = requestInfo.get(this);
        if (info) {
          // An abort also ends in loadend with status 0; it is not a failure.
          let aborted = false;
          this.addEventListener("abort", () => {
            aborted = true;
          });
          this.addEventListener("loadend", () => {
            if (aborted) return;
            if (this.status >= 400) record(info.method, info.url, `${this.status}${this.statusText ? ` ${this.statusText}` : ""}`);
            else if (this.status === 0) record(info.method, info.url, "network error");
          });
        }
        return originalSend.call(this, body);
      };
    }

    return () => {
      // Only unpatch what is still ours — something may have wrapped us since.
      if (window.fetch === patchedFetch) window.fetch = originalFetch;
      if (xhrProto && originalOpen && originalSend) {
        xhrProto.open = originalOpen;
        xhrProto.send = originalSend;
      }
    };
  }, [addError, ignoreUrlPrefix]);

  const getSessionId = useCallback(() => (sessionIdRef.current ??= generateId("sess")), []);
  const getEvents = useCallback(() => events().toArray(), []);
  const getErrors = useCallback(() => errors().toArray(), []);
  const clearSession = useCallback(() => {
    events().clear();
    errors().clear();
  }, []);

  return { getSessionId, getEvents, getErrors, clearSession };
}
