import { useCallback, useEffect, useRef, useState } from "react";
import type { BookingClient, Result, SlotSource } from "./client.js";
import type { BookingError } from "./requests.js";
import { holdDeadline, horizonEndMs, mayHaveLaterSlots, slotWindow } from "./time.js";
import type { HoldResponse, Slot } from "./types.js";

/**
 * The stateful pieces both components share: the slot list for one type, the
 * hold on a picked time, a ticking clock for the countdown, and focus that
 * follows a step change. Kept out of the components so the booking flow and
 * the reschedule flow cannot drift apart in how they hold and release.
 */

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export interface SlotsState {
  status: "idle" | "loading" | "ready" | "error";
  slots: Slot[];
  error: BookingError | null;
  /** A refetch in the background; the current list stays on screen meanwhile. */
  refreshing: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  /**
   * The end (ISO) of the last fetch window loaded — days past it are not
   * "empty", they are not asked about yet, so the date strip stops there.
   */
  loadedUntil: string | null;
}

const IDLE_SLOTS: SlotsState = {
  status: "idle",
  slots: [],
  error: null,
  refreshing: false,
  hasMore: false,
  loadingMore: false,
  loadedUntil: null,
};

export interface UseSlotsOptions {
  /** The invitee's manage token on a reschedule (sent as `manage`). */
  manageToken?: string | undefined;
  /** The type's horizon, when the server says it: makes `hasMore` exact. */
  horizonDays?: number | undefined;
  /** The zone the horizon is counted in (the host's). */
  hostZone?: string | undefined;
}

export interface UseSlots extends SlotsState {
  /** Re-fetch every window loaded so far (after a slot_taken, say). */
  refresh: () => void;
  /** Fetch the next window, when `hasMore`. */
  loadMore: () => void;
  /** Start over from the first window. */
  retry: () => void;
}

