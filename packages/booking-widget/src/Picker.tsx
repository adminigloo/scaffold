import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { SlotSource } from "./client.js";
import { useSlots } from "./hooks.js";
import { DateStrip, Loading, Notice, TimeGroups, ZoneSelect } from "./parts.js";
import { friendlyError } from "./requests.js";
import {
  buildDateStrip,
  chooseDay,
  formatLongDate,
  groupSlotsByDay,
  lastBookableDay,
  stripStartDay,
  zonedParts,
  type LocalSlot,
  type TimeZoneChoice,
} from "./time.js";

/**
 * The time picker — date strip, zone selector, times by part of day — for ONE
 * booking type. Shared by the booking flow and the manage page's reschedule,
 * so both offer times the same way and in the same zone rules.
 *
 * It owns the slot list and which day is open; the parent owns the zone (the
 * confirmation and emails use it too) and the picked time (the hold lives
 * there).
 */

export interface PickerProps {
  /** Where open times come from: the public BookingClient, or the admin adapter's slot list. */
  client: SlotSource;
  typeKey: string;
  zone: string;
  onZoneChange: (zone: string) => void;
  /** Offered first in the zone list: the viewer's own zone and the host's. */
  suggestedZones: readonly string[];
  /** A curated zone list (the widget's `timeZones`): offered instead of every IANA zone. */
  timeZones?: readonly TimeZoneChoice[];
  locale: string;
  selectedStart: string | null;
  pendingStart: string | null;
  onPick: (slot: LocalSlot) => void;
  sandbox: boolean;
  /** Bump to refetch the list in place (after a slot_taken). */
  refreshSignal: number;
  /** Starts never offered — a reschedule hides the booking's current time. */
  hideStarts?: readonly string[];
  heading: string;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Rendered between the zone line and the days: the "that time was taken" message. */
  notice?: ReactNode;
  /**
   * The invitee's manage token, on a reschedule: the slot list then treats
   * their own booking as free, so times next to it are offered.
   */
  manageToken?: string;
  /** The type's horizon from the config, when the server sends it: the strip runs exactly that far. */
  horizonDays?: number;
  /** The zone the horizon is counted in — the host's, from the config. */
  hostTimezone?: string;
  /** The line under "No open times right now". Default: the visitor-facing "check back soon". */
  emptyHint?: string;
}

export function Picker(props: PickerProps) {
  const { client, typeKey, zone, locale, selectedStart, sandbox, horizonDays } = props;
  const hostZone = props.hostTimezone ?? zone;
  const slots = useSlots(client, typeKey, { manageToken: props.manageToken, horizonDays, hostZone });

  const lastSignal = useRef(props.refreshSignal);
  const { refresh } = slots;
  useEffect(() => {
    if (lastSignal.current === props.refreshSignal) return;
    lastSignal.current = props.refreshSignal;
    refresh();
  }, [props.refreshSignal, refresh]);

  const hideKey = (props.hideStarts ?? []).join("|");
  const days = useMemo(() => {
    const hidden = new Set((props.hideStarts ?? []).map((iso) => Date.parse(iso)));
    return groupSlotsByDay(
      slots.slots.filter((slot) => !hidden.has(Date.parse(slot.start))),
      zone,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots.slots, zone, hideKey]);

  // The open day, remembered WITH the zone it was chosen in. When the zone
  // changes, a picked time is the same instant everywhere, so the open day
  // follows it to its new date; without a pick, the same calendar date stays
  // open if it still has times.
  const [view, setView] = useState<{ day: string | null; zone: string }>({ day: null, zone });
  if (view.zone !== zone) {
    const day = selectedStart ? zonedParts(new Date(selectedStart), zone).date : view.day;
    setView({ day, zone });
  }
  const openDay = chooseDay(days, view.day, selectedStart, zone);
  const openSlots = days.find((day) => day.date === openDay)?.slots ?? [];

  const today = zonedParts(new Date(), zone).date;
  // With a known horizon the strip ends at its last day — or at the end of
  // what has been fetched so far, so unfetched days never pose as empty ones
  // ("Show later dates" extends it). Without one, buildDateStrip infers.
  const { loadedUntil } = slots;
  const lastDay = useMemo(() => {
    if (!horizonDays) return null;
    const horizonLast = lastBookableDay(Date.now(), horizonDays, hostZone, zone);
    if (!loadedUntil) return horizonLast;
    const loadedLast = zonedParts(new Date(Date.parse(loadedUntil) - 1), zone).date;
    return loadedLast < horizonLast ? loadedLast : horizonLast;
    // `today` is a dependency so the end moves with the date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizonDays, hostZone, zone, loadedUntil, today]);
  // The strip opens on the first day that has a time (see stripStartDay).
  const strip = useMemo(() => buildDateStrip(days, stripStartDay(days, today), 7, lastDay), [days, today, lastDay]);

  const referenceIso = selectedStart ?? openSlots[0]?.start ?? days[0]?.slots[0]?.start;
  const at = referenceIso ? new Date(referenceIso) : new Date();
  const headingId = useId();

  return (
    <section className="aibk-section" aria-labelledby={headingId} aria-busy={slots.status === "loading" || undefined}>
      <div className="aibk-section-head">
        <h3 className="aibk-h3" id={headingId} ref={props.headingRef} tabIndex={-1}>
          {props.heading}
        </h3>
        {sandbox ? <span className="aibk-tag">Sample times · sandbox</span> : null}
      </div>
      <ZoneSelect
        zone={zone}
        onChange={props.onZoneChange}
        at={at}
        suggested={props.suggestedZones}
        locale={locale}
        choices={props.timeZones}
      />
      {props.notice}

      {slots.status === "loading" || slots.status === "idle" ? <Loading label="Loading open times…" /> : null}

      {slots.status === "error" && slots.error ? (
        <Notice tone="error">
          {friendlyError(slots.error, "slots")}{" "}
          <button type="button" className="aibk-btn aibk-btn-link" onClick={slots.retry}>
            Try again
          </button>
        </Notice>
      ) : null}

      {slots.status === "ready" && days.length === 0 ? (
        <div className="aibk-empty">
          <span className="aibk-empty-title">No open times right now</span>
          <span>{props.emptyHint ?? "Every slot in the coming weeks is taken. Please check back soon."}</span>
        </div>
      ) : null}

      {slots.status === "ready" && days.length > 0 ? (
        <>
          <DateStrip strip={strip} selected={openDay} locale={locale} onSelect={(day) => setView({ day, zone })} />
          {slots.hasMore ? (
            <div>
              <button
                type="button"
                className="aibk-btn aibk-btn-link"
                onClick={slots.loadMore}
                disabled={slots.loadingMore}
              >
                {slots.loadingMore ? "Loading later dates…" : "Show later dates"}
              </button>
            </div>
          ) : null}
          {openDay ? (
            <div className="aibk-section">
              <h4 className="aibk-h3">{formatLongDate(openDay, locale)}</h4>
              <TimeGroups
                slots={openSlots}
                zone={zone}
                locale={locale}
                selectedStart={selectedStart}
                pendingStart={props.pendingStart}
                onPick={props.onPick}
              />
            </div>
          ) : null}
          {slots.refreshing ? (
            <span className="aibk-hint" role="status">
              Updating times…
            </span>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
