import { useEffect } from "react";
import { useFeedback } from "./FeedbackContext.js";
import { IconMegaphone } from "./icons.js";

/**
 * The form's way in ON a page (0.4.0), where `<FeedbackButton>` floats in a
 * corner: a "Send feedback" button and "My reports (N)", inline where the
 * page puts them — for a page whose whole purpose is the form, like a
 * company's public feedback page. Render `<FeedbackModal />` beside it.
 *
 * A closed form (the company takes no new reports right now) says why
 * instead of offering "Send feedback", and still offers "My reports": a
 * reporter can read and answer what they already sent.
 */
export function FeedbackLauncher({
  sendLabel = "Send feedback",
  reportsLabel = "My reports",
}: {
  readonly sendLabel?: string;
  readonly reportsLabel?: string;
}) {
  const feedback = useFeedback();
  const { prepare } = feedback;
  useEffect(() => {
    void prepare();
  }, [prepare]);

  return (
    <div className="aif-root aif-launcher" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      {feedback.closedMessage ? (
        <p className="aif-context-note" role="status" style={{ flexBasis: "100%" }}>
          {feedback.closedMessage}
        </p>
      ) : (
        <button type="button" className="aif-btn aif-btn-primary" aria-busy={feedback.isCapturing || undefined} onClick={() => void feedback.openFeedback()}>
          <IconMegaphone />
          {sendLabel}
        </button>
      )}
      <button type="button" className="aif-btn aif-btn-ghost" onClick={feedback.openReports}>
        {reportsLabel}
        {feedback.reports.length > 0 ? ` (${feedback.reports.length})` : ""}
      </button>
    </div>
  );
}
