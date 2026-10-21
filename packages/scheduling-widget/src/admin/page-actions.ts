import { useEffect, useRef, useState } from "react";

/**
 * A SCREEN'S BUTTONS IN ITS HOST PAGE'S HEADER (polish 3).
 *
 * Every work page puts its primary action on the right of its own title —
 * the page header — but the screen below the header owns what that button
 * does ("New invoice" opens the screen's own form). So the page renders the
 * screen's companion (<InvoicesLedgerActions>) in its header, and the screen,
 * given `actionsInHeader`, draws no button of its own. The two halves talk
 * through three DOM events on `window`:
 *
 *   header → screen   `${prefix}:page-action`        { action }  a button was pressed
 *   screen → header   `${prefix}:page-action-state`  { [action]: { disabled, busy, hidden } }
 *   header → screen   `${prefix}:page-action-hello`             "I'm here: send me the state"
 *
 * Events, not React context: on a server-rendered page the header and the
 * screen are separate client islands with no shared parent, and a host that
 * bundles this package twice still has one `window`. Whichever half mounts
 * first, the other catches up (the screen announces its state when it
 * mounts; the header asks when it mounts).
 *
 * COPIED into each widget that hands its buttons to the page (invoicing,
 * estimator, scheduling, customers, feedback); change all or none.
 */

export interface PageActionState {
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly hidden?: boolean;
}

export type PageActionStates<A extends string> = Partial<Record<A, PageActionState>>;

export interface PageActionChannel<A extends string> {
  /** The screen's half: run `on(action)` when a header button is pressed, and keep the header told each button's state. */
  useScreen(enabled: boolean, on: (action: A) => void, state: PageActionStates<A>): void;
  /** The header's half: each button's state, and `press(action)`. */
  useHeader(): { readonly state: PageActionStates<A>; readonly press: (action: A) => void };
}

function send(name: string, detail?: unknown): void {
  if (typeof window === "undefined" || typeof CustomEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function pageActionChannel<A extends string>(prefix: string): PageActionChannel<A> {
  const ACTION = `${prefix}:page-action`;
  const STATE = `${prefix}:page-action-state`;
  const HELLO = `${prefix}:page-action-hello`;
  return {
    useScreen(enabled, on, state) {
      const latest = useRef(on);
      latest.current = on;
      const json = JSON.stringify(state);
      useEffect(() => {
        if (!enabled || typeof window === "undefined") return;
        const announce = () => send(STATE, JSON.parse(json) as unknown);
        const onAction = (event: Event) => {
          const action = (event as CustomEvent<{ action?: A } | undefined>).detail?.action;
          if (typeof action === "string") latest.current(action);
        };
        window.addEventListener(ACTION, onAction);
        window.addEventListener(HELLO, announce);
        announce();
        return () => {
          window.removeEventListener(ACTION, onAction);
          window.removeEventListener(HELLO, announce);
        };
      }, [enabled, json]);
    },
    useHeader() {
      const [state, setState] = useState<PageActionStates<A>>({});
      useEffect(() => {
        if (typeof window === "undefined") return;
        const onState = (event: Event) => {
          const detail = (event as CustomEvent<unknown>).detail;
          setState(detail && typeof detail === "object" ? (detail as PageActionStates<A>) : {});
        };
        window.addEventListener(STATE, onState);
        send(HELLO);
        return () => window.removeEventListener(STATE, onState);
      }, []);
      return { state, press: (action: A) => send(ACTION, { action }) };
    },
  };
}
