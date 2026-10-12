import { useId, useMemo, useState, type FormEvent } from "react";
import { isValidEmail } from "../form.js";
import type { ClientError } from "../http.js";
import { describedBy, Field, Notice } from "../parts.js";
import { describeShortWhen, formatClock, formatDuration, formatTimeRange, isDate, minutesOf, timeOf } from "../time.js";
import type { SchedulingAdminTransport } from "./client.js";
import { adminErrorText, driveLabel, issuesByField } from "./helpers.js";
import type { CalendarResource, CreateVisitBody, ServiceWire, StaffSlot, VisitMutationResponse } from "./types.js";
import { Check, Dialog } from "./ui.js";

/**
 * "New visit" (contract 8.5): a phone-in booking, in the order a person
 * takes the call — what they need, who and where, then a time. **Find times**
 * asks the server for the best-scored openings near the customer's address
 * (drive time from the job before, by crew); pick one, or type a day, a start
 * and a crew by hand. A visit lands confirmed unless staff choose "request".
 */

export function NewVisitDialog({
  transport,
  resources,
  services,
  slotStepMinutes,
  defaultDate,
  customerEmails = true,
  locale,
  onClose,
  onCreated,
}: {
  transport: SchedulingAdminTransport;
  resources: readonly CalendarResource[];
  services: readonly ServiceWire[] | null;
  slotStepMinutes: number;
  defaultDate: string;
  /** False: no customer email can leave, so no confirmation is offered. Default true. */
  customerEmails?: boolean;
  locale: string;
  onClose: () => void;
  onCreated: (result: VisitMutationResponse) => void;
}) {
  const ids = useId();
  const serviceList = services ?? [];
  const active = resources.filter((r) => r.isActive);
  const [service, setService] = useState(serviceList[0]?.key ?? "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState("09:00");
  const [crew, setCrew] = useState(active[0]?.id ?? "");
  const [status, setStatus] = useState<"confirmed" | "pending">("confirmed");
  const [notify, setNotify] = useState(true);
  const [suggestions, setSuggestions] = useState<{ slots: StaffSlot[]; estimated: boolean } | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const fieldErrors = issuesByField(error);
  const chosen = serviceList.find((s) => s.key === service) ?? null;
  const starts = useMemo(() => {
    const out: string[] = [];
    for (let m = 0; m < 1440; m += Math.max(5, slotStepMinutes)) out.push(timeOf(m));
    if (!out.includes(start)) out.push(start);
    return out.sort((a, b) => minutesOf(a) - minutesOf(b));
  }, [slotStepMinutes, start]);

  const findTimes = async () => {
    setFinding(true);
    setFindError(null);
    setPicked(null);
    const res = await transport.suggest({
      ...(chosen ? { service: chosen.key } : { minutes: 60 }),
      ...(address.trim() ? { address: address.trim() } : {}),
      ...(isDate(date) ? { from: date } : {}),
      days: 7,
    });
    setFinding(false);
    if (!res.ok) {
      setFindError(adminErrorText(res.error));
      setSuggestions(null);
      return;
    }
    setSuggestions({ slots: res.data.slots, estimated: res.data.estimated });
  };

  const pick = (index: number, slot: StaffSlot) => {
    setPicked(index);
    setDate(slot.date);
    setStart(slot.startTime);
    setCrew(slot.resourceId);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setLocalError("Enter the customer's name.");
      return;
    }
    if (email.trim() && !isValidEmail(email)) {
      setLocalError("That email address doesn't look right.");
      return;
    }
    if (!isDate(date)) {
      setLocalError("Pick a day.");
      return;
    }
    setLocalError(null);
    setBusy(true);
    setError(null);
    const body: CreateVisitBody = {
      resourceId: crew || null,
      date,
      startTime: start,
      ...(chosen ? { service: chosen.key } : {}),
      customerName: name.trim(),
      ...(email.trim() ? { customerEmail: email.trim() } : {}),
      ...(phone.trim() ? { customerPhone: phone.trim() } : {}),
      ...(address.trim() ? { address: address.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      status,
      notify: email.trim() && customerEmails ? notify : false,
    };
    const res = await transport.createVisit(body);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onCreated(res.data);
  };

  return (
    <Dialog title="New visit" onClose={onClose} data={{ "aisw-new-visit": "" }}>
      <form className="aisw-stack" onSubmit={(event) => void submit(event)} noValidate>
        <Field id={`${ids}-service`} label="Service" error={fieldErrors.service ?? null}>
          {serviceList.length > 0 ? (
            <select id={`${ids}-service`} className="aisw-input" value={service} data-autofocus="" onChange={(event) => setService(event.target.value)}>
              {serviceList.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name} ({formatDuration(s.durationMinutes)})
                </option>
              ))}
            </select>
          ) : (
            <p className="aisw-hint" id={`${ids}-service`}>
              A one-hour visit. (Add services under Schedule settings.)
            </p>
          )}
        </Field>
        <Field id={`${ids}-name`} label="Customer name" error={fieldErrors.customerName ?? null}>
          <input
            id={`${ids}-name`}
            className="aisw-input"
            value={name}
            maxLength={200}
            autoComplete="off"
            aria-describedby={describedBy(`${ids}-name`, false, fieldErrors.customerName)}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="aisw-grid2">
          <Field id={`${ids}-email`} label="Email" optional error={fieldErrors.customerEmail ?? null}>
            <input id={`${ids}-email`} className="aisw-input" type="email" value={email} maxLength={320} autoComplete="off" onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field id={`${ids}-phone`} label="Phone" optional error={fieldErrors.customerPhone ?? null}>
            <input id={`${ids}-phone`} className="aisw-input" type="tel" value={phone} maxLength={60} autoComplete="off" onChange={(event) => setPhone(event.target.value)} />
          </Field>
        </div>
        <Field id={`${ids}-address`} label="Address" optional hint="Used to find times close to the crew's other jobs." error={fieldErrors.address ?? null}>
          <input
            id={`${ids}-address`}
            className="aisw-input"
            value={address}
            maxLength={500}
            autoComplete="off"
            aria-describedby={describedBy(`${ids}-address`, true, fieldErrors.address)}
            onChange={(event) => setAddress(event.target.value)}
          />
        </Field>
        <Field id={`${ids}-notes`} label="Notes" optional>
          <textarea id={`${ids}-notes`} className="aisw-input" rows={2} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>

        <div className="aisw-panel-box">
          <div className="aisw-row">
            <strong className="aisw-grow">When</strong>
            <button type="button" className="aisw-btn aisw-btn-secondary aisw-btn-sm" onClick={() => void findTimes()} disabled={finding} aria-busy={finding || undefined}>
              {finding ? "Finding times…" : "Find times"}
            </button>
          </div>
          {findError ? <Notice tone="error">{findError}</Notice> : null}
          {suggestions ? (
            suggestions.slots.length === 0 ? (
              <p className="aisw-hint" role="status">
                No open times in the next week. Enter a day and time by hand below.
              </p>
            ) : (
              <ul className="aisw-suggestions" aria-label="Suggested times, best first" data-aisw-suggestions="">
                {suggestions.slots.map((slot, index) => (
                  <li key={`${slot.date}-${slot.startTime}-${slot.resourceId}`}>
                    <button type="button" className="aisw-suggestion" aria-pressed={picked === index} onClick={() => pick(index, slot)}>
                      <span>
                        <strong>{describeShortWhen(slot, locale)}</strong> · {formatTimeRange(slot.startTime, slot.endTime, locale)} · {slot.resourceName}
                      </span>
                      <small>{driveLabel(slot, suggestions.estimated)}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="aisw-hint">Find times suggests the best openings for this address, or set them yourself.</p>
          )}
          <div className="aisw-grid2">
            <Field id={`${ids}-date`} label="Day" error={fieldErrors.date ?? null}>
              <input id={`${ids}-date`} className="aisw-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </Field>
            <Field id={`${ids}-start`} label="Starts" error={fieldErrors.startTime ?? null}>
              <select id={`${ids}-start`} className="aisw-input" value={start} onChange={(event) => setStart(event.target.value)}>
                {starts.map((t) => (
                  <option key={t} value={t}>
                    {formatClock(t, locale)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field id={`${ids}-crew`} label="Crew" error={fieldErrors.resourceId ?? null}>
            <select id={`${ids}-crew`} className="aisw-input" value={crew} onChange={(event) => setCrew(event.target.value)}>
              <option value="">Not assigned yet</option>
              {active.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <fieldset className="aisw-stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="aisw-label">Book it as</legend>
          <label className="aisw-check">
            <input type="radio" name={`${ids}-status`} checked={status === "confirmed"} onChange={() => setStatus("confirmed")} />
            <span>Confirmed — it's on the calendar</span>
          </label>
          <label className="aisw-check">
            <input type="radio" name={`${ids}-status`} checked={status === "pending"} onChange={() => setStatus("pending")} />
            <span>A request — someone still has to accept it</span>
          </label>
        </fieldset>
        {!customerEmails ? (
          <p className="aisw-hint" data-aisw-no-email="">
            Customer emails are off, so no confirmation is sent. Tell the customer the time yourself.
          </p>
        ) : email.trim() ? (
          <Check checked={notify} onChange={setNotify} label={`Email ${name.trim().split(/\s+/)[0] || "the customer"} a confirmation`} />
        ) : (
          <p className="aisw-hint">Add an email to send the customer a confirmation.</p>
        )}
        {localError ? (
          <p className="aisw-field-error" role="alert">
            {localError}
          </p>
        ) : null}
        {error ? <Notice tone="error">{adminErrorText(error)}</Notice> : null}
        <div className="aisw-actions">
          <button type="submit" className="aisw-btn aisw-btn-primary" disabled={busy} aria-busy={busy || undefined}>
            {busy ? "Booking…" : "Book visit"}
          </button>
          <button type="button" className="aisw-btn aisw-btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
