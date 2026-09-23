import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFeedback } from "./FeedbackContext.js";
import { AnnotationStage } from "./AnnotationStage.js";
import { useWidgetContainer } from "./hostLayers.js";
import { IconCheck, IconSend, IconX } from "./icons.js";
import type { FeedbackPriority } from "./types.js";

const PRIORITIES: Array<{ value: FeedbackPriority; label: string }> = [
  { value: "low", label: "Low — cosmetic or minor" },
  { value: "medium", label: "Medium — annoying but has a workaround" },
  { value: "high", label: "High — blocks part of my work" },
  { value: "critical", label: "Critical — I cannot work at all" },
];

const MIN_DESCRIPTION = 10;

/** "3m ago" / "2h ago" / "5d ago" — short enough for a list row. */
function ageOf(value: number | string): string {
  const then = typeof value === "number" ? value : new Date(value).getTime();
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The whole flow in one dialog: capture spinner → annotate → describe →
 * ticket number — and, since 0.2.0, the other direction: "My reports" lists
 * what this browser sent and each ticket's thread shows the team's replies,
 * because feedback someone answered and the reporter never saw is feedback
 * they stop sending. Renders nothing while closed; `data-aif-modal` is what
 * the screenshot filter excludes, so the modal never photographs itself.
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
          : feedback.step === "reports"
            ? "Everything you've sent from this browser"
            : feedback.step === "thread"
              ? (feedback.activeReport?.title ?? "Your report")
              : "Capturing your screen…";

  const modalTitle =
    feedback.step === "reports"
      ? "My reports"
      : feedback.step === "thread"
        ? `Ticket ${feedback.activeReport?.ticketNumber ?? ""}`
        : "Send feedback";

  // The report flow advertises the list only once there is something in it;
  // the thread view offers the way back instead.
  const showMyReports =
    feedback.step !== "reports" &&
    feedback.step !== "thread" &&
    feedback.reports.length > 0;

  return (
    <ModalSurface label={modalTitle} onClose={feedback.closeFeedback} focusKey={feedback.step}>
      <div className="aif-modal">
        <div className="aif-modal-header">
          <div>
            <div className="aif-modal-title">{modalTitle}</div>
            <div className="aif-modal-sub">{stepTitle}</div>
          </div>
          <div className="aif-header-actions">
            {showMyReports ? (
              <button type="button" className="aif-btn aif-btn-ghost" onClick={feedback.openReports}>
                My reports ({feedback.reports.length})
              </button>
            ) : null}
            {feedback.step === "thread" ? (
              <button type="button" className="aif-btn aif-btn-ghost" onClick={feedback.backToReports}>
                ← My reports
              </button>
            ) : null}
            <button
              type="button"
              className="aif-icon-btn"
              aria-label="Close"
              onClick={feedback.closeFeedback}
            >
              <IconX />
            </button>
          </div>
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

          {feedback.step === "success" ? <SuccessStep /> : null}

          {feedback.step === "reports" ? <ReportsStep /> : null}

          {feedback.step === "thread" ? <ThreadStep /> : null}
        </div>
      </div>
    </ModalSurface>
  );
}

/**
 * Events that never leave the feedback modal. Host UI libraries listen for
 * these on `document` to decide a press or focus happened "outside" their open
 * layer (and dismiss it), or to cancel scrolling outside it (scroll locks). They
 * stop at the modal's own container — the widget's handlers still run, because
 * React listens on that same container (see `useWidgetContainer`).
 *
 * Stopping them there, rather than cancelling the host's dismiss event, matters:
 * Radix defers an outside press to the `click`, and by then a press that changed
 * the step has already removed the pressed button from the DOM — a dismiss event
 * dispatched on a detached node never passes through the modal to be cancelled.
 * `click`/`touchend` (and the up events) are here for click-away listeners — MUI's
 * ClickAwayListener dismisses on a document `click` by default.
 */
const CONTAINED_EVENTS = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "touchstart",
  "touchend",
  "focusin",
  "wheel",
  "touchmove",
] as const;

