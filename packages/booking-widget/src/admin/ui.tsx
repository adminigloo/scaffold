import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Tone } from "./helpers.js";

/**
 * The admin's building blocks and its two data hooks. No query library: the
 * adapter is a bag of async functions, and these hooks are the whole cache —
 * load on mount, reload after a change, ignore an answer that arrives after
 * a newer request.
 */

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Something went wrong. Please try again.";
}

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Load `fn` now and whenever `key` changes; `reload()` asks again. The data on screen stays while a reload runs. */
export function useResource<T>(fn: () => Promise<T>, key: string): Resource<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({
    data: undefined,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setState((current) => ({ ...current, loading: true }));
    fnRef
      .current()
      .then((data) => {
        if (alive) setState({ data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (alive) setState((current) => ({ data: current.data, error: errorText(error), loading: false }));
      });
    return () => {
      alive = false;
    };
  }, [key, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

export interface Action<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
}

/** A mutation: pending while it runs, its error kept for the control that called it, `onSuccess` after. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, onSuccess?: (result: R) => void): Action<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const successRef = useRef(onSuccess);
  successRef.current = onSuccess;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      if (mounted.current) setPending(false);
      successRef.current?.(result);
      return result;
    } catch (caught) {
      if (mounted.current) {
        setPending(false);
        setError(errorText(caught));
      }
      return undefined;
    }
  }, []);
  return { run, pending, error, clearError: useCallback(() => setError(null), []) };
}

export function Card({
  id,
  title,
  hint,
  children,
  className,
}: {
  id?: string;
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  // Prefixed: a bare "host-title" could collide with an id in the host app.
  const headingId = id ? `aibk-card-${id}` : undefined;
  return (
    <section className={`aibk-card${className ? ` ${className}` : ""}`} aria-labelledby={headingId} data-aibk-card={id}>
      <div className="aibk-card-head">
        {/* tabIndex -1: the "Finish setting up" buttons move focus here. */}
        <h3 className="aibk-card-title" id={headingId} tabIndex={-1}>
          {title}
        </h3>
        {hint ? <p className="aibk-card-hint">{hint}</p> : null}
      </div>
      <div className="aibk-card-body">{children}</div>
    </section>
  );
}

export function FormField({
  id,
  label,
  hint,
  children,
  wide,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`aibk-field${wide ? " aibk-span2" : ""}`}>
      <label className="aibk-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? (
        <span className="aibk-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Badge({ tone, children }: { tone: Tone | "accent"; children: ReactNode }) {
  const toneClass = tone === "ok" ? " aibk-tag-ok" : tone === "danger" ? " aibk-tag-danger" : tone === "muted" ? " aibk-tag-muted" : tone === "accent" ? " aibk-tag-accent" : "";
  return <span className={`aibk-tag${toneClass}`}>{children}</span>;
}

/** A saved / failed line beside a button, announced. */
export function Outcome({ ok, error }: { ok?: string | null; error?: string | null }) {
  if (error) {
    return (
      <span className="aibk-danger-text" role="alert">
        {error}
      </span>
    );
  }
  if (ok) {
    return (
      <span className="aibk-ok-text" role="status">
        {ok}
      </span>
    );
  }
  return null;
}