export function useSlots(client: SlotSource, typeKey: string | null, options: UseSlotsOptions = {}): UseSlots {
  const [state, setState] = useState<SlotsState>(IDLE_SLOTS);
  // Every response is checked against the latest request: a slow answer for
  // the type the visitor just left must never overwrite the one they are on.
  const requestId = useRef(0);
  const windows = useRef(1);
  // Primitives, not the options object, in the dependency lists below — a
  // fresh object each render would refetch on every render.
  const { manageToken, horizonDays, hostZone } = options;

  const fetchWindows = useCallback(
    async (
      count: number,
    ): Promise<Result<{ slots: Slot[]; lastWindowEnd: string; lastWindow: Slot[]; horizonEnd: number | null }>> => {
      const origin = Date.now();
      const ranges = Array.from({ length: count }, (_, index) => slotWindow(origin, index));
      const results = await Promise.all(
        ranges.map((range) =>
          client.slots({ type: typeKey ?? "", from: range.from, to: range.to, ...(manageToken ? { manage: manageToken } : {}) }),
        ),
      );
      const failed = results.find((result) => !result.ok);
      if (failed && !failed.ok) return failed;
      const lists = results.map((result) => (result.ok ? result.data.slots : []));
      return {
        ok: true,
        data: {
          slots: lists.flat(),
          lastWindowEnd: ranges[ranges.length - 1]!.to,
          lastWindow: lists[lists.length - 1] ?? [],
          horizonEnd: horizonDays && hostZone ? horizonEndMs(origin, horizonDays, hostZone) : null,
        },
      };
    },
    [client, typeKey, manageToken, horizonDays, hostZone],
  );

  const load = useCallback(
    async (mode: "reset" | "refresh" | "more") => {
      if (!typeKey) return;
      const id = ++requestId.current;
      if (mode === "reset") windows.current = 1;
      if (mode === "more") windows.current += 1;
      setState((current) =>
        mode === "reset"
          ? { ...IDLE_SLOTS, status: "loading" }
          : mode === "refresh"
            ? { ...current, refreshing: true }
            : { ...current, loadingMore: true },
      );
      const result = await fetchWindows(windows.current);
      if (id !== requestId.current) return;
      if (!result.ok) {
        if (mode === "more") windows.current -= 1;
        setState((current) =>
          mode === "reset" || current.status !== "ready"
            ? { ...IDLE_SLOTS, status: "error", error: result.error }
            : { ...current, refreshing: false, loadingMore: false, error: result.error },
        );
        return;
      }
      const { lastWindowEnd, horizonEnd } = result.data;
      setState({
        status: "ready",
        slots: result.data.slots,
        error: null,
        refreshing: false,
        loadingMore: false,
        // With the horizon known, "later dates" exist exactly when it runs past
        // what was fetched; otherwise infer it from where the times stop.
        hasMore:
          horizonEnd !== null
            ? Date.parse(lastWindowEnd) < horizonEnd
            : mayHaveLaterSlots(result.data.lastWindow, lastWindowEnd),
        loadedUntil: lastWindowEnd,
      });
    },
    [typeKey, fetchWindows],
  );

  useEffect(() => {
    if (typeKey) void load("reset");
    else {
      requestId.current += 1;
      setState(IDLE_SLOTS);
    }
  }, [typeKey, load]);

  return {
    ...state,
    refresh: useCallback(() => void load("refresh"), [load]),
    loadMore: useCallback(() => void load("more"), [load]),
    retry: useCallback(() => void load("reset"), [load]),
  };
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

export interface HeldSlot {
  token: string;
  typeKey: string;
  start: string;
  end: string;
  /** When the hold lapses, on this browser's clock (see holdDeadline). */
  deadline: number;
  /** Set when the hold is for moving an existing booking (sent as `manageToken`). */
  manageToken?: string;
}

export interface HoldOptions {
  /**
   * The invitee's manage token, on a reschedule: the server then leaves the
   * booking being moved out of the check, so a time next to it can be held.
   */
  manageToken?: string | undefined;
}

export interface UseHold {
  hold: HeldSlot | null;
  /** The start being held right now (request in flight). */
  pendingStart: string | null;
  /**
   * Hold `start`, handing back the current hold in the same request
   * (`previousHoldToken`). Resolves null when a later pick superseded this one
   * before it was sent — the later pick is the one that counts.
   */
  take: (typeKey: string, start: string, options?: HoldOptions) => Promise<Result<HoldResponse> | null>;
  /** Give the hold back (best-effort) and forget it. */
  release: () => void;
  /** Forget the hold WITHOUT releasing it: it just became a booking. */
  consume: () => void;
}

/**
 * Holds, with the release rules the spec asks for: picking another time sends
 * `previousHoldToken`; switching type, leaving the page or unmounting gives the
 * hold back (keepalive fetch / beacon — best-effort, the server expires it in
 * ten minutes regardless).
 *
 * Picks are SERIALISED. Two quick clicks would otherwise send two hold requests
 * that each carry no previous token (the first token has not arrived when the
 * second request leaves), and the visitor would walk off holding two times.
 * Each pick waits for the one before it, and a pick that has been superseded
 * by the time its turn comes is skipped without a request.
 *
 * `onRestoreFailed` covers the back-forward cache: leaving released the hold,
 * so a page restored from the bfcache re-holds the same time, and reports the
 * error when that time has gone meanwhile.
 */
export function useHold(client: BookingClient, onRestoreFailed?: (error: BookingError) => void): UseHold {
  const [hold, setHold] = useState<HeldSlot | null>(null);
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const holdRef = useRef<HeldSlot | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const pickSeq = useRef(0);
  const releasedOnHide = useRef<HeldSlot | null>(null);
  const onRestoreFailedRef = useRef(onRestoreFailed);
  onRestoreFailedRef.current = onRestoreFailed;

  const set = useCallback((next: HeldSlot | null) => {
    holdRef.current = next;
    setHold(next);
  }, []);

  const take = useCallback(
    (typeKey: string, start: string, options: HoldOptions = {}): Promise<Result<HoldResponse> | null> => {
      const seq = ++pickSeq.current;
      setPendingStart(start);
      const { manageToken } = options;
      const run = async (): Promise<Result<HoldResponse> | null> => {
        if (seq !== pickSeq.current) return null;
        const previous = holdRef.current?.token;
        const result = await client.hold({
          type: typeKey,
          start,
          ...(previous ? { previousHoldToken: previous } : {}),
          ...(manageToken ? { manageToken } : {}),
        });
        const stillWanted = seq === pickSeq.current;
        if (result.ok) {
          if (stillWanted) {
            set({
              token: result.data.holdToken,
              typeKey,
              start: result.data.start,
              end: result.data.end,
              deadline: holdDeadline(result.data.expiresAt, Date.now()),
              ...(manageToken ? { manageToken } : {}),
            });
          } else {
            // Released or superseded while in flight (type switched, left the
            // step). The server already let go of `previous` in this request;
            // give back the hold nobody wants any more.
            client.release(result.data.holdToken);
            set(null);
          }
        } else if (previous) {
          // The failed request rolled back, so the previous hold is still
          // live — but the visitor has moved off that time. Give it back.
          client.release(previous);
          set(null);
        }
        if (!stillWanted) return null;
        setPendingStart(null);
        return result;
      };
      const next = chain.current.then(run, run);
      chain.current = next.catch(() => undefined);
      return next;
    },
    [client, set],
  );

  const release = useCallback(() => {
    pickSeq.current += 1;
    setPendingStart(null);
    const current = holdRef.current;
    set(null);
    if (current) client.release(current.token);
  }, [client, set]);

  const consume = useCallback(() => {
    pickSeq.current += 1;
    setPendingStart(null);
    set(null);
  }, [set]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPageHide = () => {
      const current = holdRef.current;
      if (!current) return;
      client.release(current.token);
      releasedOnHide.current = current;
    };
    const onPageShow = (event: PageTransitionEvent) => {
      const lost = releasedOnHide.current;
      releasedOnHide.current = null;
      if (!event.persisted || !lost) return;
      void take(lost.typeKey, lost.start, { manageToken: lost.manageToken }).then((result) => {
        if (result && !result.ok) onRestoreFailedRef.current?.(result.error);
      });
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      // Unmount (or a new client): hand the hold back.
      const current = holdRef.current;
      if (current) {
        client.release(current.token);
        set(null);
      }
    };
  }, [client, take, set]);

  return { hold, pendingStart, take, release, consume };
}

// ---------------------------------------------------------------------------
// Clock and focus
// ---------------------------------------------------------------------------

/** Date.now(), re-rendered every `intervalMs` while `active`. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * A ref to put on each step's heading (with tabIndex={-1}); focus moves to it
 * whenever `step` CHANGES — never on mount, so the widget does not steal focus
 * from the page it loads into. Compared against the previous value rather
 * than a "first run" flag, because StrictMode runs mount effects twice and a
 * flag would be spent on the first run.
 */
export function useStepFocus<T extends HTMLElement>(step: unknown) {
  const ref = useRef<T | null>(null);
  const previous = useRef(step);
  useEffect(() => {
    if (Object.is(previous.current, step)) return;
    previous.current = step;
    ref.current?.focus();
  }, [step]);
  return ref;
}
