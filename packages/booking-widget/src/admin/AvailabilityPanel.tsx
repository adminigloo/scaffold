import { useId, useState } from "react";
import { Loading, Notice } from "../parts.js";
import {
  datesInRange,
  describeExceptionGroup,
  formatDateRange,
  groupBlackouts,
  groupExceptions,
  MINUTE_OPTIONS,
  minuteLabel,
  todayIn,
  weekFrom,
  weekProblem,
  weekToWindows,
  WEEKDAYS,
  type EditWindow,
} from "./helpers.js";
import type { AdminBlackout, AdminException, AdminHost, BookingAdminAdapter, ExceptionKind, WeeklyWindow } from "./types.js";
import { Card, errorText, Outcome, useAction, useResource } from "./ui.js";

/**
 * When people can book: the host's week, dated time off, and holidays.
 *
 * Written in the host's own wall-clock time on the server's 15-minute grid
 * and resolved per date in the server's order — a holiday closes the day, a
 * day off wins over everything else, "different hours" replace the week for
 * that date, and blocks are cut out last. The page says that order out loud,
 * because "I added hours and it's still closed" is otherwise a support
 * ticket.
 *
 * Time off and holidays take an optional "Until": a week's vacation, the
 * most common time off there is, used to take seven separate adds — and a
 * forgotten day stayed bookable. The range is added one dated row per day
 * (the server's model), and the list shows consecutive matching rows as
 * one line that is removed in one click.
 */
export function AvailabilityPanel({
  adapter,
  host,
  blackouts,
  locale,
  onBlackoutsChanged,
  onWeekSaved,
}: {
  adapter: BookingAdminAdapter;
  host: AdminHost;
  blackouts: readonly AdminBlackout[];
  locale: string;
  onBlackoutsChanged: () => void;
  onWeekSaved: () => void;
}) {
  const availability = useResource(() => adapter.getAvailability(host.id), host.id);
  return (
    <div className="aibk-stack">
      <Notice tone="info">
        Times are in {host.timezone.replace(/_/g, " ")}, the zone set under Settings. For each date: a holiday closes
        it; a day off wins over everything; different hours replace your week for that date; blocks are then cut out. A
        call also has to clear your real calendar if one is connected.
      </Notice>
      {availability.loading && !availability.data ? <Loading label="Loading hours…" /> : null}
      {availability.error ? <Notice tone="error">{availability.error}</Notice> : null}
      {availability.data ? (
        <>
          <WeeklyEditor
            key={JSON.stringify(availability.data.weekly)}
            adapter={adapter}
            hostId={host.id}
            weekly={availability.data.weekly}
            onSaved={() => {
              availability.reload();
              onWeekSaved();
            }}
          />
          <TimeOff
            adapter={adapter}
            host={host}
            exceptions={availability.data.exceptions}
            locale={locale}
            onChanged={availability.reload}
          />
        </>
      ) : null}
      <Holidays adapter={adapter} hostZone={host.timezone} blackouts={blackouts} locale={locale} onChanged={onBlackoutsChanged} />
    </div>
  );
}

function MinuteSelect({
  value,
  onChange,
  label,
  min = 0,
  max = 1440,
  id,
}: {
  value: number;
  onChange: (minute: number) => void;
  label: string;
  min?: number;
  max?: number;
  id?: string;
}) {
  return (
    <select
      id={id}
      className="aibk-input aibk-minute"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {MINUTE_OPTIONS.filter((minute) => minute >= min && minute <= max).map((minute) => (
        <option key={minute} value={minute}>
          {minuteLabel(minute)}
        </option>
      ))}
    </select>
  );
}

