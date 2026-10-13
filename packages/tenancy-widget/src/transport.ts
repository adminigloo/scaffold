import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTenancyClient, type TenancyTransport } from "./client.js";
import type { ClientError, Result } from "./http.js";
import { NOT_CONNECTED_MESSAGE } from "./words.js";

/**
 * Every component takes `transport` OR `baseUrl` (contract 8.1). With both,
 * `transport` wins: a host backing the widget with tRPC or a server action
 * passes its own object. With neither, the component still renders: every
 * call answers one plain error ("This page isn't connected to its server
 * yet.") rather than throwing inside React.
 */

export const NOT_CONNECTED: Result<never> = {
  ok: false,
  error: { code: "bad_response", message: NOT_CONNECTED_MESSAGE, status: 0 },
};

/** A transport whose every method answers NOT_CONNECTED. A Proxy, so a method added later is covered too. */
export function missingTransport<T extends object>(): T {
  const fail = () => Promise.resolve(NOT_CONNECTED);
  return new Proxy({} as T, { get: () => fail });
}

export function useTenancyTransport(transport: TenancyTransport | undefined, baseUrl: string | undefined): TenancyTransport {
  return useMemo(
    () => transport ?? (baseUrl ? createTenancyClient({ baseUrl }) : missingTransport<TenancyTransport>()),
    [transport, baseUrl],
  );
}

/** True when the component was given neither a transport nor a baseUrl. */
export function isUnconnected(transport: unknown, baseUrl: string | undefined): boolean {
  return !transport && !baseUrl;
}

// ---------------------------------------------------------------------------
// Loading a thing, with a server-rendered first value
// ---------------------------------------------------------------------------

export interface Loaded<T> {
  data: T | null;
  error: ClientError | null;
  loading: boolean;
  /** Ask again; the current data stays on screen meanwhile. */
  reload: () => Promise<Result<T> | null>;
  /** Replace the data with an answer a write already returned. */
  set: (data: T) => void;
}

/**
 * `load()` on mount (and when `key` changes), unless `initial` was given, in
 * which case the first paint uses it and nothing is fetched until `reload()`.
 * A null `key` means "don't load" (no transport, or nothing to ask yet).
 * Answers are checked against the latest request, so a slow answer never
 * overwrites a newer one.
 */
export function useLoaded<T>(load: () => Promise<Result<T>>, initial: T | undefined, key: string | null): Loaded<T> {
  const [data, setData] = useState<T | null>(initial ?? null);
  const [error, setError] = useState<ClientError | null>(null);
  const [loading, setLoading] = useState(initial === undefined && key !== null);
  const requestId = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    const result = await loadRef.current();
    if (id !== requestId.current) return null;
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
    setLoading(false);
    return result;
  }, []);

  // The server-rendered value answers the FIRST key only.
  const seededKey = useRef(initial !== undefined ? key : undefined);
  const lastKey = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const first = lastKey.current === undefined;
    if (lastKey.current === key) return;
    lastKey.current = key;
    if (key === null) {
      setLoading(false);
      return;
    }
    if (first && seededKey.current === key) return;
    void reload();
  }, [key, reload]);

  const set = useCallback((next: T) => {
    requestId.current += 1;
    setData(next);
    setError(null);
    setLoading(false);
  }, []);

  return { data, error, loading, reload, set };
}

/** The component's one status line and its alert (contract 8.13). */
export function useAnnouncer() {
  const [status, setStatus] = useState("");
  const [alert, setAlert] = useState("");
  const announce = useCallback((text: string) => {
    setAlert("");
    setStatus(text);
  }, []);
  const fail = useCallback((text: string) => {
    setStatus("");
    setAlert(text);
  }, []);
  const clear = useCallback(() => {
    setStatus("");
    setAlert("");
  }, []);
  return { status, alert, announce, fail, clear };
}

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
