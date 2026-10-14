import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { brandStyle, injectSchedulingStyles, normalizeHex } from "./styles.js";
import { useHostTheme, useStyles, type ThemeChoice } from "./theme.js";
import { formatClock, formatDayTile, formatLongDate, groupByPartOfDay } from "./time.js";
import type { DateString, PublicSlot } from "./types.js";

/**
 * The presentational pieces every component is built from. Props in, markup
 * out, no fetching — which is also what lets the tests render them to a
 * string and assert on the words a customer actually reads.
 */

// ---------------------------------------------------------------------------
// The root every component renders
// ---------------------------------------------------------------------------

export interface ChromeProps {
  /** "auto" (default) follows the host page, then the OS; "light" / "dark" pin it. */
  theme?: ThemeChoice;
  /** A CSP nonce for the injected <style> tag(s). */
  nonce?: string;
  className?: string;
  style?: CSSProperties;
  /** Formatting locale for dates and times. Default "en-US" (the copy is English). */
  locale?: string;
}

/**
 * The widget root: injects the stylesheet(s) once, reads the host's theme and
 * writes it as `data-theme`. `extraStyles` is how the admin entry adds its
 * own sheet without the public entry ever importing it.
 */
export function WidgetRoot({
  theme = "auto",
  nonce,
  className,
  style,
  extraClass,
  extraStyles,
  children,
  data,
  accent,
}: {
  theme?: ThemeChoice;
  nonce?: string;
  className?: string;
  style?: CSSProperties;
  extraClass?: string;
  extraStyles?: (nonce?: string) => void;
  children: ReactNode;
  /** `data-*` attributes for the root (tests and host CSS hooks). */
  data?: Record<string, string | undefined>;
  /**
   * The business's own colour (Tenancy 2a): a `#rrggbb` brands the root
   * (`data-brand` and both themes' accent tokens inline); null or anything
   * else keeps the stylesheet's accent.
   */
  accent?: string | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inject = useCallback(() => {
    injectSchedulingStyles(nonce ? { nonce } : {});
    extraStyles?.(nonce);
  }, [nonce, extraStyles]);
  useStyles(inject);
  const resolved = useHostTheme(ref, theme);
  const colour = normalizeHex(accent);
  const dataAttrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) if (value !== undefined) dataAttrs[`data-${key}`] = value;
  return (
    <div
      ref={ref}
      className={`aisw-root${extraClass ? ` ${extraClass}` : ""}${className ? ` ${className}` : ""}`}
      style={colour ? ({ ...brandStyle(colour), ...(style ?? {}) } as CSSProperties) : style}
      data-theme={resolved}
      {...(colour ? { "data-brand": "" } : {})}
      {...dataAttrs}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

/**
 * A ref for each step's heading (with tabIndex={-1}); focus moves to it
 * whenever `step` CHANGES — never on mount, so the widget doesn't steal focus
 * from the page it loads into. Compared against the previous value rather
 * than a "first run" flag, because StrictMode runs mount effects twice.
 * (booking-widget's useStepFocus, copied.)
 */
export function useStepFocus<T extends HTMLElement>(step: unknown) {
  const ref = useRef<T | null>(null);
  const previous = useRef(step);
  useEffect(() => {
    if (Object.is(previous.current, step)) return;
    previous.current = step;
    ref.current?.focus();
  }, [step]);
  return ref;
}

// ---------------------------------------------------------------------------
// Icons (inline: no icon font or library for a buyer to install)
// ---------------------------------------------------------------------------

export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 6.5v11l9-5.5z" />
    </svg>
  );
}

export function CalendarOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M8 3.5v4M16 3.5v4M4 10h16M9.5 13.5l5 4M14.5 13.5l-5 4" />
    </svg>
  );
}

export function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === "left" ? "M14.5 6l-6 6 6 6" : "M9.5 6l6 6-6 6"} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type NoticeTone = "info" | "ok" | "warn" | "error";