/** An Escape that belongs to an IME (closing a candidate list), not the page. */
function isComposingEscape(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * The modal shell: a native `<dialog>` opened with `showModal()`, in a
 * widget-owned container at the top of `<body>`. Built to be used WHILE a host
 * modal is open, because that is when a report about a modal gets written:
 *
 * - Top layer: above every z-index, and above a host `<dialog>` opened before it
 *   — the feedback form can never sit behind the thing being reported.
 * - Everything outside it goes inert, so a host modal's focus trap cannot pull
 *   focus back out of the form mid-sentence.
 * - A fresh `<body>` child, so a host modal's `aria-hidden` on the app root
 *   (applied when IT opened) never hides this one from screen readers.
 * - Presses, focus and scrolling inside it stay inside it (CONTAINED_EVENTS), so
 *   they never dismiss the host's layer or hit its scroll lock.
 * - Escape is the reporter's: it closes the feedback modal — from inside it, or
 *   when focus has fallen to `<body>` (a step change unmounts the focused
 *   button). It is marked handled on the way in (window, capture phase) so
 *   libraries that skip a defaultPrevented Escape — Radix, Headless UI, Zag —
 *   leave their modal open, and it stops at the container on the way out so
 *   bubble-phase listeners (focus-trap) never see it. Anything inside that
 *   handles Escape itself (the annotation text box) stops it, and the modal
 *   stays. An IME's Escape is left alone.
 * - Showing it hides any host `popover="auto"` (the platform does that for every
 *   modal dialog); the popover was already captured, and is gone when the
 *   reporter returns — a documented cost of the top layer.
 */
function ModalSurface({
  label,
  onClose,
  focusKey,
  children,
}: {
  label: string;
  onClose: () => void;
  /** Changes when the step changes — focus is pulled back into the dialog. */
  focusKey: string;
  children: ReactNode;
}) {
  const container = useWidgetContainer(CONTAINED_EVENTS);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!container) return undefined;
    const claimEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isComposingEscape(event)) return;
      event.preventDefault();
      // Focus outside the dialog (usually <body>, after a step change): nothing
      // inside will see this Escape, so close from here.
      if (!(event.target instanceof Node) || !container.contains(event.target)) onCloseRef.current();
    };
    const keepEscapeHere = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.stopPropagation();
    };
    window.addEventListener("keydown", claimEscape, true);
    container.addEventListener("keydown", keepEscapeHere);
    return () => {
      window.removeEventListener("keydown", claimEscape, true);
      container.removeEventListener("keydown", keepEscapeHere);
    };
  }, [container]);

  if (!container) return null;
  return createPortal(
    <TopLayerDialog label={label} onClose={onClose} focusKey={focusKey}>
      {children}
    </TopLayerDialog>,
    container,
  );
}

/** The `<dialog>` itself; mounted only once its container is in the document. */
function TopLayerDialog({
  label,
  onClose,
  focusKey,
  children,
}: {
  label: string;
  onClose: () => void;
  focusKey: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    // Where the reporter was — inside the host modal, usually. Handed back
    // explicitly on close: by the time this cleanup runs the container may
    // already be detached, and a detached dialog's close() restores nothing.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    }
    return () => {
      if (dialog.open) {
        try {
          dialog.close();
        } catch {
          /* already detached */
        }
      }
      if (previous?.isConnected && previous !== document.body) {
        try {
          previous.focus({ preventScroll: true });
        } catch {
          /* not focusable any more */
        }
      }
    };
  }, []);

  // A step change unmounts whatever had focus; pull it back into the dialog so
  // keyboard users keep their place and Escape keeps working.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const active = document.activeElement;
    if (!active || active === document.body || !dialog.contains(active)) {
      dialog.focus({ preventScroll: true });
    }
  }, [focusKey]);

  return (
    <dialog
      ref={dialogRef}
      className="aif-root aif-overlay"
      data-aif-modal
      aria-label={label}
      tabIndex={-1}
      // The platform may close the dialog itself — a mobile back gesture is a
      // close request, and after one refused request the next cannot be
      // refused. Treat it as the reporter closing the form; otherwise React
      // still believes it is open, the button does nothing, and the Escape
      // claim stays installed for the rest of the session.
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      onClose={() => onCloseRef.current()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isComposingEscape(event.nativeEvent)) onClose();
      }}
    >
      {children}
    </dialog>
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

