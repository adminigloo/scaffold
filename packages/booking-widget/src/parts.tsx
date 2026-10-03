import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { MEDIUM_COPY, type ReachHost } from "./requests.js";
import {
  formatCountdown,
  formatDayTile,
  formatDuration,
  formatLongDate,
  formatWhen,
  groupByPartOfDay,
  holdAnnouncement,
  isValidTimeZone,
  listTimeZones,
  sameInstant,
  timeLabels,
  zoneAbbreviation,
  zoneName,
  zoneOptionLabel,
  zoneRegion,
  type LocalSlot,
  type StripDay,
  type TimeZoneChoice,
} from "./time.js";
import type { BookingStatus, PublicBooking } from "./types.js";

/**
 * The presentational pieces both components are built from. Props in, markup
 * out, no fetching — which is also what lets the test suite render them to a
 * string and assert on the copy a visitor actually reads.
 */

// ---------------------------------------------------------------------------
// Icons (inline: no icon-font or icon-library dependency for a buyer)
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

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === "left" ? "M14.5 6l-6 6 6 6" : "M9.5 6l6 6-6 6"} />
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

// ---------------------------------------------------------------------------
// Banner and notices
// ---------------------------------------------------------------------------

/** The spec's sandbox copy, with the host's name in place of a hard-coded one. */
export function defaultSandboxNotice(hostDisplayName: string): string {
  const who = hostDisplayName.trim() || "the host";
  return `Demo — this is a sandbox. Nothing is booked, nobody is emailed, and ${who} doesn't see it.`;
}

export function defaultRealBookingLabel(hostDisplayName: string): string {
  const who = hostDisplayName.trim();
  return who ? `Book a real call with ${who} →` : "Book a real call →";
}

export function SandboxBanner({
  notice,
  realBookingHref,
  realBookingLabel,
}: {
  notice: string;
  realBookingHref?: string;
  realBookingLabel: string;
}) {
  return (
    <div className="aibk-sandbox" role="note" aria-label="Sandbox" data-aibk-sandbox="">
      <span className="aibk-sandbox-text">{notice}</span>
      {realBookingHref ? <a href={realBookingHref}>{realBookingLabel}</a> : null}
    </div>
  );
}

export type NoticeTone = "info" | "ok" | "warn" | "error";

/**
 * A message block. Warnings and errors are `role="alert"`, announced the moment
 * they are inserted — the visitor's attention is on the time they just clicked,
 * not on a box that appeared above it.
 */
