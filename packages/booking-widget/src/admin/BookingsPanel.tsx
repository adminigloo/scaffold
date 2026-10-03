import { useId, useMemo, useRef, useState } from "react";
import type { Result, SlotSource } from "../client.js";
import { describeWhen, Loading, Notice } from "../parts.js";
import { Picker } from "../Picker.js";
import { LIMITS } from "../requests.js";
import { formatDuration, type LocalSlot } from "../time.js";
import type { SlotsResponse } from "../types.js";
import {
  canCancel,
  canMove,
  canRecordOutcome,
  cancelButtonLabel,
  cancelReasonLabel,
  confirmButtonLabel,
  formatInviteeTime,
  formatSlot,
  formatStamp,
  mailtoInvitee,
  MEDIUM_LABEL,
  moveButtonLabel,
  STATUS_LABEL,
  statusTone,
  toIso,
} from "./helpers.js";
import type { AdminBooking, AdminBookingType, BookingAdminAdapter, BookingScope } from "./types.js";
import { Badge, Outcome, useAction, useResource } from "./ui.js";

/**
 * The calls themselves. Upcoming soonest first, past most recent first;
 * every time in the host's zone, with the invitee's clock beside it when
 * theirs differs.
 *
 * Every button says what it does to the other person. With email wired,
 * "Cancel the call and email them" — an admin click that silently emails a
 * stranger is the surprise nobody forgives. With email NOT wired, "Cancel
 * the call", plus a prefilled mailto so the host tells them; the old copy
 * promised an email that was never sent, and the invitee turned up to a
 * cancelled call.
 */

export function BookingsPanel({
  adapter,
  scope,
  types,
  locale,
  onChanged,
}: {
  adapter: BookingAdminAdapter;
  scope: BookingScope;
  types: readonly AdminBookingType[];
  locale: string;
  onChanged?: () => void;
}) {
  const list = useResource(() => adapter.listBookings({ scope }), scope);
  const reload = () => {
    list.reload();
    onChanged?.();
  };
  if (list.loading && !list.data) return <Loading label="Loading calls…" />;
  if (list.error && !list.data) {
    return (
      <Notice tone="error">
        Couldn't load the calls: {list.error}{" "}
        <button type="button" className="aibk-btn aibk-btn-link" onClick={list.reload}>
          Try again
        </button>
      </Notice>
    );
  }
  const rows = list.data ?? [];
  if (rows.length === 0) {
    return (
      <div className="aibk-empty" data-aibk-empty={scope}>
        <span className="aibk-empty-title">{scope === "upcoming" ? "No upcoming calls" : "No past calls yet"}</span>
        <span>
          {scope === "upcoming"
            ? "Calls booked on your booking page appear here, with who booked, how you're meeting and anything they wrote."
            : "Calls move here once they end. Record how each went to keep a pipeline."}
        </span>
      </div>
    );
  }
  return (
    <ul className="aibk-bookings" aria-label={scope === "upcoming" ? "Upcoming calls" : "Past calls"}>
      {rows.map((booking) => (
        <li key={booking.id}>
          <BookingRow
            booking={booking}
            adapter={adapter}
            scope={scope}
            type={types.find((type) => type.key === booking.typeKey)}
            locale={locale}
            onChanged={reload}
          />
        </li>
      ))}
    </ul>
  );
}

type Panel = null | "cancel" | "outcome" | "history" | "move";