/**
 * A message block. Warnings and errors are `role="alert"`, announced the
 * moment they appear; the rest are polite status messages.
 */
export function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  const urgent = tone === "warn" || tone === "error";
  return (
    <div className={`aisw-notice aisw-notice-${tone}`} role={urgent ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="aisw-loading" role="status">
      <span className="aisw-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** A grey placeholder in the shape of the picker, while the business's details load. */
export function Skeleton({ label }: { label: string }) {
  return (
    <div className="aisw-skeleton" role="status" aria-label={label} data-aisw-skeleton="">
      <span className="aisw-skeleton-bar" />
      <span className="aisw-skeleton-bar" />
      <span className="aisw-skeleton-bar" />
      <span className="aisw-skeleton-bar" />
      <span className="aisw-sr">{label}</span>
    </div>
  );
}

/** `tel:` with the digits and a leading "+" of a number as typed. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

/**
 * The business's phone and email as links: "Call (801) 555-0143 or email
 * office@…." — `lowercase` for the end of a sentence. Nothing when it has
 * neither.
 */
export function ContactLinks({ phone, email, lowercase }: { phone: string | null; email: string | null; lowercase?: boolean }) {
  if (!phone && !email) return null;
  return (
    <span className="aisw-contact">
      {phone ? (
        <>
          {lowercase ? "call" : "Call"} <a href={telHref(phone)}>{phone}</a>
        </>
      ) : null}
      {phone && email ? " or " : null}
      {email ? (
        <>
          {phone || lowercase ? "email" : "Email"} <a href={`mailto:${email}`}>{email}</a>
        </>
      ) : null}
      .
    </span>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

/** A labelled field with its hint and error wired for screen readers (`${id}-hint`, `${id}-error`). */
export function Field({
  id,
  label,
  optional,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="aisw-field">
      <label className="aisw-label" htmlFor={id}>
        {label} {optional ? <span className="aisw-optional">(optional)</span> : null}
      </label>
      {children}
      {hint ? (
        <span className="aisw-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="aisw-field-error" id={`${id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** `aria-describedby` for a field: its hint (when it has one) and its error (when there is one). */
export function describedBy(id: string, hasHint: boolean, error: string | null | undefined): string | undefined {
  const ids = [hasHint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

// ---------------------------------------------------------------------------
// Days and times
// ---------------------------------------------------------------------------

/**
 * The days that have times, as tiles, with buttons for the window before and
 * after (contract 8.3): "later" asks the server for the next window, "earlier"
 * goes back to one already loaded. Only days with a time get a tile; a strip
 * of greyed-out days nobody can pick is noise on a phone.
 */
export function DateStrip({
  days,
  selected,
  onSelect,
  locale,
  onEarlier,
  onLater,
  canEarlier,
  canLater,
  busy,
}: {
  days: ReadonlyArray<{ date: DateString; count: number }>;
  selected: DateString | null;
  onSelect: (date: DateString) => void;
  locale: string;
  onEarlier: () => void;
  onLater: () => void;
  canEarlier: boolean;
  canLater: boolean;
  busy?: boolean;
}) {
  const listId = useId();
  return (
    <div className="aisw-days-wrap">
      <span className="aisw-days-label" aria-hidden="true">
        Days
      </span>
      <button
        type="button"
        className="aisw-days-step aisw-days-prev"
        aria-label="Earlier dates"
        aria-controls={listId}
        disabled={!canEarlier || busy}
        onClick={onEarlier}
      >
        <ChevronIcon direction="left" />
      </button>
      <ul className="aisw-days" id={listId} aria-label="Days with open times">
        {days.map((day) => {
          const tile = formatDayTile(day.date, locale);
          return (
            <li key={day.date}>
              <button
                type="button"
                className="aisw-day"
                data-date={day.date}
                aria-pressed={selected === day.date}
                onClick={() => onSelect(day.date)}
              >
                <span className="aisw-day-wd" aria-hidden="true">
                  {tile.weekday}
                </span>
                <span className="aisw-day-n" aria-hidden="true">
                  {tile.day}
                </span>
                <span className="aisw-day-m" aria-hidden="true">
                  {tile.month}
                </span>
                <span className="aisw-sr">
                  {`${formatLongDate(day.date, locale)}, ${day.count} time${day.count === 1 ? "" : "s"} open`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="aisw-days-step aisw-days-next"
        aria-label="Later dates"
        aria-controls={listId}
        disabled={!canLater || busy}
        onClick={onLater}
        aria-busy={busy || undefined}
      >
        <ChevronIcon direction="right" />
      </button>
    </div>
  );
}

/** One day's times as Morning / Afternoon / Evening groups of buttons. */
export function TimeGroups({
  slots,
  locale,
  selectedSlotId,
  onPick,
}: {
  slots: readonly PublicSlot[];
  locale: string;
  selectedSlotId: string | null;
  onPick: (slot: PublicSlot) => void;
}) {
  const groups = groupByPartOfDay(slots);
  const dayLabel = slots[0] ? formatLongDate(slots[0].date, locale) : "";
  return (
    <>
      {groups.map((group) => (
        <div key={group.part} className="aisw-group" role="group" aria-label={`${group.label}, ${dayLabel}`}>
          <p className="aisw-group-label" aria-hidden="true">
            {group.label}
          </p>
          <ul className="aisw-times">
            {group.slots.map((slot) => (
              <li key={slot.slotId}>
                <button
                  type="button"
                  className="aisw-time"
                  data-slot={slot.slotId}
                  aria-pressed={selectedSlotId === slot.slotId}
                  aria-label={`${formatClock(slot.startTime, locale)} to ${formatClock(slot.endTime, locale)}, ${dayLabel}`}
                  onClick={() => onPick(slot)}
                >
                  {formatClock(slot.startTime, locale)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// A link to keep
// ---------------------------------------------------------------------------

/**
 * Copy text to the clipboard: the async Clipboard API where allowed, else the
 * old select-and-execCommand path. False when neither worked; the text is
 * then left selected for the person to copy by hand.
 */
export async function copyText(text: string, field?: HTMLInputElement | null): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection path */
  }
  try {
    if (field && typeof document !== "undefined") {
      field.focus();
      field.select();
      return typeof document.execCommand === "function" ? document.execCommand("copy") : false;
    }
  } catch {
    /* nothing more to try */
  }
  return false;
}

/** A read-only field with a copy button: one tap selects all of a long link. */
export const CopyField = forwardRef<HTMLDivElement, { label: string; value: string; buttonLabel: string; hint?: ReactNode }>(
  function CopyField({ label, value, buttonLabel, hint }, ref) {
    const id = useId();
    const fieldRef = useRef<HTMLInputElement | null>(null);
    const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
    return (
      <div className="aisw-field aisw-copy" data-aisw-copy="" ref={ref}>
        <label className="aisw-label" htmlFor={id}>
          {label}
        </label>
        <div className="aisw-copy-row">
          <input
            id={id}
            ref={fieldRef}
            className="aisw-input aisw-copy-input"
            type="text"
            readOnly
            value={value}
            spellCheck={false}
            aria-describedby={hint ? `${id}-hint` : undefined}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="aisw-btn aisw-btn-secondary"
            onClick={() => void copyText(value, fieldRef.current).then((ok) => setCopied(ok ? "ok" : "failed"))}
          >
            {copied === "ok" ? "Copied" : buttonLabel}
          </button>
        </div>
        {hint ? (
          <span className="aisw-hint" id={`${id}-hint`}>
            {hint}
          </span>
        ) : null}
        <span className="aisw-sr" aria-live="polite">
          {copied === "ok" ? "Copied." : copied === "failed" ? "Couldn't copy. The link is selected; copy it by hand." : ""}
        </span>
      </div>
    );
  },
);
