import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { ClientError, Result } from "../http.js";
import { describedBy, Field, Notice, telHref } from "../parts.js";
import {
  clockIn,
  describeShortWhen,
  describeVisitWhen,
  formatClock,
  formatShortDate,
  isDate,
  minutesOf,
  timeOf,
  todayIn,
} from "../time.js";
import type { SchedulingAdminTransport } from "./client.js";
import {
  adminErrorText,
  expiresIn,
  isMovable,
  issuesByField,
  STATUS_LABEL,
  statusTagClass,
  visitActions,
  type VisitAction,
} from "./helpers.js";
import type { CalendarResource, DetailsBody, ServiceWire, VisitMutationResponse, VisitSnapshot } from "./types.js";
import { Check, Dialog } from "./ui.js";

/**
 * The visit panel (contract 8.5): a drawer down the right edge — the whole
 * screen on a phone — focus trapped, closed with Escape, focus back on the
 * block that opened it.
 *
 * Everything staff can do to one visit is here, by keyboard as well as by
 * pointer: the status moves the server offers (Accept / Decline on a request;
 * Start / Complete / No-show / Cancel on a confirmed visit; Restore on one
 * that no longer holds time), **Move…** (the keyboard path for every drag),
 * **Change crew**, and **Edit details**. Every action the customer would hear
 * about has the "Email the customer" box, ticked by default — unless no
 * customer email can leave this deployment (`customerEmails` false), when the
 * panel says the customer won't be told instead of offering a box that sends
 * nothing.
 */

export interface PanelChange {
  visit: VisitSnapshot;
  message: string;
  warnings?: string[];
}

type Sub = { kind: "view" } | { kind: "move" } | { kind: "crew" } | { kind: "details" } | { kind: "reason"; action: VisitAction };