function SuccessStep() {
  const feedback = useFeedback();
  // Saved only when the platform issued a follow-up token, so this offer is
  // never made against a platform that cannot honour it.
  const followable = feedback.reports.some(
    (report) => report.ticketNumber === feedback.ticketNumber,
  );

  return (
    <div className="aif-success">
      <div className="aif-success-badge">
        <IconCheck />
      </div>
      <div className="aif-ticket-number">Ticket {feedback.ticketNumber}</div>
      <div>Thanks — your report and its context are on their way.</div>
      {followable ? (
        <div className="aif-context-note">
          When the team answers, their reply appears under My reports — right here, no email
          needed.
        </div>
      ) : null}
      <div className="aif-success-actions">
        {followable ? (
          <button type="button" className="aif-btn aif-btn-ghost" onClick={feedback.openReports}>
            My reports
          </button>
        ) : null}
        <button type="button" className="aif-btn aif-btn-primary" onClick={feedback.closeFeedback}>
          Done
        </button>
      </div>
    </div>
  );
}

function ReportsStep() {
  const feedback = useFeedback();

  if (feedback.reports.length === 0) {
    return (
      <div className="aif-capture">
        <div>Reports you send from this browser appear here, with the team's replies.</div>
      </div>
    );
  }

  return (
    <div className="aif-reports">
      {feedback.reports.map((report) => (
        <button
          type="button"
          key={report.ticketNumber}
          className="aif-report-row"
          onClick={() => void feedback.openThread(report)}
        >
          <span className="aif-report-number">{report.ticketNumber}</span>
          <span className="aif-report-title">{report.title}</span>
          <span className="aif-report-age">{ageOf(report.createdAt)}</span>
        </button>
      ))}
      <div className="aif-context-note">
        This list lives in your browser. Clearing site data forgets it; the reports themselves
        are safe with the team either way.
      </div>
    </div>
  );
}

function ThreadStep() {
  const feedback = useFeedback();
  const [reply, setReply] = useState("");

  if (feedback.threadLoading) {
    return (
      <div className="aif-capture">
        <div className="aif-spinner" aria-hidden />
        <div>Loading the conversation…</div>
      </div>
    );
  }

  if (feedback.threadError && !feedback.thread) {
    return (
      <div className="aif-form">
        <div className="aif-error">{feedback.threadError}</div>
        <button type="button" className="aif-btn aif-btn-ghost" onClick={feedback.backToReports}>
          Back to my reports
        </button>
      </div>
    );
  }

  const thread = feedback.thread;
  if (!thread) return null;

  const canSend = reply.trim().length > 0 && !feedback.isReplying;

  return (
    <div className="aif-thread">
      <div className="aif-thread-head">
        <span className="aif-status-chip">{thread.ticket.statusLabel}</span>
        <span className="aif-context-note">reported {ageOf(thread.ticket.createdAt)}</span>
      </div>

      {feedback.threadError ? <div className="aif-error">{feedback.threadError}</div> : null}

      <div className="aif-thread-msgs">
        {thread.messages.length === 0 ? (
          <div className="aif-context-note">
            No replies yet — when the team answers, it shows up right here.
          </div>
        ) : (
          thread.messages.map((message) => (
            <div
              key={message.id}
              className={`aif-msg ${message.senderType === "reporter" ? "aif-msg-mine" : "aif-msg-team"}`}
            >
              <div className="aif-msg-meta">
                <span>{message.senderType === "reporter" ? "You" : message.senderName}</span>
                <span>{ageOf(message.createdAt)}</span>
              </div>
              <div className="aif-msg-body">{message.body}</div>
            </div>
          ))
        )}
      </div>

      <div className="aif-reply-row">
        <textarea
          className="aif-textarea aif-reply-input"
          placeholder="Write a reply…"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
        />
        <button
          type="button"
          className="aif-btn aif-btn-primary"
          disabled={!canSend}
          onClick={() => {
            void feedback.sendReply(reply.trim()).then((sent) => {
              if (sent) setReply("");
            });
          }}
        >
          <IconSend />
          {feedback.isReplying ? "Sending…" : "Reply"}
        </button>
      </div>
    </div>
  );
}