export function WeeklyEditor({
  adapter,
  hostId,
  weekly,
  onSaved,
}: {
  adapter: BookingAdminAdapter;
  hostId: string;
  weekly: readonly WeeklyWindow[];
  onSaved: () => void;
}) {
  const [days, setDays] = useState<EditWindow[][]>(() => weekFrom(weekly));
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useAction(
    () => adapter.setWeekly({ hostId, windows: weekToWindows(days) }),
    () => {
      setDirty(false);
      setSaved(true);
      onSaved();
    },
  );
  const problem = weekProblem(days);

  const update = (day: number, next: EditWindow[]) => {
    setDays(days.map((windows, i) => (i === day ? next : windows)));
    setDirty(true);
    setSaved(false);
  };

  const addWindow = (day: number) => {
    const windows = days[day] ?? [];
    const last = windows[windows.length - 1];
    const start = last ? Math.min(last.end + 60, 1380) : 540;
    update(day, [...windows, { start, end: Math.min(start + 240, 1440) }]);
  };

  return (
    <Card id="week" title="Your week" hint="The hours people can book, every week, until you change them.">
      <div className="aibk-week">
        {WEEKDAYS.map((name, day) => {
          const windows = days[day] ?? [];
          return (
            <div key={name} className="aibk-week-day" data-aibk-day={day}>
              <p className="aibk-week-name">{name}</p>
              <div className="aibk-week-windows">
                {windows.length === 0 ? <p className="aibk-hint aibk-week-closed">Not bookable</p> : null}
                {windows.map((window, i) => (
                  <div key={i} className="aibk-row">
                    <MinuteSelect
                      label={`${name} window ${i + 1} start`}
                      value={window.start}
                      max={1425}
                      onChange={(start) => update(day, windows.map((w, j) => (j === i ? { ...w, start } : w)))}
                    />
                    <span className="aibk-hint">to</span>
                    <MinuteSelect
                      label={`${name} window ${i + 1} end`}
                      value={window.end}
                      min={15}
                      onChange={(end) => update(day, windows.map((w, j) => (j === i ? { ...w, end } : w)))}
                    />
                    <button
                      type="button"
                      className="aibk-btn aibk-btn-secondary"
                      onClick={() => update(day, windows.filter((_, j) => j !== i))}
                      aria-label={`Remove ${name} window ${i + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="aibk-btn aibk-btn-secondary" onClick={() => addWindow(day)} aria-label={`Add hours on ${name}`}>
                Add hours
              </button>
            </div>
          );
        })}
      </div>
      <div className="aibk-row">
        <button
          type="button"
          className="aibk-btn aibk-btn-primary"
          disabled={!dirty || problem !== null || save.pending}
          aria-busy={save.pending || undefined}
          onClick={() => void save.run()}
        >
          {save.pending ? "Saving…" : "Save week"}
        </button>
        <Outcome error={problem ?? save.error} ok={saved && !dirty ? "Saved. Your booking page uses it now." : null} />
      </div>
    </Card>
  );
}

/**
 * Add one row per date, in order, stopping at the first failure — and say
 * exactly which dates made it, so a half-added week is visible, not silent.
 */
async function addEach(
  dates: readonly string[],
  add: (date: string) => Promise<unknown>,
  onProgress: (done: number) => void,
): Promise<{ added: string[]; failed: { date: string; message: string } | null }> {
  const added: string[] = [];
  for (const date of dates) {
    try {
      await add(date);
      added.push(date);
      onProgress(added.length);
    } catch (error) {
      return { added, failed: { date, message: errorText(error) } };
    }
  }
  return { added, failed: null };
}

function rangeReport(
  result: { added: string[]; failed: { date: string; message: string } | null },
  locale: string,
): string | null {
  if (!result.failed) return null;
  const done = result.added.length
    ? `Added ${formatDateRange(result.added[0]!, result.added[result.added.length - 1]!, locale)}. `
    : "";
  return `${done}Stopped at ${formatDateRange(result.failed.date, result.failed.date, locale)}: ${result.failed.message}`;
}

export function TimeOff({
  adapter,
  host,
  exceptions,
  locale,
  onChanged,
}: {
  adapter: BookingAdminAdapter;
  host: AdminHost;
  exceptions: readonly AdminException[];
  locale: string;
  onChanged: () => void;
}) {
  const today = todayIn(host.timezone);
  const [date, setDate] = useState(today);
  const [until, setUntil] = useState("");
  const [kind, setKind] = useState<ExceptionKind>("off");
  const [start, setStart] = useState(720);
  const [end, setEnd] = useState(840);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const ids = { date: useId(), until: useId(), kind: useId(), note: useId() };
  const timed = kind !== "off";
  const range = datesInRange(date, until || null);
  const rangeError = "error" in range ? range.error : null;
  const timeError = timed && end <= start ? "The end has to be after the start." : null;
  const groups = groupExceptions(exceptions);

  const add = async () => {
    if (!("dates" in range) || timeError) return;
    setReport(null);
    setBusy(`Adding 1 of ${range.dates.length}…`);
    const result = await addEach(
      range.dates,
      (day) =>
        adapter.addException({
          hostId: host.id,
          date: day,
          kind,
          ...(timed ? { startMinute: start, endMinute: end } : {}),
          note: note.trim() || null,
        }),
      (done) => setBusy(done < range.dates.length ? `Adding ${done + 1} of ${range.dates.length}…` : null),
    );
    setBusy(null);
    setReport(rangeReport(result, locale));
    if (!result.failed) {
      setNote("");
      setUntil("");
    }
    if (result.added.length > 0) onChanged();
  };

  const removeGroup = async (groupIds: readonly string[], key: string) => {
    setRemoveError(null);
    setRemoving(key);
    try {
      for (const id of groupIds) await adapter.removeException(id);
    } catch (error) {
      setRemoveError(errorText(error));
    }
    setRemoving(null);
    onChanged();
  };

  return (
    <Card
      id="timeoff"
      title="Time off and one-off hours"
      hint="A day off, different hours, or a block (a dentist appointment) — for one date, or every date up to an end date."
    >
      <div className="aibk-form-row">
        <div className="aibk-field">
          <label className="aibk-label" htmlFor={ids.date}>
            Date
          </label>
          <input id={ids.date} className="aibk-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
        <div className="aibk-field">
          <label className="aibk-label" htmlFor={ids.until}>
            Until <span className="aibk-optional">(optional)</span>
          </label>
          <input
            id={ids.until}
            className="aibk-input"
            type="date"
            value={until}
            min={date || undefined}
            onChange={(event) => setUntil(event.target.value)}
          />
        </div>
        <div className="aibk-field">
          <label className="aibk-label" htmlFor={ids.kind}>
            What
          </label>
          <select id={ids.kind} className="aibk-input" value={kind} onChange={(event) => setKind(event.target.value as ExceptionKind)}>
            <option value="off">Day off</option>
            <option value="hours">Different hours that day</option>
            <option value="block">Block part of the day</option>
          </select>
        </div>
        {timed ? (
          <div className="aibk-field">
            <span className="aibk-label">Hours</span>
            <div className="aibk-row">
              <MinuteSelect label="Start time" value={start} max={1425} onChange={setStart} />
              <span className="aibk-hint">to</span>
              <MinuteSelect label="End time" value={end} min={15} onChange={setEnd} />
            </div>
          </div>
        ) : null}
        <div className="aibk-field aibk-grow">
          <label className="aibk-label" htmlFor={ids.note}>
            Note <span className="aibk-optional">(only you see it)</span>
          </label>
          <input id={ids.note} className="aibk-input" value={note} maxLength={200} placeholder="Vacation" onChange={(event) => setNote(event.target.value)} />
        </div>
      </div>
      <div className="aibk-row">
        <button
          type="button"
          className="aibk-btn aibk-btn-primary"
          disabled={busy !== null || rangeError !== null || timeError !== null}
          aria-busy={busy !== null || undefined}
          onClick={() => void add()}
        >
          {busy ?? ("dates" in range && range.dates.length > 1 ? `Add ${range.dates.length} days` : "Add")}
        </button>
        <Outcome error={rangeError ?? timeError ?? report} />
      </div>

      {groups.length === 0 ? (
        <p className="aibk-hint">Nothing coming up.</p>
      ) : (
        <ul className="aibk-rows" aria-label="Time off and one-off hours">
          {groups.map((group) => {
            const key = group.ids.join(",");
            return (
              <li key={key} className="aibk-list-row" data-aibk-exception={group.kind}>
                <span>{describeExceptionGroup(group, locale)}</span>
                {group.note ? <span className="aibk-hint">{group.note}</span> : null}
                <button
                  type="button"
                  className="aibk-btn aibk-btn-secondary aibk-push"
                  disabled={removing !== null}
                  aria-busy={removing === key || undefined}
                  onClick={() => void removeGroup(group.ids, key)}
                >
                  {removing === key ? "Removing…" : group.days > 1 ? `Remove all ${group.days}` : "Remove"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Outcome error={removeError} />
    </Card>
  );
}

export function Holidays({
  adapter,
  hostZone,
  blackouts,
  locale,
  onChanged,
}: {
  adapter: BookingAdminAdapter;
  hostZone: string;
  blackouts: readonly AdminBlackout[];
  locale: string;
  onChanged: () => void;
}) {
  const today = todayIn(hostZone);
  const [date, setDate] = useState(today);
  const [until, setUntil] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const ids = { date: useId(), until: useId(), label: useId() };
  const range = datesInRange(date, until || null);
  const rangeError = "error" in range ? range.error : null;
  const groups = groupBlackouts(blackouts.filter((row) => row.date >= today));

  const add = async () => {
    if (!("dates" in range)) return;
    setReport(null);
    setBusy(`Adding 1 of ${range.dates.length}…`);
    const result = await addEach(
      range.dates,
      (day) => adapter.addBlackout({ date: day, label: label.trim() || null }),
      (done) => setBusy(done < range.dates.length ? `Adding ${done + 1} of ${range.dates.length}…` : null),
    );
    setBusy(null);
    setReport(rangeReport(result, locale));
    if (!result.failed) {
      setLabel("");
      setUntil("");
    }
    if (result.added.length > 0) onChanged();
  };

  const removeGroup = async (groupIds: readonly string[], key: string) => {
    setRemoveError(null);
    setRemoving(key);
    try {
      for (const id of groupIds) await adapter.removeBlackout(id);
    } catch (error) {
      setRemoveError(errorText(error));
    }
    setRemoving(null);
    onChanged();
  };

  return (
    <Card id="holidays" title="Holidays" hint="Dates nobody can book, whatever the week says. One date, or every date up to an end date.">
      <div className="aibk-form-row">
        <div className="aibk-field">
          <label className="aibk-label" htmlFor={ids.date}>
            Date
          </label>
          <input id={ids.date} className="aibk-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
        <div className="aibk-field">
          <label className="aibk-label" htmlFor={ids.until}>
            Until <span className="aibk-optional">(optional)</span>
          </label>
          <input
            id={ids.until}
            className="aibk-input"
            type="date"
            value={until}
            min={date || undefined}
            onChange={(event) => setUntil(event.target.value)}
          />
        </div>
        <div className="aibk-field aibk-grow">
          <label className="aibk-label" htmlFor={ids.label}>
            Label
          </label>
          <input id={ids.label} className="aibk-input" value={label} maxLength={120} placeholder="Thanksgiving" onChange={(event) => setLabel(event.target.value)} />
        </div>
      </div>
      <div className="aibk-row">
        <button
          type="button"
          className="aibk-btn aibk-btn-primary"
          disabled={busy !== null || rangeError !== null}
          aria-busy={busy !== null || undefined}
          onClick={() => void add()}
        >
          {busy ?? ("dates" in range && range.dates.length > 1 ? `Add ${range.dates.length} holidays` : "Add holiday")}
        </button>
        <Outcome error={rangeError ?? report} />
      </div>
      {groups.length === 0 ? (
        <p className="aibk-hint">No holidays coming up.</p>
      ) : (
        <ul className="aibk-rows" aria-label="Holidays">
          {groups.map((group) => {
            const key = group.ids.join(",");
            return (
              <li key={key} className="aibk-list-row" data-aibk-holiday="">
                <span>
                  {formatDateRange(group.from, group.to, locale)} · {group.label ?? "Holiday"}
                  {group.days > 1 ? ` · ${group.days} days` : ""}
                </span>
                <button
                  type="button"
                  className="aibk-btn aibk-btn-secondary aibk-push"
                  disabled={removing !== null}
                  aria-busy={removing === key || undefined}
                  onClick={() => void removeGroup(group.ids, key)}
                >
                  {removing === key ? "Removing…" : group.days > 1 ? `Remove all ${group.days}` : "Remove"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Outcome error={removeError} />
    </Card>
  );
}
