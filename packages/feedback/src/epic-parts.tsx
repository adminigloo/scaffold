import type { ReactElement } from "react";
import { EPIC_BUCKET_LABELS, EPIC_STATUS_LABELS, epicColorOf, progressWords, type EpicProgress, type EpicStatus } from "./epic-core";

/**
 * The small epic pieces both client entries draw (0.12.0): the badge — on a
 * board card, in the ticket panel, in the epics list — and the progress bar.
 * Ask Lou had an EpicBadge component and never rendered it anywhere; here the
 * board card shows its epic.
 */

export interface EpicBadgeProps {
  name: string;
  /** One of EPIC_COLORS' names; an unknown one draws grey. */
  color?: string | null;
  /** Shown after the name when the epic is finished or archived ("Checkout · completed"). */
  status?: EpicStatus | null;
}

export function EpicBadge({ name, color, status }: EpicBadgeProps): ReactElement {
  const finished = status === "completed" || status === "archived";
  return (
    <span className="aib-epic-badge" title={`Epic: ${name}${finished ? ` (${EPIC_STATUS_LABELS[status!].toLowerCase()})` : ""}`}>
      <span className="aib-epic-dot" aria-hidden="true" style={{ background: epicColorOf(color) }} />
      <span className="aib-epic-badge-text">
        <span className="aib-sr">Epic: </span>
        {name}
        {finished ? ` · ${EPIC_STATUS_LABELS[status!].toLowerCase()}` : ""}
      </span>
    </span>
  );
}

export interface EpicProgressBarProps {
  progress: EpicProgress;
  /** Show the key under the bar (done / in progress / waiting / not started, with counts). Default false. */
  showKey?: boolean;
}

function width(n: number, total: number): string {
  return total === 0 ? "0%" : `${(n * 100) / total}%`;
}

/**
 * Done, in progress and waiting as one stacked bar over the not-started
 * track, with its words ("3 of 8 done (37%)") — a screen reader hears the
 * words and the counts, never a picture.
 */
export function EpicProgressBar({ progress, showKey = false }: EpicProgressBarProps): ReactElement {
  const words = progressWords(progress);
  const parts = [
    { key: "done", label: EPIC_BUCKET_LABELS.done, n: progress.done, className: "aib-seg-done" },
    { key: "doing", label: EPIC_BUCKET_LABELS.in_progress, n: progress.inProgress, className: "aib-seg-doing" },
    { key: "waiting", label: EPIC_BUCKET_LABELS.waiting, n: progress.waiting, className: "aib-seg-waiting" },
  ];
  const detail = `${progress.done} done, ${progress.inProgress} in progress, ${progress.waiting} waiting, ${progress.open} not started`;
  return (
    <div className="aib-progress">
      <div
        className="aib-progress-bar"
        role="img"
        aria-label={progress.total === 0 ? words : `${words}: ${detail}`}
      >
        {parts.map((part) =>
          part.n > 0 ? (
            <span
              key={part.key}
              className={`aib-progress-seg ${part.className}`}
              style={{ width: width(part.n, progress.total) }}
              title={`${part.label}: ${part.n}`}
            />
          ) : null,
        )}
      </div>
      <span className="aib-progress-words" aria-hidden="true">
        {words}
      </span>
      {showKey && progress.total > 0 ? (
        <ul className="aib-progress-key" aria-label="What the bar shows">
          <li>
            <span className="aib-key-swatch aib-seg-done" aria-hidden="true" />
            {progress.done} done
          </li>
          <li>
            <span className="aib-key-swatch aib-seg-doing" aria-hidden="true" />
            {progress.inProgress} in progress
          </li>
          <li>
            <span className="aib-key-swatch aib-seg-waiting" aria-hidden="true" />
            {progress.waiting} waiting
          </li>
          <li>
            <span className="aib-key-swatch aib-key-open" aria-hidden="true" />
            {progress.open} not started
          </li>
        </ul>
      ) : null}
    </div>
  );
}

/** The status as a pill: "Not started", "In progress", "Completed", "Archived". */
export function EpicStatusPill({ status }: { status: EpicStatus }): ReactElement {
  return <span className={`aib-status-pill aib-status-${status}`}>{EPIC_STATUS_LABELS[status] ?? status}</span>;
}
