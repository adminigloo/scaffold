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
 */
export function useSessionRecorder(): UseSessionRecorderReturn {
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

  const getSessionId = useCallback(() => (sessionIdRef.current ??= generateId("sess")), []);
  const getEvents = useCallback(() => events().toArray(), []);
  const getErrors = useCallback(() => errors().toArray(), []);
  const clearSession = useCallback(() => {
    events().clear();
    errors().clear();
  }, []);

  return { getSessionId, getEvents, getErrors, clearSession };
}
