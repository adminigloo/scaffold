import { useFeedback } from "./FeedbackContext.js";
import { IconMegaphone } from "./icons.js";

/**
 * The floating trigger. `data-aif-button` keeps its own clicks out of the
 * click trail; the capture filter hides it from screenshots via the modal
 * being open by the time capture runs.
 */
export function FeedbackButton({ label = "Feedback" }: { label?: string }) {
  const feedback = useFeedback();
  return (
    <span className="aif-root" data-aif-button>
      <button type="button" className="aif-fab" onClick={() => void feedback.openFeedback()}>
        <IconMegaphone />
        {label}
      </button>
    </span>
  );
}
