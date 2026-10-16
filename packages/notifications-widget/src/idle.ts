/**
 * The bell's poll, with an idle backoff (Tenancy 2b-1, section 5; review
 * BO-25).
 *
 * The count is fetched on mount, every `pollMs` (default 60 s) while the page
 * is visible, and again at once on focus and on becoming visible (Ask Lou's
 * bubble, without the drift: each wait starts after the last fetch).
 *
 * An office PC left on the schedule all day would otherwise ask sixty times
 * an hour for a badge nobody is looking at. So after 15 minutes with no
 * pointer or keyboard input the poll slows to every 10 minutes; the first
 * input, a focus or becoming visible fetches at once and returns to `pollMs`.
 * Six requests an hour, not sixty.
 *
 * Pure scheduling: the caller passes `tick` (the fetch) and the clock and
 * timers come from the platform, so a test drives it with fake timers.
 */

export const IDLE_AFTER_MS = 15 * 60 * 1000;
export const IDLE_POLL_MS = 10 * 60 * 1000;

export interface PollerOptions {
  /** The fetch. Its promise is awaited before the next wait starts. */
  readonly tick: () => Promise<void> | void;
  /** ms between fetches while someone is using the page. 0: no background poll (focus and visibility still fetch). */
  readonly pollMs: number;
  readonly idleAfterMs?: number;
  readonly idlePollMs?: number;
}

export interface Poller {
  /** Stop for good (unmount, or a 401/403 answer). */
  stop(): void;
  /** Fetch now and restart the wait (e.g. after the person acted). */
  now(): void;
}

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

export function startPoller(options: PollerOptions): Poller {
  const idleAfter = options.idleAfterMs ?? IDLE_AFTER_MS;
  const idlePoll = options.idlePollMs ?? IDLE_POLL_MS;
  const hasDocument = typeof document !== "undefined";
  const hasWindow = typeof window !== "undefined";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastInput = Date.now();
  let idleWait = false;
  let running = false;

  const visible = () => !hasDocument || document.visibilityState === "visible";

  const schedule = () => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (options.pollMs <= 0) return;
    idleWait = Date.now() - lastInput >= idleAfter;
    timer = setTimeout(run, idleWait ? idlePoll : options.pollMs);
  };

  async function run() {
    timer = undefined;
    if (stopped) return;
    if (running) return schedule();
    // Only while the page is visible: a hidden tab waits for visibilitychange.
    if (!visible()) return schedule();
    running = true;
    try {
      await options.tick();
    } catch {
      /* the tick reports its own failures */
    } finally {
      running = false;
    }
    schedule();
  }

  const wake = () => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    void run();
  };

  const onInput = () => {
    lastInput = Date.now();
    // The first input while the poll is on its idle wait fetches at once and
    // returns to pollMs; any other input only moves the idle clock.
    if (idleWait) wake();
  };
  const onFocus = () => {
    lastInput = Date.now();
    wake();
  };
  const onVisibility = () => {
    if (visible()) {
      lastInput = Date.now();
      wake();
    }
  };

  if (hasWindow) {
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true });
    window.addEventListener("focus", onFocus);
  }
  if (hasDocument) document.addEventListener("visibilitychange", onVisibility);

  void run();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (hasWindow) {
        for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput);
        window.removeEventListener("focus", onFocus);
      }
      if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
    },
    now: wake,
  };
}