export function BookingRow({
  booking: b,
  adapter,
  scope,
  type,
  locale,
  onChanged,
  nowMs,
}: {
  booking: AdminBooking;
  adapter: BookingAdminAdapter;
  scope: BookingScope;
  type?: AdminBookingType;
  locale: string;
  onChanged: () => void;
  /** For tests; the clock otherwise. */
  nowMs?: number;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const now = nowMs ?? Date.now();
  const emails = adapter.emailsEnabled;
  const confirm = useAction(() => adapter.confirmBooking(b.id), onChanged);
  const theirTime = formatInviteeTime(b.start, b.inviteeTimezone, b.hostTimezone, locale);
  const toggle = (next: Exclude<Panel, null>) => setPanel(panel === next ? null : next);
  const done = () => {
    setPanel(null);
    onChanged();
  };
  const outcomeOk = canRecordOutcome(b, now);
  const cancelOk = canCancel(b, now);
  const moveOk = canMove(b, now);
  const panelId = useId();

  return (
    <article className={`aibk-booking${b.status === "cancelled" ? " aibk-booking-off" : ""}`} data-aibk-booking={b.id}>
      <div className="aibk-booking-top">
        <div className="aibk-booking-who">
          <p className="aibk-booking-when">{formatSlot(b.start, b.end, b.hostTimezone, locale)}</p>
          {theirTime ? <p className="aibk-hint">{theirTime}</p> : null}
          <p className="aibk-booking-name">
            {b.inviteeName ?? "Someone"}
            {b.inviteeCompany ? <span className="aibk-booking-company"> · {b.inviteeCompany}</span> : null}
          </p>
          <p className="aibk-row aibk-booking-contact">
            {b.inviteeEmail ? <a href={`mailto:${b.inviteeEmail}`}>{b.inviteeEmail}</a> : null}
            {b.inviteePhone ? <a href={`tel:${b.inviteePhone}`}>{b.inviteePhone}</a> : null}
          </p>
        </div>
        <div className="aibk-row aibk-booking-tags">
          {b.typeName ? <Badge tone="muted">{b.typeName}</Badge> : null}
          {b.medium ? <Badge tone="accent">{MEDIUM_LABEL[b.medium] ?? b.medium}</Badge> : null}
          <Badge tone={statusTone(b.status)}>{STATUS_LABEL[b.status] ?? b.status}</Badge>
        </div>
      </div>

      {b.notes ? <p className="aibk-booking-notes">&ldquo;{b.notes}&rdquo;</p> : null}

      <p className="aibk-row aibk-booking-meta">
        {b.source ? <span>Came from: {b.source}</span> : null}
        {b.sequence > 0 && b.status !== "cancelled" ? <span>Moved {b.sequence}×</span> : null}
        {b.status === "cancelled" ? (
          <span>
            Cancelled by {b.cancelledBy === "host" ? "you" : b.cancelledBy === "invitee" ? "them" : "the system"}
            {b.cancelReason ? ` — “${b.cancelReason}”` : ""}
          </span>
        ) : null}
        {b.outcome ? <span>Outcome: {b.outcome}</span> : null}
      </p>

      <div className="aibk-row aibk-booking-actions">
        {b.status === "requested" && cancelOk ? (
          <button
            type="button"
            className="aibk-btn aibk-btn-primary"
            disabled={confirm.pending}
            aria-busy={confirm.pending || undefined}
            onClick={() => void confirm.run()}
          >
            {confirm.pending ? "Confirming…" : confirmButtonLabel(emails)}
          </button>
        ) : null}
        {moveOk ? (
          <button
            type="button"
            className="aibk-btn aibk-btn-secondary"
            aria-expanded={panel === "move"}
            aria-controls={`${panelId}-move`}
            onClick={() => toggle("move")}
          >
            Move call
          </button>
        ) : null}
        {cancelOk && scope === "upcoming" ? (
          <button
            type="button"
            className="aibk-btn aibk-btn-secondary aibk-btn-danger-outline"
            aria-expanded={panel === "cancel"}
            aria-controls={`${panelId}-cancel`}
            onClick={() => toggle("cancel")}
          >
            Cancel call
          </button>
        ) : null}
        {outcomeOk ? (
          <button
            type="button"
            className="aibk-btn aibk-btn-secondary"
            aria-expanded={panel === "outcome"}
            aria-controls={`${panelId}-outcome`}
            onClick={() => toggle("outcome")}
          >
            Record outcome
          </button>
        ) : null}
        <button
          type="button"
          className="aibk-btn aibk-btn-secondary"
          aria-expanded={panel === "history"}
          aria-controls={`${panelId}-history`}
          onClick={() => toggle("history")}
        >
          History
        </button>
      </div>
      {b.status === "requested" && !emails && cancelOk && b.inviteeEmail ? (
        <p className="aibk-hint">
          Email isn't set up, so confirming won't tell them.{" "}
          <a href={mailtoInvitee(b.inviteeEmail, `Your ${b.typeName ?? "call"} is confirmed`)}>Email {b.inviteeEmail}</a>{" "}
          yourself.
        </p>
      ) : null}
      <Outcome error={confirm.error} />

      {panel === "move" ? (
        <div id={`${panelId}-move`}>
          <MovePanel booking={b} adapter={adapter} type={type} locale={locale} onDone={done} />
        </div>
      ) : null}
      {panel === "cancel" ? (
        <div id={`${panelId}-cancel`}>
          <CancelPanel booking={b} adapter={adapter} locale={locale} onDone={done} />
        </div>
      ) : null}
      {panel === "outcome" ? (
        <div id={`${panelId}-outcome`}>
          <OutcomePanel booking={b} adapter={adapter} onDone={done} />
        </div>
      ) : null}
      {panel === "history" ? (
        <div id={`${panelId}-history`}>
          <HistoryPanel booking={b} adapter={adapter} locale={locale} />
        </div>
      ) : null}
    </article>
  );
}

/** The no-email hint: they won't hear from us, so here is a prefilled email to send yourself. */
function TellThemYourself({ booking, subject, body }: { booking: AdminBooking; subject: string; body?: string }) {
  if (!booking.inviteeEmail) {
    return <p className="aibk-hint">Email isn't set up, so they won't hear from us. Let them know yourself.</p>;
  }
  return (
    <p className="aibk-hint" data-aibk-tell-them="">
      Email isn't set up, so they won't hear from us.{" "}
      <a href={mailtoInvitee(booking.inviteeEmail, subject, body)}>Email {booking.inviteeEmail}</a> yourself.
    </p>
  );
}

export function CancelPanel({
  booking,
  adapter,
  locale,
  onDone,
}: {
  booking: AdminBooking;
  adapter: BookingAdminAdapter;
  locale: string;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const inputId = useId();
  const emails = adapter.emailsEnabled;
  const cancel = useAction(() => adapter.cancelBooking({ id: booking.id, reason: reason.trim() || null }), onDone);
  const when = formatSlot(booking.start, booking.end, booking.hostTimezone, locale);
  return (
    <div className="aibk-panel" data-aibk-panel="cancel">
      <div className="aibk-field">
        <label className="aibk-label" htmlFor={inputId}>
          {cancelReasonLabel(emails, booking.inviteeName)}
        </label>
        <input
          id={inputId}
          className="aibk-input"
          value={reason}
          maxLength={LIMITS.reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Something came up — please pick another time."
        />
      </div>
      {!emails ? (
        <TellThemYourself
          booking={booking}
          subject={`Your ${booking.typeName ?? "call"} on ${when} is cancelled`}
          body={reason.trim() || undefined}
        />
      ) : null}
      <div className="aibk-row">
        <button
          type="button"
          className="aibk-btn aibk-btn-danger"
          disabled={cancel.pending}
          aria-busy={cancel.pending || undefined}
          onClick={() => void cancel.run()}
        >
          {cancel.pending ? "Cancelling…" : cancelButtonLabel(emails)}
        </button>
        <Outcome error={cancel.error} />
      </div>
    </div>
  );
}

export function OutcomePanel({
  booking,
  adapter,
  onDone,
}: {
  booking: AdminBooking;
  adapter: BookingAdminAdapter;
  onDone: () => void;
}) {
  const [outcome, setOutcome] = useState(booking.outcome ?? "");
  const [status, setStatus] = useState<"" | "completed" | "no_show">(
    booking.status === "completed" || booking.status === "no_show" ? booking.status : "",
  );
  const outcomeId = useId();
  const statusId = useId();
  const save = useAction(
    () => adapter.setOutcome({ id: booking.id, outcome: outcome.trim() || null, ...(status ? { status } : {}) }),
    onDone,
  );
  return (
    <div className="aibk-panel" data-aibk-panel="outcome">
      <div className="aibk-grid2">
        <div className="aibk-field">
          <label className="aibk-label" htmlFor={outcomeId}>
            How it went
          </label>
          <input
            id={outcomeId}
            className="aibk-input"
            value={outcome}
            maxLength={200}
            onChange={(event) => setOutcome(event.target.value)}
            placeholder="won · nurture · not a fit"
          />
        </div>
        <div className="aibk-field">
          <label className="aibk-label" htmlFor={statusId}>
            Mark the call
          </label>
          <select
            id={statusId}
            className="aibk-input"
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="">Leave as is</option>
            <option value="completed">Completed</option>
            <option value="no_show">No-show</option>
          </select>
        </div>
      </div>
      <div className="aibk-row">
        <button
          type="button"
          className="aibk-btn aibk-btn-primary"
          disabled={save.pending}
          aria-busy={save.pending || undefined}
          onClick={() => void save.run()}
        >
          {save.pending ? "Saving…" : "Save"}
        </button>
        <span className="aibk-hint">Private to you. Nobody is emailed.</span>
        <Outcome error={save.error} />
      </div>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  held: "Held",
  booked: "Booked",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  rescheduled: "Moved",
  outcome: "Outcome recorded",
};

function HistoryPanel({ booking, adapter, locale }: { booking: AdminBooking; adapter: BookingAdminAdapter; locale: string }) {
  const detail = useResource(() => adapter.getBooking(booking.id), booking.id);
  if (detail.loading && !detail.data) return <Loading label="Loading history…" />;
  if (detail.error) return <Notice tone="error">{detail.error}</Notice>;
  const events = detail.data?.events ?? [];
  const zone = booking.hostTimezone;
  return (
    <ol className="aibk-panel aibk-history" data-aibk-panel="history">
      {events.map((event) => {
        const previous = event.detail && typeof event.detail["previousStart"] === "string" ? event.detail["previousStart"] : null;
        return (
          <li key={String(event.id)} className="aibk-row">
            <span className="aibk-mono">{formatStamp(event.at, zone, locale)}</span>
            <span>{EVENT_LABEL[event.kind] ?? event.kind}</span>
            <span className="aibk-hint">
              by {event.actor === "host" ? "you" : event.actor === "invitee" ? "them" : event.actor}
            </span>
            {event.kind === "rescheduled" && previous ? (
              <span className="aibk-hint">(was {formatStamp(previous, zone, locale)})</span>
            ) : null}
          </li>
        );
      })}
      {events.length === 0 ? <li className="aibk-hint">No history recorded.</li> : null}
    </ol>
  );
}

/**
 * The adapter's slot list as the picker's SlotSource: failures become the
 * picker's own error state (with its Try again), never a thrown render.
 */
export function adapterSlotSource(adapter: Pick<BookingAdminAdapter, "listRescheduleSlots">, bookingId: string): SlotSource {
  return {
    async slots(input): Promise<Result<SlotsResponse>> {
      try {
        const answer = await adapter.listRescheduleSlots({ id: bookingId, typeKey: input.type, from: input.from, to: input.to });
        const slots = (answer.slots ?? []).map((slot) => ({ start: toIso(slot.start), end: toIso(slot.end) }));
        return { ok: true, data: { slots, busySync: answer.busySync ?? "off" } };
      } catch (error) {
        return {
          ok: false,
          error: { code: "server", message: error instanceof Error ? error.message : String(error), status: 0, issues: [] },
        };
      }
    },
  };
}

/**
 * "Move call": the invitee's own picker, asked through the adapter, in the
 * host's zone. No hold — the host's move is checked under the server's lock
 * when it is written, and a time taken meanwhile comes back as an error
 * with the list refreshed.
 */
export function MovePanel({
  booking,
  adapter,
  type,
  locale,
  onDone,
}: {
  booking: AdminBooking;
  adapter: BookingAdminAdapter;
  type?: AdminBookingType;
  locale: string;
  onDone: () => void;
}) {
  const [zone, setZone] = useState(booking.hostTimezone);
  const [picked, setPicked] = useState<LocalSlot | null>(null);
  const [refresh, setRefresh] = useState(0);
  const emails = adapter.emailsEnabled;
  // Stable per booking, whatever the adapter's identity: a new source would
  // refetch every time, and an app may rebuild its adapter on each render.
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const source = useMemo(
    () => adapterSlotSource({ listRescheduleSlots: (input) => adapterRef.current.listRescheduleSlots(input) }, booking.id),
    [booking.id],
  );
  const move = useAction(
    (start: string) => adapter.rescheduleBooking({ id: booking.id, start }),
    () => onDone(),
  );
  const suggested = useMemo(
    () => [booking.hostTimezone, ...(booking.inviteeTimezone ? [booking.inviteeTimezone] : [])],
    [booking.hostTimezone, booking.inviteeTimezone],
  );
  if (!booking.typeKey) return null;
  const submit = async () => {
    if (!picked) return;
    const result = await move.run(picked.start);
    if (result === undefined) {
      // Taken meanwhile, or refused: show the reason and a fresh list.
      setPicked(null);
      setRefresh((n) => n + 1);
    }
  };
  const newWhen = picked ? describeWhen(picked.start, booking.hostTimezone, locale) : "";
  return (
    <div className="aibk-panel" data-aibk-panel="move">
      <p className="aibk-hint">
        Now: {formatSlot(booking.start, booking.end, booking.hostTimezone, locale)}
        {type ? ` · ${formatDuration(type.durationMinutes)}` : ""}
      </p>
      <Picker
        client={source}
        typeKey={booking.typeKey}
        zone={zone}
        onZoneChange={setZone}
        suggestedZones={suggested}
        locale={locale}
        selectedStart={picked?.start ?? null}
        pendingStart={null}
        onPick={(slot) => {
          move.clearError();
          setPicked(slot);
        }}
        sandbox={false}
        refreshSignal={refresh}
        hideStarts={[toIso(booking.start)]}
        heading="Pick the new time"
        horizonDays={type?.horizonDays}
        hostTimezone={booking.hostTimezone}
        emptyHint="No open times in the coming weeks. Open up more hours under Availability."
      />
      {move.error ? <Notice tone="error">{move.error}</Notice> : null}
      {picked ? (
        <div className="aibk-picked" data-aibk-move-confirm="">
          <div className="aibk-picked-main">
            <span className="aibk-picked-meta">Move to</span>
            <span className="aibk-picked-when">{newWhen}</span>
          </div>
          <button
            type="button"
            className="aibk-btn aibk-btn-primary"
            disabled={move.pending}
            aria-busy={move.pending || undefined}
            onClick={() => void submit()}
          >
            {move.pending ? "Moving…" : moveButtonLabel(emails)}
          </button>
        </div>
      ) : null}
      {picked && !emails ? (
        <TellThemYourself
          booking={booking}
          subject={`Your ${booking.typeName ?? "call"} has moved`}
          body={`It's now ${describeWhen(picked.start, booking.inviteeTimezone ?? booking.hostTimezone, locale)}.`}
        />
      ) : null}
    </div>
  );
}
