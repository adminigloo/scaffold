import { useEffect, useLayoutEffect, useState } from "react";

/**
 * Living alongside the host app's own modals.
 *
 * Feedback about a modal needs the modal to still be there. The sibling project
 * (Riddler Go) found three ways a host's modal broke the report in live use —
 * the button was unclickable over it, pressing the button dismissed it, and the
 * feedback form sat behind it — and fixed them by editing its own Dialog
 * primitive. A package cannot edit a buyer's Dialog, so the widget carries the
 * fix itself, whatever library the buyer's modals come from:
 *
 * - The button and the modal each live in a WIDGET-OWNED container, a direct
 *   child of `<body>` (`useWidgetContainer`). Headless UI makes only the app's
 *   own body child inert and ignores presses in every other body child, so the
 *   button stays pressable over a Headless UI dialog; and it escapes any host
 *   ancestor with a transform (which would re-anchor `position: fixed`).
 * - The container stops the events host libraries listen for on `document` to
 *   decide "outside press / outside focus / scroll outside" — down, up and
 *   click, focus, wheel/touch — AFTER React, which listens on the same
 *   container, has run the widget's own handlers. Radix (every shadcn
 *   Dialog/Sheet/Popover), MUI (FocusTrap, ClickAwayListener's document
 *   `click`), react-focus-lock and react-remove-scroll all listen in the bubble
 *   phase, so they never see a press, a focus or a wheel inside the widget.
 * - Markers other libraries honour: `data-react-aria-top-layer="true"` (react-aria
 *   would otherwise make a body child appended while its modal is open inert —
 *   with our top-layer dialog that locks the whole page) and `data-no-focus-lock`
 *   (react-focus-lock, Chakra v2).
 * - `pointer-events: auto` on the button and the modal (styles.ts), because a
 *   Radix modal sets `pointer-events: none` on `<body>` while it is open.
 * - The feedback modal is a native `<dialog>` opened with `showModal()`
 *   (FeedbackModal.tsx): the browser top layer sits above every z-index and above
 *   a host `<dialog>`, and everything else goes inert — so any host focus trap's
 *   "focus back inside" call lands on an inert element and does nothing.
 *
 * NOT reachable zero-config (they listen on `document` in the CAPTURE phase and
 * cancel or dismiss before any widget code runs): the `focus-trap` library with
 * default options, and Zag/Ark UI (Chakra v3). Hosts on those pass
 * `isFeedbackWidgetTarget` to their outside-click option. A host NATIVE modal
 * `<dialog>` makes the floating button inert (by spec, nothing outside the top
 * modal can be clicked) — Ctrl+Shift+B still works there.
 */

/** Attributes every widget container carries from the moment it is created. */
const CONTAINER_ATTRIBUTES: Record<string, string> = {
  "data-aif-portal": "",
  "data-feedback-ui": "",
  "data-react-aria-top-layer": "true",
  "data-no-focus-lock": "",
};

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A widget-owned direct child of `<body>` to portal into, with `contained` events
 * stopped at it (the widget's own React handlers still run: React listens on
 * every portal container, and stopPropagation does not stop listeners on the same
 * node). Null until mounted — on the server and on the first client render.
 */
export function useWidgetContainer(contained: readonly string[]): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const key = contained.join(",");
  useIsomorphicLayoutEffect(() => {
    const div = document.createElement("div");
    for (const [name, value] of Object.entries(CONTAINER_ATTRIBUTES)) div.setAttribute(name, value);
    const types = key.split(",").filter(Boolean);
    const contain = (event: Event) => event.stopPropagation();
    for (const type of types) div.addEventListener(type, contain);
    const releaseGuard = guardAgainstHostDismissal(div);
    document.body.appendChild(div);
    setContainer(div);
    return () => {
      for (const type of types) div.removeEventListener(type, contain);
      releaseGuard();
      div.remove();
      setContainer(null);
    };
  }, [key]);
  return container;
}

/**
 * Radix's DismissableLayer decides "outside press / outside focus → dismiss" by
 * dispatching these cancelable events on the element that was pressed or
 * focused, and dismisses only if nobody cancelled them. They do not bubble, but
 * every event travels the CAPTURE phase, so a capture listener on the widget's
 * container cancels any that start inside it — a second line behind the
 * container stopping the press itself.
 */
const HOST_DISMISS_EVENTS = [
  "dismissableLayer.pointerDownOutside",
  "dismissableLayer.focusOutside",
] as const;

const cancel = (event: Event) => event.preventDefault();

/** Keep interactions inside `root` from dismissing the host's open layers. */
export function guardAgainstHostDismissal(root: HTMLElement): () => void {
  for (const name of HOST_DISMISS_EVENTS) root.addEventListener(name, cancel, true);
  return () => {
    for (const name of HOST_DISMISS_EVENTS) root.removeEventListener(name, cancel, true);
  };
}

/**
 * For hosts whose modal library cannot be reached zero-config (focus-trap,
 * Zag/Ark, a hand-rolled modal): call this from your dialog's outside-click
 * handler and ignore the event when it is true, so reporting a modal does not
 * close it.
 *
 * ```ts
 * createFocusTrap(el, { allowOutsideClick: (e) => isFeedbackWidgetTarget(e.target) });
 * ```
 */
export function isFeedbackWidgetTarget(target: EventTarget | null): boolean {
  return typeof Element !== "undefined" && target instanceof Element && target.closest("[data-feedback-ui]") !== null;
}
