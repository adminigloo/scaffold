import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { SchedulingTransport } from "./client.js";
import { friendlyError } from "./form.js";
import { useSlotPages } from "./hooks.js";
import { DateStrip, Loading, Notice, TimeGroups } from "./parts.js";
import { daysBetween, formatLongDate, groupSlotsByDay, zoneLabel } from "./time.js";
import type { PublicSlot } from "./types.js";

/**
 * Day and time, for one service or one visit being moved. Shared by the
 * booking flow and the manage page's reschedule, so both offer times the same
 * way: the days that have times, a window at a time, and that day's times as
 * Morning / Afternoon / Evening — all on the BUSINESS's clock, with one line
 * that says which clock it is.
 */

export interface SlotPickerProps {
  transport: SchedulingTransport;
  /** A service key (booking), or… */
  service?: string | null;
  /** …a manage token (reschedule): the visit's own time counts as free. */
  manageToken?: string | null;
  days: number;
  /** The business's zone, from the config (or the visit). */
  timeZone: string;
  horizonDays?: number | null;
  locale: string;
  heading: string;
  headingRef?: Ref<HTMLHeadingElement>;
  selectedSlotId: string | null;
  onPick: (slot: PublicSlot) => void;
  /** Bump to re-ask for the window on screen (after a time was taken). */
  refreshSignal: number;
  /** Shown above the days: "That time was just taken. Pick another." */
  notice?: ReactNode;
  /** A start never offered: a visit being moved doesn't offer its own time. */
  hide?: { date: string; startTime: string } | null;
  /** How to reach the business, for the "no open times" message. */
  contact?: ReactNode;
  /** The server answered `closed: true`. */
  onClosed?: () => void;
}

export function SlotPicker(props: SlotPickerProps) {
  const { transport, locale, selectedSlotId } = props;
  const slots = useSlotPages(transport, {
    service: props.service ?? null,
    manage: props.manageToken ?? null,
    days: props.days,
    timeZone: props.timeZone,
    horizonDays: props.horizonDays ?? null,
  });
  const headingId = useId();

  const lastSignal = useRef(props.refreshSignal);
  const { refresh } = slots;
  useEffect(() => {
    if (lastSignal.current === props.refreshSignal) return;
    lastSignal.current = props.refreshSignal;
    refresh();
  }, [props.refreshSignal, refresh]);

  const page = slots.page;
  const closed = page?.closed === true;
  const { onClosed } = props;
  useEffect(() => {
    if (closed) onClosed?.();
  }, [closed, onClosed]);

  const hideKey = props.hide ? `${props.hide.date}|${props.hide.startTime}` : "";
  const days = useMemo(
    () => groupSlotsByDay((page?.slots ?? []).filter((slot) => `${slot.date}|${slot.startTime}` !== hideKey)),
    [page, hideKey],
  );

  const [openDay, setOpenDay] = useState<string | null>(null);
  const chosenDay =
    openDay && days.some((day) => day.date === openDay)
      ? openDay
      : (days.find((day) => day.slots.some((slot) => slot.slotId === selectedSlotId))?.date ?? days[0]?.date ?? null);
  const openSlots = days.find((day) => day.date === chosenDay)?.slots ?? [];
  const reference = openSlots[0]?.startsAt ?? days[0]?.slots[0]?.startsAt ?? null;
  const spanDays = page && page.from && page.to ? daysBetween(page.from, page.to) + 1 : props.days;

  return (
    <section className="aisw-section" aria-labelledby={headingId} aria-busy={slots.status === "loading" || undefined}>
      <div className="aisw-section-head">
        <h3 className="aisw-h3" id={headingId} ref={props.headingRef} tabIndex={-1}>
          {props.heading}
        </h3>
      </div>
      <p className="aisw-zone" data-aisw-zone="">
        Times are <strong>{zoneLabel(props.timeZone, reference, locale)}</strong>
      </p>
      {props.notice}

      {slots.status === "loading" || slots.status === "idle" ? <Loading label="Finding open times…" /> : null}

      {slots.status === "error" && slots.error ? (
        <Notice tone="error">
          {friendlyError(slots.error, "slots")}{" "}
          <button type="button" className="aisw-btn aisw-btn-link" onClick={slots.retry}>
            Try again
          </button>
        </Notice>
      ) : null}

      {slots.status === "ready" && slots.error ? <Notice tone="error">{friendlyError(slots.error, "slots")}</Notice> : null}

      {slots.status === "ready" && !closed && days.length === 0 ? (
        <div className="aisw-empty" data-aisw-empty="">
          <span className="aisw-empty-title">No open times in the next {spanDays} days.</span>
          {props.contact ? <span>{props.contact}</span> : null}
          <div className="aisw-actions">
            {slots.canEarlier ? (
              <button type="button" className="aisw-btn aisw-btn-secondary" onClick={slots.earlier}>
                Earlier dates
              </button>
            ) : null}
            {slots.canLater ? (
              <button type="button" className="aisw-btn aisw-btn-secondary" onClick={slots.later} disabled={slots.loadingLater}>
                {slots.loadingLater ? "Looking…" : "Look further ahead"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {slots.status === "ready" && days.length > 0 ? (
        <>
          <DateStrip
            days={days.map((day) => ({ date: day.date, count: day.slots.length }))}
            selected={chosenDay}
            onSelect={setOpenDay}
            locale={locale}
            onEarlier={slots.earlier}
            onLater={slots.later}
            canEarlier={slots.canEarlier}
            canLater={slots.canLater}
            busy={slots.loadingLater}
          />
          {chosenDay ? (
            <div className="aisw-section">
              <h4 className="aisw-h3">{formatLongDate(chosenDay, locale)}</h4>
              <TimeGroups slots={openSlots} locale={locale} selectedSlotId={selectedSlotId} onPick={props.onPick} />
            </div>
          ) : null}
        </>
      ) : null}

      <span className="aisw-sr" role="status" aria-live="polite">
        {slots.refreshing ? "Updating times…" : slots.loadingLater ? "Loading later dates…" : ""}
      </span>
    </section>
  );
}
