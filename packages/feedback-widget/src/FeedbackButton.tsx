import { createPortal } from "react-dom";
import { useFeedback } from "./FeedbackContext.js";
import { useWidgetContainer } from "./hostLayers.js";
import { IconMegaphone } from "./icons.js";

/**
 * A press on the button never reaches the host's "outside press" listeners on
 * `document` (see hostLayers.ts) — down, up and click alike, because click-away
 * listeners (MUI's ClickAwayListener) dismiss on the `click`.
 */
const CONTAINED_EVENTS = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "touchstart",
  "touchend",
] as const;

/**
 * The floating trigger. `data-aif-button` keeps its own clicks out of the
 * click trail and the button out of every screenshot.
 *
 * It must work OVER an open host modal — that is exactly when someone needs to
 * report one — so it lives in its own container at the top of `<body>` (not
 * inside the app tree a host modal makes inert), its presses stay there, and it
 * never moves focus out of the host modal (mousedown's default is what focuses a
 * button; focus leaving a modal is itself a dismissal signal to some libraries).
 * While the open layers are being captured — before the modal can open — it
 * says so, so the click never looks dead.
 * Rendered after mount: there is no `<body>` to portal into on the server.
 */
export function FeedbackButton({ label = "Feedback" }: { label?: string }) {
  const feedback = useFeedback();
  const container = useWidgetContainer(CONTAINED_EVENTS);
  if (!container) return null;

  return createPortal(
    <span className="aif-root" data-aif-button>
      <button
        type="button"
        className="aif-fab"
        aria-busy={feedback.isCapturing || undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void feedback.openFeedback()}
      >
        <IconMegaphone />
        {feedback.isCapturing ? "Capturing…" : label}
      </button>
    </span>,
    container,
  );
}
