import { useFeedback } from "./FeedbackContext.js";
import { AnnotationStage } from "./AnnotationStage.js";
import { IconCheck, IconSend, IconX } from "./icons.js";
import type { FeedbackPriority } from "./types.js";

const PRIORITIES: Array<{ value: FeedbackPriority; label: string }> = [
  { value: "low", label: "Low — cosmetic or minor" },
  { value: "medium", label: "Medium — annoying but has a workaround" },
  { value: "high", label: "High — blocks part of my work" },
  { value: "critical", label: "Critical — I cannot work at all" },
];

const MIN_DESCRIPTION = 10;

/**
 * The whole flow in one dialog: capture spinner → annotate → describe →
 * ticket number. Renders nothing while closed; `data-aif-modal` is what the
 * screenshot filter excludes, so the modal never photographs itself.
 */
export function FeedbackModal() {
  const feedback = useFeedback();
  if (!feedback.isOpen) return null;

  const stepTitle =
    feedback.step === "annotate"
      ? "Mark up the screenshot"
      : feedback.step === "describe"
        ? "Describe what happened"
        : feedback.step === "success"
          ? "Feedback sent"
          : "Capturing your screen…";

  return (
    <div className="aif-root aif-overlay" data-aif-modal role="presentation">
      <div className="aif-modal" role="dialog" aria-modal="true" aria-label="Send feedback">
        <div className="aif-modal-header">
          <div>
            <div className="aif-modal-title">Send feedback</div>
            <div className="aif-modal-sub">{stepTitle}</div>
          </div>
          <button
            type="button"
            className="aif-icon-btn"
            aria-label="Close"
            onClick={feedback.closeFeedback}
          >
            <IconX />
          </button>
        </div>

        <div className="aif-modal-body">
          {feedback.step === "capture" ? (
            <div className="aif-capture">
              <div className="aif-spinner" aria-hidden />
              <div>Taking a screenshot of what you see…</div>
            </div>
          ) : null}

          {feedback.step === "annotate" && feedback.screenshot ? (
            <AnnotationStage
              screenshot={feedback.screenshot}
              onDone={feedback.finishAnnotating}
              onSkip={() => feedback.finishAnnotating(null)}
            />
          ) : null}

          {feedback.step === "describe" ? <DescribeStep /> : null}

          {feedback.step === "success" ? (
            <div className="aif-success">
              <div className="aif-success-badge">
                <IconCheck />
              </div>
              <div className="aif-ticket-number">Ticket {feedback.ticketNumber}</div>
              <div>Thanks — your report and its context are on their way.</div>
              <button type="button" className="aif-btn aif-btn-primary" onClick={feedback.closeFeedback}>
                Done
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DescribeStep() {
  const feedback = useFeedback();
  const preview = feedback.annotatedDataUrl ?? feedback.screenshot?.dataUrl ?? null;
  const tooShort = feedback.description.trim().length < MIN_DESCRIPTION;

  return (
    <div className="aif-form">
      {feedback.submitError ? <div className="aif-error">{feedback.submitError}</div> : null}

      <div className="aif-field">
        <label className="aif-label" htmlFor="aif-description">
          What happened?
        </label>
        <textarea
          id="aif-description"
          className="aif-textarea"
          placeholder="What did you expect, and what happened instead? The more specific, the faster the fix."
          value={feedback.description}
          onChange={(event) => feedback.setDescription(event.target.value)}
        />
      </div>

      <div className="aif-row">
        <div className="aif-field">
          <label className="aif-label" htmlFor="aif-priority">
            Priority
          </label>
          <select
            id="aif-priority"
            className="aif-select"
            value={feedback.priority}
            onChange={(event) => feedback.setPriority(event.target.value as FeedbackPriority)}
          >
            {PRIORITIES.map((priority) => (
              <option key={priority.value} value={priority.value}>
                {priority.label}
              </option>
            ))}
          </select>
        </div>
        <div className="aif-field">
          <label className="aif-label" htmlFor="aif-category">
            Category
          </label>
          <select
            id="aif-category"
            className="aif-select"
            value={feedback.category}
            onChange={(event) => feedback.setCategory(event.target.value)}
          >
            {feedback.categories.map((category) => (
              <option key={category.key} value={category.key}>
                {category.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {preview ? (
        <div className="aif-field">
          <span className="aif-label">Screenshot</span>
          <div className="aif-thumb">
            <img src={preview} alt="Screenshot preview" />
          </div>
        </div>
      ) : null}

      <div className="aif-context-note">
        Your report includes your recent clicks and any browser errors from this session, so the
        team can reproduce the problem without asking you for steps.
      </div>

      <div className="aif-modal-footer" style={{ padding: "4px 0 0", borderTop: "none" }}>
        <span className="aif-context-note">
          {tooShort ? `At least ${MIN_DESCRIPTION} characters` : ""}
        </span>
        <button
          type="button"
          className="aif-btn aif-btn-primary"
          disabled={tooShort || feedback.isSubmitting}
          onClick={() => void feedback.submit()}
        >
          <IconSend />
          {feedback.isSubmitting ? "Sending…" : "Send feedback"}
        </button>
      </div>
    </div>
  );
}