export function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  const urgent = tone === "warn" || tone === "error";
  return (
    <div className={`aibk-notice aibk-notice-${tone}`} role={urgent ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="aibk-loading" role="status">
      <span className="aibk-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time zone
// ---------------------------------------------------------------------------

export function ZoneSelect({
  zone,
  onChange,
  at,
  suggested,
  locale,
  choices,
}: {
  zone: string;
  onChange: (zone: string) => void;
  /** The instant labels are measured at (the day in view), so offsets are right across DST. */
  at: Date;
  /** Shown first: the viewer's own zone and the host's. */
  suggested: readonly string[];
  locale: string;
  /** A curated list (`timeZones`): only these, by their labels, in this order. */
  choices?: readonly TimeZoneChoice[];
}) {
  // Day granularity: labels only change when the offset can.
  const dayKey = Math.floor(at.getTime() / 86_400_000);
  const suggestedKey = suggested.join("|");
  const groups = useMemo(() => {
    const at = new Date(dayKey * 86_400_000 + 43_200_000);
    const top = [...new Set([zone, ...suggested])].filter(isValidTimeZone);
    const topSet = new Set(top);
    const regions = new Map<string, string[]>();
    for (const candidate of listTimeZones(top)) {
      if (topSet.has(candidate)) continue;
      const region = zoneRegion(candidate);
      const list = regions.get(region) ?? [];
      list.push(candidate);
      regions.set(region, list);
    }
    const option = (value: string) => ({ value, label: zoneOptionLabel(value, at) });
    return {
      top: top.map(option),
      regions: [...regions.entries()]
        .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
        .map(([region, zones]) => ({ region, options: zones.map(option) })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, suggestedKey, dayKey]);

  if (choices && choices.length > 0) {
    // The labels are already the names people use, so the select IS the
    // sentence: "Times shown in [Mountain Time ▾]", not the zone said twice.
    const offered = choices.filter((choice) => isValidTimeZone(choice.zone));
    return (
      <label className="aibk-zone">
        <span>Times shown in</span>
        <select className="aibk-select" value={zone} onChange={(event) => onChange(event.target.value)}>
          {offered.some((choice) => choice.zone === zone) ? null : (
            <option value={zone}>{zoneName(zone, at, locale)}</option>
          )}
          {offered.map((choice) => (
            <option key={choice.zone} value={choice.zone}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div className="aibk-zone">
      <span>
        Times shown in <span className="aibk-zone-now">{zoneName(zone, at, locale)}</span>
      </span>
      <select
        className="aibk-select"
        aria-label="Time zone"
        value={zone}
        onChange={(event) => onChange(event.target.value)}
      >
        <optgroup label="Suggested">
          {groups.top.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
        {groups.regions.map((group) => (
          <optgroup key={group.region} label={group.region}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Days and times
// ---------------------------------------------------------------------------

/** useLayoutEffect in the browser (measure before paint), a no-op-safe useEffect on a server render. */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface StripEdges {
  /** The tiles run past the strip's width, so there is somewhere to scroll. */
  overflow: boolean;
  atStart: boolean;
  atEnd: boolean;
}

/**
 * The days, as a horizontal scroller with ‹ › buttons either side.
 *
 * The buttons exist for desktop MOUSE users: of 22 bookable days only 8
 * tiles fit at 1440px, and the only other ways along were shift+wheel or a
 * thin scrollbar some systems hide. Each press scrolls one strip-width; each
 * is disabled at its end, and both disappear when every tile already fits.
 * Touch users can still swipe, and keyboard users tab along the tiles.
 */
export function DateStrip({
  strip,
  selected,
  onSelect,
  locale,
}: {
  strip: readonly StripDay[];
  selected: string | null;
  onSelect: (date: string) => void;
  locale: string;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();
  const [edges, setEdges] = useState<StripEdges>({ overflow: false, atStart: true, atEnd: true });

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const max = list.scrollWidth - list.clientWidth;
    // A few pixels of slack: scroll snapping can rest a couple of pixels
    // off either end, and that is still "at the end" to a person.
    const next: StripEdges = { overflow: max > 4, atStart: list.scrollLeft <= 4, atEnd: list.scrollLeft >= max - 4 };
    setEdges((current) =>
      current.overflow === next.overflow && current.atStart === next.atStart && current.atEnd === next.atEnd
        ? current
        : next,
    );
  }, []);

  // Keep the open day in view inside the strip (a zone change can move it off
  // the edge). scrollLeft rather than scrollIntoView: the latter also scrolls
  // the PAGE, which on first load would yank a below-the-fold widget into view.
  // The list is the tiles' offsetParent (position: relative), so offsetLeft is
  // measured in the list's own scrolled content.
  useIsoLayoutEffect(() => {
    const list = listRef.current;
    if (list && selected) {
      const button = list.querySelector<HTMLElement>(`[data-date="${selected}"]`);
      if (button) {
        const left = button.offsetLeft;
        if (left < list.scrollLeft || left + button.offsetWidth > list.scrollLeft + list.clientWidth) {
          list.scrollLeft = Math.max(0, left - 8);
        }
      }
    }
    measure();
  }, [selected, strip.length, measure]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof window === "undefined") return;
    const onChange = () => measure();
    list.addEventListener("scroll", onChange, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(onChange) : null;
    if (observer) observer.observe(list);
    else window.addEventListener("resize", onChange);
    return () => {
      list.removeEventListener("scroll", onChange);
      if (observer) observer.disconnect();
      else window.removeEventListener("resize", onChange);
    };
  }, [measure]);

  const step = (direction: -1 | 1) => {
    const list = listRef.current;
    if (!list) return;
    const reduce =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
    const left = direction * list.clientWidth;
    if (typeof list.scrollBy === "function") list.scrollBy({ left, behavior: reduce ? "auto" : "smooth" });
    else list.scrollLeft += left;
  };

  return (
    <div className="aibk-days-wrap" data-overflow={edges.overflow ? "" : undefined}>
      <button
        type="button"
        className="aibk-days-step aibk-days-prev"
        aria-label="Earlier days"
        aria-controls={listId}
        disabled={edges.atStart}
        onClick={() => step(-1)}
      >
        <ChevronIcon direction="left" />
      </button>
      <DayTiles listId={listId} listRef={listRef} strip={strip} selected={selected} onSelect={onSelect} locale={locale} />
      <button
        type="button"
        className="aibk-days-step aibk-days-next"
        aria-label="Later days"
        aria-controls={listId}
        disabled={edges.atEnd}
        onClick={() => step(1)}
      >
        <ChevronIcon direction="right" />
      </button>
    </div>
  );
}

function DayTiles({
  listId,
  listRef,
  strip,
  selected,
  onSelect,
  locale,
}: {
  listId: string;
  listRef: RefObject<HTMLUListElement | null>;
  strip: readonly StripDay[];
  selected: string | null;
  onSelect: (date: string) => void;
  locale: string;
}) {
  return (
    <ul className="aibk-days" id={listId} ref={listRef} aria-label="Days">
      {strip.map((day) => {
        const tile = formatDayTile(day.date, locale);
        return (
          <li key={day.date}>
            <button
              type="button"
              className="aibk-day"
              data-date={day.date}
              aria-pressed={selected === day.date}
              disabled={day.count === 0}
              onClick={() => onSelect(day.date)}
            >
              <span className="aibk-day-wd">{tile.weekday}</span>
              <span className="aibk-day-n">{tile.day}</span>
              <span className="aibk-day-m">{tile.month}</span>
              <span className="aibk-sr">
                {`, ${formatLongDate(day.date, locale)}, `}
                {day.count === 0 ? "no times open" : `${day.count} time${day.count === 1 ? "" : "s"} open`}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function TimeGroups({
  slots,
  zone,
  locale,
  selectedStart,
  pendingStart,
  onPick,
}: {
  slots: readonly LocalSlot[];
  zone: string;
  locale: string;
  selectedStart: string | null;
  pendingStart: string | null;
  onPick: (slot: LocalSlot) => void;
}) {
  const groups = groupByPartOfDay(slots);
  const dayLabel = slots[0] ? formatLongDate(slots[0].date, locale) : "";
  // Labelled across the whole day, not per group: the two 1:30 AMs of a
  // fall-back night sit in the same group, but a buyer's 24/7 hours could
  // put a repeated label anywhere.
  const labels = timeLabels(slots, zone, locale);
  return (
    <>
      {groups.map((group) => (
        <div key={group.part} className="aibk-group" role="group" aria-label={`${group.label}, ${dayLabel}`}>
          <p className="aibk-group-label" aria-hidden="true">
            {group.label}
          </p>
          <ul className="aibk-times">
            {group.slots.map((slot) => {
              const time = labels.get(slot.start) ?? slot.start;
              const pending = sameInstant(pendingStart, slot.start);
              return (
                <li key={slot.start}>
                  <button
                    type="button"
                    className="aibk-time"
                    data-start={slot.start}
                    aria-pressed={sameInstant(selectedStart, slot.start) || pending}
                    aria-busy={pending || undefined}
                    onClick={() => onPick(slot)}
                  >
                    {time}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// The hold
// ---------------------------------------------------------------------------

export function HoldCountdown({ deadline, now }: { deadline: number; now: number }) {
  const remaining = deadline - now;
  return (
    <span className={`aibk-timer${remaining <= 60_000 ? " aibk-timer-low" : ""}`}>
      <ClockSmall />
      {/* role=timer is aria-live="off": the per-second digits are not read out.
          The sr-only region beside it speaks at a few thresholds instead. */}
      <span role="timer">
        Held for <span className="aibk-timer-n">{formatCountdown(remaining)}</span>
      </span>
      <span className="aibk-sr" aria-live="polite" aria-atomic="true">
        {holdAnnouncement(remaining)}
      </span>
    </span>
  );
}

function ClockSmall() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// A booking, described
// ---------------------------------------------------------------------------

/** "Tuesday, October 6 at 9:30 AM MDT". */
export function describeWhen(startIso: string, zone: string, locale: string): string {
  const start = new Date(startIso);
  const abbreviation = zoneAbbreviation(zone, start, locale);
  return `${formatWhen(start, zone, locale)}${abbreviation ? ` ${abbreviation}` : ""}`;
}

export function HowWeMeet({
  booking,
  inviteePhone,
}: {
  booking: PublicBooking;
  /** The number they typed, when we have it (the booking form does; a manage page does not). */
  inviteePhone?: string;
}) {
  const host = booking.hostDisplayName || "We";
  const title = `${booking.typeName}${booking.hostDisplayName ? ` with ${booking.hostDisplayName}` : ""}`;
  if (booking.medium === "phone") {
    return (
      <>
        <span>{MEDIUM_COPY.phone.short}. </span>
        <span>
          {host} will call you{inviteePhone ? ` at ${inviteePhone}` : ""} at the time above.
        </span>
        {booking.hostPhone ? <span> The call will come from {booking.hostPhone}.</span> : null}
      </>
    );
  }
  if (booking.medium === "prospect_hosted") {
    const mailbox = booking.inviteMailbox;
    return (
      <>
        <span>{MEDIUM_COPY.prospect_hosted.short}. </span>
        {mailbox ? (
          <span>
            Send your meeting invite for this time to{" "}
            <a href={`mailto:${mailbox}?subject=${encodeURIComponent(title)}`}>{mailbox}</a>.
          </span>
        ) : (
          <span>Send your meeting invite for this time from your own calendar.</span>
        )}
      </>
    );
  }
  return (
    <>
      <span>{MEDIUM_COPY.video.short}. </span>
      {booking.meetingLink ? (
        <span>
          Join at{" "}
          <a href={booking.meetingLink} target="_blank" rel="noopener noreferrer">
            {booking.meetingLink}
            <span className="aibk-sr"> (opens in a new tab)</span>
          </a>
        </span>
      ) : (
        // No link saved on the host: say who sends it, never WHERE it will
        // be (a confirmation email may not exist — see EmailFacts).
        <span>{host} will send you the link before the call.</span>
      )}
    </>
  );
}

export function BookingFacts({
  booking,
  zone,
  locale,
  inviteePhone,
  zoneChoices,
}: {
  booking: PublicBooking;
  zone: string;
  locale: string;
  inviteePhone?: string;
  /** The widget's `timeZones`, so the zone reads by the same name as the selector. */
  zoneChoices?: readonly TimeZoneChoice[];
}) {
  const start = new Date(booking.start);
  return (
    <dl className="aibk-facts">
      <div className="aibk-fact">
        <dt>When</dt>
        <dd>
          <strong>{describeWhen(booking.start, zone, locale)}</strong>
          <br />
          <span className="aibk-hint">
            {formatDuration(booking.durationMinutes)} · times in {zoneName(zone, start, locale, zoneChoices)}
          </span>
        </dd>
      </div>
      <div className="aibk-fact">
        <dt>What</dt>
        <dd>
          {booking.typeName}
          {booking.hostDisplayName ? ` with ${booking.hostDisplayName}` : ""}
        </dd>
      </div>
      <div className="aibk-fact">
        <dt>How we meet</dt>
        <dd>
          <HowWeMeet booking={booking} inviteePhone={inviteePhone} />
        </dd>
      </div>
    </dl>
  );
}

/**
 * The two calendar exports. In a sandbox they say so ON the button: the
 * event lands in the visitor's REAL calendar, and the server marks it as a
 * sandbox event too, but a button that read like the real thing is how a
 * demo became "a call with Dallin on Monday" in someone's week.
 */
export function CalendarActions({
  booking,
  icsHref,
  onIcsClick,
  sandbox,
}: {
  booking: PublicBooking;
  icsHref: string;
  onIcsClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** Default: the booking's own `sandbox` flag. */
  sandbox?: boolean;
}) {
  const isSandbox = sandbox ?? booking.sandbox;
  return (
    <div className="aibk-actions">
      {booking.googleCalendarUrl ? (
        <a className="aibk-btn aibk-btn-secondary" href={booking.googleCalendarUrl} target="_blank" rel="noopener noreferrer">
          {isSandbox ? "Add sandbox event to Google Calendar" : "Add to Google Calendar"}
          <span className="aibk-sr"> (opens in a new tab)</span>
        </a>
      ) : null}
      <a
        className="aibk-btn aibk-btn-secondary"
        href={icsHref}
        download={isSandbox ? "sandbox-booking.ics" : "booking.ics"}
        onClick={onIcsClick}
      >
        {isSandbox ? "Download sandbox .ics" : "Download .ics"}
      </a>
    </div>
  );
}

/**
 * "reply to your confirmation email" / "email help@…" (a mailto link) /
 * "contact Dallin directly" — the end of a sentence that tells someone how
 * to change what the page can't, chosen by `reachHost`.
 */
export function ReachHostText({ reach }: { reach: ReachHost }) {
  if (reach.kind === "reply") return <>reply to your confirmation email</>;
  if (reach.kind === "email") {
    return (
      <>
        email <a href={`mailto:${reach.address}`}>{reach.address}</a>
      </>
    );
  }
  return <>contact {reach.who} directly</>;
}

/**
 * Copy text to the clipboard: the async Clipboard API where the page is
 * allowed it, else the old select-and-execCommand path (an http:// preview,
 * an iframe without the permission). False when neither worked, and the
 * caller leaves the text selected for the person to copy by hand.
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

/**
 * A private link the person must keep, as a read-only field with a copy
 * button. Read-only rather than plain text so a long token never wraps into
 * something that looks like two links, and one tap selects all of it.
 */
export function CopyField({
  label,
  value,
  buttonLabel,
  hint,
}: {
  label: string;
  value: string;
  buttonLabel: string;
  hint?: ReactNode;
}) {
  const id = useId();
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
  return (
    <div className="aibk-field aibk-copy" data-aibk-copy="">
      <label className="aibk-label" htmlFor={id}>
        {label}
      </label>
      <div className="aibk-copy-row">
        <input
          id={id}
          ref={fieldRef}
          className="aibk-input aibk-copy-input"
          type="text"
          readOnly
          value={value}
          spellCheck={false}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="aibk-btn aibk-btn-secondary"
          onClick={() => void copyText(value, fieldRef.current).then((ok) => setCopied(ok ? "ok" : "failed"))}
        >
          {copied === "ok" ? "Copied" : buttonLabel}
        </button>
      </div>
      {hint ? (
        <span className="aibk-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      <span className="aibk-sr" aria-live="polite">
        {copied === "ok" ? "Copied to the clipboard." : copied === "failed" ? "Couldn't copy. The link is selected; copy it by hand." : ""}
      </span>
    </div>
  );
}

/** Whether the call is over, on the visitor's clock. */
export function isPast(booking: PublicBooking, now: number): boolean {
  return booking.status === "completed" || booking.status === "no_show" || Date.parse(booking.end) <= now;
}

export function StatusTag({ status, past }: { status: BookingStatus; past: boolean }) {
  if (status === "cancelled") return <span className="aibk-tag aibk-tag-danger">Cancelled</span>;
  if (status === "no_show") return <span className="aibk-tag aibk-tag-muted">Missed</span>;
  if (past || status === "completed") return <span className="aibk-tag aibk-tag-muted">Past</span>;
  if (status === "requested") return <span className="aibk-tag">Awaiting confirmation</span>;
  return <span className="aibk-tag aibk-tag-ok">Confirmed</span>;
}

/** The four promises a sandbox confirmation makes about the real thing. */
export const REAL_BOOKING_STEPS: readonly string[] = [
  "A confirmation email with a calendar invite goes to your customer.",
  "A reminder goes out the day before the call.",
  "Your customer gets a manage link to reschedule or cancel — no account needed.",
  "You get a notice with their details, so the call lands on your calendar too.",
];
