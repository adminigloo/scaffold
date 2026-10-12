import { useCallback, useEffect, useRef, useState } from "react";
import type { SchedulingTransport } from "./client.js";
import type { ClientError } from "./http.js";
import { addDays, todayIn } from "./time.js";
import type { DateString, SlotsResponse } from "./types.js";

/**
 * The slot list for one service (or one visit being moved), a window of days
 * at a time. Kept out of the components so the booking flow and the manage
 * page's reschedule offer times exactly the same way.
 *
 * WINDOWS. The first window starts where the server says (today in the
 * business's zone, or the first day the notice allows); each "later" asks for
 * the window after the last one loaded (`from` = the day after its `to`).
 * "Earlier" steps back through windows already loaded, without a request.
 * `refresh()` re-asks for the window on screen — after "that time was just
 * taken" — and keeps the visitor where they were.
 */

export interface SlotPagesState {
  status: "idle" | "loading" | "ready" | "error";
  pages: SlotsResponse[];
  index: number;
  error: ClientError | null;
  /** A background re-ask of the window on screen; the list stays meanwhile. */
  refreshing: boolean;
  loadingLater: boolean;
}

const IDLE: SlotPagesState = { status: "idle", pages: [], index: 0, error: null, refreshing: false, loadingLater: false };

export interface UseSlotPages extends SlotPagesState {
  page: SlotsResponse | null;
  canEarlier: boolean;
  canLater: boolean;
  earlier: () => void;
  later: () => void;
  refresh: () => void;
  retry: () => void;
}

export interface SlotQuery {
  /** The service key (the booking flow). */
  service?: string | null;
  /** The visit's manage token (the reschedule flow): its own time counts as free. */
  manage?: string | null;
  /** Days per window. */
  days: number;
  /** The business's zone and horizon, to know when there is no "later". */
  timeZone?: string | null;
  horizonDays?: number | null;
}

export function useSlotPages(transport: SchedulingTransport, query: SlotQuery | null): UseSlotPages {
  const [state, setState] = useState<SlotPagesState>(IDLE);
  // Every answer is checked against the latest request: a slow answer for the
  // service the customer just left must never overwrite the one they are on.
  const requestId = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const service = query?.service ?? undefined;
  const manage = query?.manage ?? undefined;
  const days = query?.days ?? 14;
  const active = query !== null && Boolean(service || manage);

  const fetchWindow = useCallback(
    (from: DateString | undefined) =>
      transport.slots({
        ...(service ? { service } : {}),
        ...(manage ? { manage } : {}),
        ...(from ? { from } : {}),
        days,
      }),
    [transport, service, manage, days],
  );

  const reset = useCallback(async () => {
    const id = ++requestId.current;
    setState({ ...IDLE, status: "loading" });
    const result = await fetchWindow(undefined);
    if (id !== requestId.current) return;
    setState(
      result.ok
        ? { ...IDLE, status: "ready", pages: [result.data] }
        : { ...IDLE, status: "error", error: result.error },
    );
  }, [fetchWindow]);

  useEffect(() => {
    if (active) void reset();
    else {
      requestId.current += 1;
      setState(IDLE);
    }
  }, [active, reset]);

  const later = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "ready" || current.loadingLater) return;
    if (current.index < current.pages.length - 1) {
      setState({ ...current, index: current.index + 1 });
      return;
    }
    const last = current.pages[current.pages.length - 1];
    if (!last || !last.to) return;
    const id = ++requestId.current;
    setState({ ...current, loadingLater: true, error: null });
    const result = await fetchWindow(addDays(last.to, 1));
    if (id !== requestId.current) return;
    setState((now) =>
      result.ok
        ? { ...now, pages: [...now.pages, result.data], index: now.pages.length, loadingLater: false }
        : { ...now, loadingLater: false, error: result.error },
    );
  }, [fetchWindow]);

  const earlier = useCallback(() => {
    setState((current) => (current.index > 0 ? { ...current, index: current.index - 1, error: null } : current));
  }, []);

  const refresh = useCallback(async () => {
    const current = stateRef.current;
    const page = current.pages[current.index];
    if (current.status !== "ready" || !page) {
      void reset();
      return;
    }
    const id = ++requestId.current;
    const index = current.index;
    setState({ ...current, refreshing: true });
    // The first window is asked for without `from`, exactly as the first time,
    // so the server keeps choosing where it starts.
    const result = await fetchWindow(index === 0 ? undefined : page.from);
    if (id !== requestId.current) return;
    setState((now) =>
      result.ok
        ? { ...now, pages: now.pages.map((p, i) => (i === index ? result.data : p)), refreshing: false, error: null }
        : { ...now, refreshing: false, error: result.error },
    );
  }, [fetchWindow, reset]);

  const page = state.pages[state.index] ?? null;
  const lastLoaded = state.pages[state.pages.length - 1] ?? null;
  const zone = query?.timeZone ?? page?.timeZone ?? "UTC";
  const horizonEnd = query?.horizonDays ? addDays(todayIn(zone), query.horizonDays) : null;
  const moreToLoad = Boolean(lastLoaded && lastLoaded.to && !lastLoaded.closed && (horizonEnd === null || lastLoaded.to < horizonEnd));

  return {
    ...state,
    page,
    canEarlier: state.index > 0,
    canLater: state.status === "ready" && (state.index < state.pages.length - 1 || moreToLoad),
    earlier,
    later: useCallback(() => void later(), [later]),
    refresh: useCallback(() => void refresh(), [refresh]),
    retry: useCallback(() => void reset(), [reset]),
  };
}

/** Date.now(), re-read every `intervalMs` while `active`. */
export function useNow(active: boolean, intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