export function VisitPanel({
  visit,
  transport,
  resources,
  services,
  slotStepMinutes,
  canManage,
  customerEmails = true,
  locale,
  nowMs,
  onClose,
  onChanged,
  returnFocus,
}: {
  visit: VisitSnapshot;
  transport: SchedulingAdminTransport;
  resources: readonly CalendarResource[];
  services: readonly ServiceWire[] | null;
  slotStepMinutes: number;
  canManage: boolean;
  /** False: no customer email can leave, so none is offered. Default true. */
  customerEmails?: boolean;
  locale: string;
  nowMs: number;
  onClose: () => void;
  onChanged: (change: PanelChange) => void;
  returnFocus: () => HTMLElement | null;
}) {
  const ids = useId();
  const [sub, setSub] = useState<Sub>({ kind: "view" });
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [reason, setReason] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const zone = visit.timeZone;

  // Moving between the panel's views moves focus to the new view's first
  // field (or first button), so a keyboard user lands where the content is.
  const lastSub = useRef(sub.kind);
  useEffect(() => {
    if (lastSub.current === sub.kind) return;
    lastSub.current = sub.kind;
    const root = bodyRef.current;
    if (!root) return;
    const target =
      root.querySelector<HTMLElement>("[data-autofocus]") ??
      root.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])");
    target?.focus();
  }, [sub.kind]);
  const movable = isMovable(visit);
  const actions = canManage ? visitActions(visit) : [];
  const firstName = visit.customerName?.trim().split(/\s+/)[0] ?? "";
  // An email on file AND a deployment that sends: only then is "email them" a real choice.
  const hasEmail = Boolean(visit.customerEmail) && customerEmails;
  const notifyLabel = hasEmail ? `Email ${firstName || "the customer"} about this` : null;
  const noEmailHint = !visit.customerEmail
    ? "No email on file, so the customer won't be told about changes."
    : `Customer emails are off, so ${firstName || "the customer"} won't be told about changes. Call them.`;

  const run = async (label: string, call: () => Promise<Result<{ visit: VisitSnapshot } | VisitMutationResponse>>, message: (v: VisitSnapshot) => string) => {
    setBusy(label);
    setError(null);
    const res = await call();
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    const found = "warnings" in res.data ? res.data.warnings : [];
    setWarnings(found);
    onChanged({ visit: res.data.visit, message: message(res.data.visit), warnings: found });
    return true;
  };

  const doAction = async (action: VisitAction, withReason?: string) => {
    const trimmed = withReason?.trim() ?? "";
    const body = { ...(action.customerFacing ? { notify } : {}), ...(trimmed ? { reason: trimmed.slice(0, 500) } : {}) };
    const ok = await run(
      action.label,
      () =>
        action.route === "accept"
          ? transport.accept(visit.id, action.customerFacing ? { notify } : {})
          : action.route === "decline"
            ? transport.decline(visit.id, body)
            : transport.setStatus(visit.id, { status: action.to, ...body }),
      (next) => `${next.customerName ?? "Visit"}: ${STATUS_LABEL[next.status].toLowerCase()}.`,
    );
    if (ok) {
      setReason("");
      setSub({ kind: "view" });
    }
  };

  const title = visit.customerName ?? visit.title ?? visit.serviceName;
  const expiry = visit.status === "pending" ? expiresIn(visit.pendingExpiresAt, nowMs) : null;
  const requestedAt = visit.createdAt && Number.isFinite(Date.parse(visit.createdAt))
    ? `${formatShortDate(todayIn(zone, new Date(visit.createdAt)), locale)} at ${formatClock(clockIn(zone, visit.createdAt), locale)}`
    : null;
  const directions = visit.address
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(visit.address)}&travelmode=driving`
    : null;

  let body;
  if (sub.kind === "move") {
    body = (
      <MoveForm
        visit={visit}
        resources={resources}
        slotStepMinutes={slotStepMinutes}
        locale={locale}
        notifyLabel={notifyLabel}
        onBack={() => {
          setError(null);
          setSub({ kind: "view" });
        }}
        onSubmit={async (target, notifyChoice) => {
          const timeChanged = target.date !== visit.date || target.startTime !== visit.startTime || target.endTime !== visit.endTime;
          const crewChanged = target.resourceId !== visit.resourceId && target.resourceId !== null;
          if (!timeChanged && !crewChanged) {
            setError({ code: "invalid", message: "Nothing changed: pick a new day, time or crew.", status: 0 });
            return;
          }
          const ok = await run(
            "move",
            () =>
              timeChanged
                ? transport.reschedule(visit.id, {
                    date: target.date,
                    startTime: target.startTime,
                    endTime: target.endTime,
                    ...(crewChanged && target.resourceId ? { resourceId: target.resourceId } : {}),
                    ...(hasEmail ? { notify: notifyChoice } : {}),
                  })
                : transport.assign(visit.id, { resourceId: target.resourceId!, ...(hasEmail ? { notify: notifyChoice } : {}) }),
            (next) =>
              timeChanged
                ? `Moved to ${describeShortWhen(next, locale)}${next.resourceName ? ` with ${next.resourceName}` : ""}.`
                : `Now with ${next.resourceName ?? "the new crew"}.`,
          );
          if (ok) setSub({ kind: "view" });
        }}
        busy={busy === "move"}
        error={error}
      />
    );
  } else if (sub.kind === "crew") {
    body = (
      <CrewForm
        visit={visit}
        resources={resources}
        notifyLabel={notifyLabel}
        busy={busy === "crew"}
        error={error}
        onBack={() => {
          setError(null);
          setSub({ kind: "view" });
        }}
        onSubmit={async (resourceId, notifyChoice) => {
          if (resourceId === visit.resourceId) {
            setError({ code: "invalid", message: "That's the crew it already has.", status: 0 });
            return;
          }
          const ok = await run(
            "crew",
            () => transport.assign(visit.id, { resourceId, ...(hasEmail ? { notify: notifyChoice } : {}) }),
            (next) => `Now with ${next.resourceName ?? "the new crew"}.`,
          );
          if (ok) setSub({ kind: "view" });
        }}
      />
    );
  } else if (sub.kind === "details") {
    body = (
      <DetailsForm
        visit={visit}
        services={services}
        customerEmails={customerEmails}
        busy={busy === "details"}
        error={error}
        onBack={() => {
          setError(null);
          setSub({ kind: "view" });
        }}
        onSubmit={async (patch) => {
          if (Object.keys(patch).length === 0) {
            setSub({ kind: "view" });
            return;
          }
          const ok = await run("details", () => transport.updateDetails(visit.id, patch), () => "Details saved.");
          if (ok) setSub({ kind: "view" });
        }}
      />
    );
  } else if (sub.kind === "reason") {
    const action = sub.action;
    body = (
      <div className="aisw-stack" data-aisw-reason={action.to}>
        <p>
          {action.route === "decline"
            ? `Decline ${visit.customerName ?? "this"}'s request for ${describeShortWhen(visit, locale)}?`
            : `Cancel ${visit.customerName ?? "this"}'s visit on ${describeShortWhen(visit, locale)}?`}
        </p>
        <Field
          id={`${ids}-reason`}
          label={hasEmail ? "A note for the customer" : "Why"}
          optional
          hint={hasEmail ? "It goes in the email, word for word." : "Saved with the visit."}
        >
          <textarea
            id={`${ids}-reason`}
            className="aisw-input"
            rows={3}
            maxLength={500}
            value={reason}
            aria-describedby={`${ids}-reason-hint`}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {notifyLabel ? <Check checked={notify} onChange={setNotify} label={notifyLabel} /> : <p className="aisw-hint">{noEmailHint}</p>}
        {error ? <Notice tone="error">{adminErrorText(error)}</Notice> : null}
        <div className="aisw-actions">
          <button
            type="button"
            className="aisw-btn aisw-btn-danger"
            disabled={busy !== null}
            aria-busy={busy !== null || undefined}
            onClick={() => void doAction(action, reason)}
          >
            {busy ? "Saving…" : action.route === "decline" ? "Decline request" : "Cancel visit"}
          </button>
          <button
            type="button"
            className="aisw-btn aisw-btn-secondary"
            onClick={() => {
              setError(null);
              setSub({ kind: "view" });
            }}
          >
            Back
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="aisw-stack" data-aisw-panel-view="">
        {warnings.length > 0 ? (
          <Notice tone="warn">
            {warnings.map((w) => (
              <span key={w} style={{ display: "block" }}>
                {w}
              </span>
            ))}
          </Notice>
        ) : null}
        <div className="aisw-row">
          <span className={statusTagClass(visit.status)} data-aisw-status={visit.status}>
            {STATUS_LABEL[visit.status]}
          </span>
          <span className="aisw-hint">{visit.origin === "public" ? "Booked online" : "Booked by staff"}</span>
        </div>
        {visit.status === "pending" ? (
          <p className="aisw-hint">
            {requestedAt ? `Requested ${requestedAt}` : "Requested online"}
            {expiry ? ` · ${expiry}` : ""}
          </p>
        ) : null}
        <dl className="aisw-kv">
          <dt>When</dt>
          <dd>{describeVisitWhen(visit, locale)}</dd>
          <dt>Crew</dt>
          <dd>{visit.resourceName ?? "Not assigned yet"}</dd>
          <dt>Service</dt>
          <dd>{visit.serviceName}</dd>
          {visit.title ? (
            <>
              <dt>Label</dt>
              <dd>{visit.title}</dd>
            </>
          ) : null}
          <dt>Customer</dt>
          <dd>
            {visit.customerName ?? "—"}
            {visit.customerPhone ? (
              <>
                <br />
                <a href={telHref(visit.customerPhone)}>{visit.customerPhone}</a>
              </>
            ) : null}
            {visit.customerEmail ? (
              <>
                <br />
                <a href={`mailto:${visit.customerEmail}`}>{visit.customerEmail}</a>
              </>
            ) : null}
          </dd>
          <dt>Address</dt>
          <dd>
            {visit.address ?? "—"}
            {directions ? (
              <>
                <br />
                <a href={directions} target="_blank" rel="noopener noreferrer">
                  Directions<span className="aisw-sr"> (opens in a new tab)</span>
                </a>
              </>
            ) : null}
          </dd>
          {visit.notes ? (
            <>
              <dt>Notes</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{visit.notes}</dd>
            </>
          ) : null}
          {visit.cancelReason ? (
            <>
              <dt>Reason</dt>
              <dd>{visit.cancelReason}</dd>
            </>
          ) : null}
          {visit.estimateId ? (
            <>
              <dt>Estimate</dt>
              <dd>{visit.estimateId}</dd>
            </>
          ) : null}
        </dl>

        {canManage ? (
          <>
            {actions.some((a) => a.customerFacing) ? (
              notifyLabel ? (
                <Check checked={notify} onChange={setNotify} label={notifyLabel} />
              ) : (
                <p className="aisw-hint" data-aisw-no-email="">
                  {noEmailHint}
                </p>
              )
            ) : null}
            {error ? <Notice tone="error">{adminErrorText(error)}</Notice> : null}
            {actions.length > 0 ? (
              <div className="aisw-actions" role="group" aria-label="Change the status">
                {actions.map((action) => (
                  <button
                    key={action.to}
                    type="button"
                    className={`aisw-btn ${action.tone === "primary" ? "aisw-btn-primary" : action.tone === "danger" ? "aisw-btn-danger-outline" : "aisw-btn-secondary"}`}
                    disabled={busy !== null}
                    aria-busy={busy === action.label || undefined}
                    data-action={action.to}
                    onClick={() => {
                      setError(null);
                      if (action.asksReason) setSub({ kind: "reason", action });
                      else void doAction(action);
                    }}
                  >
                    {busy === action.label ? "Saving…" : action.label}
                  </button>
                ))}
              </div>
            ) : null}
            <hr className="aisw-divider" />
            {movable ? (
              <div className="aisw-actions">
                <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => { setError(null); setSub({ kind: "move" }); }}>
                  Move…
                </button>
                <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => { setError(null); setSub({ kind: "crew" }); }}>
                  Change crew
                </button>
              </div>
            ) : (
              <p className="aisw-hint">Only requests and confirmed visits can be moved or given another crew.</p>
            )}
            <div className="aisw-actions">
              <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => { setError(null); setSub({ kind: "details" }); }}>
                Edit details
              </button>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  const heading =
    sub.kind === "move" ? "Move visit" : sub.kind === "crew" ? "Change crew" : sub.kind === "details" ? "Edit details" : title;

  return (
    <Dialog title={heading} onClose={onClose} variant="drawer" returnFocus={returnFocus} data={{ "aisw-panel": visit.id }}>
      <div ref={bodyRef} className="aisw-stack">
        {body}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Move…
// ---------------------------------------------------------------------------

/** The start times offered: the business's grid, plus the visit's own time if it is off the grid. */
function gridTimes(step: number, include: readonly string[], max = 1440): string[] {
  const set = new Set<string>();
  for (let m = 0; m <= max; m += Math.max(5, step)) set.add(timeOf(m));
  for (const t of include) if (Number.isFinite(minutesOf(t))) set.add(t);
  return [...set].sort((a, b) => minutesOf(a) - minutesOf(b));
}

export interface MoveTarget {
  date: string;
  startTime: string;
  endTime: string;
  resourceId: string | null;
}

function MoveForm({
  visit,
  resources,
  slotStepMinutes,
  locale,
  notifyLabel,
  onBack,
  onSubmit,
  busy,
  error,
}: {
  visit: VisitSnapshot;
  resources: readonly CalendarResource[];
  slotStepMinutes: number;
  locale: string;
  notifyLabel: string | null;
  onBack: () => void;
  onSubmit: (target: MoveTarget, notify: boolean) => void;
  busy: boolean;
  error: ClientError | null;
}) {
  const ids = useId();
  const [date, setDate] = useState(visit.date);
  const [start, setStart] = useState(visit.startTime);
  const [end, setEnd] = useState(visit.endTime);
  const [crew, setCrew] = useState(visit.resourceId ?? "");
  const [notify, setNotify] = useState(true);
  const starts = useMemo(() => gridTimes(slotStepMinutes, [visit.startTime, start], 1435), [slotStepMinutes, visit.startTime, start]);
  const ends = useMemo(
    () => gridTimes(slotStepMinutes, [visit.endTime, end]).filter((t) => minutesOf(t) > minutesOf(start)),
    [slotStepMinutes, visit.endTime, end, start],
  );
  const fieldErrors = issuesByField(error);
  const local = !isDate(date)
    ? "Pick a date."
    : minutesOf(end) <= minutesOf(start)
      ? "The end has to be after the start."
      : null;
  const crews = resources.filter((r) => r.isActive || r.id === visit.resourceId);

  const changeStart = (value: string) => {
    // Keep the visit's length when the start moves, as a drag does.
    const length = minutesOf(end) - minutesOf(start);
    setStart(value);
    setEnd(timeOf(Math.min(1440, minutesOf(value) + Math.max(5, length))));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (local) return;
    onSubmit({ date, startTime: start, endTime: end, resourceId: crew || null }, notify);
  };

  return (
    <form className="aisw-stack" onSubmit={submit} noValidate data-aisw-move="">
      <p className="aisw-hint">Now: {describeVisitWhen(visit, locale)}{visit.resourceName ? `, ${visit.resourceName}` : ""}.</p>
      <Field id={`${ids}-date`} label="Day" error={fieldErrors.date ?? null}>
        <input
          id={`${ids}-date`}
          className="aisw-input"
          type="date"
          value={date}
          data-autofocus=""
          aria-invalid={fieldErrors.date ? true : undefined}
          aria-describedby={describedBy(`${ids}-date`, false, fieldErrors.date)}
          onChange={(event) => setDate(event.target.value)}
        />
      </Field>
      <div className="aisw-grid2">
        <Field id={`${ids}-start`} label="Starts" error={fieldErrors.startTime ?? null}>
          <select id={`${ids}-start`} className="aisw-input" value={start} onChange={(event) => changeStart(event.target.value)}>
            {starts.map((t) => (
              <option key={t} value={t}>
                {formatClock(t, locale)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${ids}-end`} label="Ends" error={fieldErrors.endTime ?? null}>
          <select id={`${ids}-end`} className="aisw-input" value={end} onChange={(event) => setEnd(event.target.value)}>
            {ends.map((t) => (
              <option key={t} value={t}>
                {formatClock(t, locale)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field id={`${ids}-crew`} label="Crew" error={fieldErrors.resourceId ?? null}>
        <select id={`${ids}-crew`} className="aisw-input" value={crew} onChange={(event) => setCrew(event.target.value)}>
          {visit.resourceId === null ? <option value="">Not assigned yet</option> : null}
          {crews.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {r.isActive ? "" : " (removed)"}
            </option>
          ))}
        </select>
      </Field>
      {notifyLabel ? <Check checked={notify} onChange={setNotify} label={notifyLabel} /> : null}
      {local ? <p className="aisw-field-error">{local}</p> : null}
      {error ? <Notice tone="error">{adminErrorText(error)}</Notice> : null}
      <div className="aisw-actions">
        <button type="submit" className="aisw-btn aisw-btn-primary" disabled={busy || local !== null} aria-busy={busy || undefined}>
          {busy ? "Moving…" : "Move visit"}
        </button>
        <button type="button" className="aisw-btn aisw-btn-secondary" onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  );
}

function CrewForm({
  visit,
  resources,
  notifyLabel,
  busy,
  error,
  onBack,
  onSubmit,
}: {
  visit: VisitSnapshot;
  resources: readonly CalendarResource[];
  notifyLabel: string | null;
  busy: boolean;
  error: ClientError | null;
  onBack: () => void;
  onSubmit: (resourceId: string, notify: boolean) => void;
}) {
  const ids = useId();
  const active = resources.filter((r) => r.isActive);
  const [crew, setCrew] = useState(visit.resourceId && active.some((r) => r.id === visit.resourceId) ? visit.resourceId : (active[0]?.id ?? ""));
  const [notify, setNotify] = useState(true);
  return (
    <form
      className="aisw-stack"
      noValidate
      data-aisw-crew=""
      onSubmit={(event) => {
        event.preventDefault();
        if (crew) onSubmit(crew, notify);
      }}
    >
      <p className="aisw-hint">Same time, another crew. Now: {visit.resourceName ?? "not assigned yet"}.</p>
      <Field id={`${ids}-crew`} label="Crew">
        <select id={`${ids}-crew`} className="aisw-input" value={crew} data-autofocus="" onChange={(event) => setCrew(event.target.value)}>
          {active.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      {notifyLabel ? <Check checked={notify} onChange={setNotify} label={notifyLabel} /> : null}
      {error ? <Notice tone="error">{adminErrorText(error)}</Notice> : null}
      <div className="aisw-actions">
        <button type="submit" className="aisw-btn aisw-btn-primary" disabled={busy || !crew} aria-busy={busy || undefined}>
          {busy ? "Saving…" : "Change crew"}
        </button>
        <button type="button" className="aisw-btn aisw-btn-secondary" onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Edit details
// ---------------------------------------------------------------------------

type DetailsValues = Record<"title" | "customerName" | "customerEmail" | "customerPhone" | "address" | "notes" | "serviceType", string>;

function DetailsForm({
  visit,
  services,
  customerEmails,
  busy,
  error,
  onBack,
  onSubmit,
}: {
  visit: VisitSnapshot;
  services: readonly ServiceWire[] | null;
  customerEmails: boolean;
  busy: boolean;
  error: ClientError | null;
  onBack: () => void;
  onSubmit: (patch: DetailsBody) => void;
}) {
  const ids = useId();
  const initial: DetailsValues = {
    title: visit.title ?? "",
    customerName: visit.customerName ?? "",
    customerEmail: visit.customerEmail ?? "",
    customerPhone: visit.customerPhone ?? "",
    address: visit.address ?? "",
    notes: visit.notes ?? "",
    serviceType: visit.serviceKey,
  };
  const [values, setValues] = useState<DetailsValues>(initial);
  const fieldErrors = issuesByField(error);
  const set = (key: keyof DetailsValues, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const serviceOptions = services && services.length > 0 ? services : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const patch: DetailsBody = {};
    for (const key of Object.keys(values) as Array<keyof DetailsValues>) {
      if (values[key] === initial[key]) continue;
      const trimmed = values[key].trim();
      if (key === "serviceType") {
        if (trimmed) patch.serviceType = trimmed;
      } else {
        patch[key] = trimmed === "" ? null : trimmed;
      }
    }
    onSubmit(patch);
  };

  const input = (key: keyof DetailsValues, label: string, type = "text", extra: { maxLength?: number; autoComplete?: string } = {}) => (
    <Field id={`${ids}-${key}`} label={label} optional error={fieldErrors[key] ?? null}>
      <input
        id={`${ids}-${key}`}
        className="aisw-input"
        type={type}
        value={values[key]}
        maxLength={extra.maxLength}
        autoComplete={extra.autoComplete ?? "off"}
        aria-invalid={fieldErrors[key] ? true : undefined}
        aria-describedby={describedBy(`${ids}-${key}`, false, fieldErrors[key])}
        onChange={(event) => set(key, event.target.value)}
      />
    </Field>
  );

  return (
    <form className="aisw-stack" onSubmit={submit} noValidate data-aisw-details="">
      {input("customerName", "Customer name", "text", { maxLength: 200 })}
      <div className="aisw-grid2">
        {input("customerEmail", "Email", "email", { maxLength: 320 })}
        {input("customerPhone", "Phone", "tel", { maxLength: 60 })}
      </div>
      {values.customerEmail.trim().toLowerCase() !== initial.customerEmail.trim().toLowerCase() &&
      (visit.status === "pending" || visit.status === "confirmed") ? (
        <p className="aisw-hint" data-aisw-email-change="">
          {customerEmails && values.customerEmail.trim()
            ? "Saving sends the visit to the new address, with a new link. Links sent to the old address stop working."
            : "Links sent to the old address stop working."}
        </p>
      ) : null}
      {input("address", "Address", "text", { maxLength: 500 })}
      <p className="aisw-hint">A new address is placed on the map again, and drive times are re-checked.</p>
      <Field id={`${ids}-serviceType`} label="Service" error={fieldErrors.serviceType ?? null}>
        {serviceOptions ? (
          <select id={`${ids}-serviceType`} className="aisw-input" value={values.serviceType} onChange={(event) => set("serviceType", event.target.value)}>
            {serviceOptions.some((s) => s.key === values.serviceType) ? null : <option value={values.serviceType}>{visit.serviceName}</option>}
            {serviceOptions.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <input id={`${ids}-serviceType`} className="aisw-input" value={values.serviceType} onChange={(event) => set("serviceType", event.target.value)} />
        )}
      </Field>
      {input("title", "Label on the calendar", "text", { maxLength: 200 })}
      <Field id={`${ids}-notes`} label="Notes" optional error={fieldErrors.notes ?? null}>
        <textarea id={`${ids}-notes`} className="aisw-input" rows={3} maxLength={2000} value={values.notes} onChange={(event) => set("notes", event.target.value)} />
      </Field>
      {error ? <Notice tone="error">{adminErrorText(error)}</Notice> : null}
      <div className="aisw-actions">
        <button type="submit" className="aisw-btn aisw-btn-primary" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Saving…" : "Save details"}
        </button>
        <button type="button" className="aisw-btn aisw-btn-secondary" onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  );
}
