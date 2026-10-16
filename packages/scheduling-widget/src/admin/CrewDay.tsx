import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ClientError } from "../http.js";
import { CheckIcon, ChevronIcon, Loading, Notice, type ChromeProps } from "../parts.js";
import { addDays, formatDurationShort, formatLongDate, formatTimeRange, zoneAbbreviation } from "../time.js";
import type { SchedulingAdminTransport } from "./client.js";
import { adminErrorText, fillIdPattern, STATUS_LABEL, stampTime, statusTagClass } from "./helpers.js";
import type { AdminResource, CrewDayResponse, CrewStop, DateString, ProgressStatus, VisitSnapshot } from "./types.js";
import { AdminRoot, useAdminTransport } from "./ui.js";

/**
 * <CrewDay> — today's route, for the crew, on a phone (contract 8.6).
 *
 * The stops in order, each with its time, who and what, the address as a
 * directions link, a Call button, the notes, and the drive from the stop
 * before ("18 min drive · 9.2 mi from previous stop"; "from home base" for the
 * first). One big button per stop: **Start**, then **Complete**, then a check
 * and the time it was done. "Open route in Maps" hands the whole day to Google
 * Maps. Drive times are marked "estimate" when the business has no maps key
 * and they are straight-line guesses.
 *
 * FROM THE TRUCK (BO-11). A fat-fingered Complete has an **Undo** for a few
 * minutes; a locked gate or nobody home is **Couldn't do it**, with an
 * optional note the office reads; and every one of those has an Undo too. The
 * calls go to the `progress` route, which a crew member's own login is allowed
 * for its own stops — and which never emails the customer.
 *
 * WHOSE ROUTE. With no `resourceId`, the server works out the signed-in
 * person's own crew. Somebody who can see every crew (the owner checking on a
 * van) gets a crew switcher in the header, and the crew they picked is
 * remembered on this device. A login linked to no crew is told to ask the
 * office, rather than shown a picker it isn't allowed to use.
 *
 * It refreshes every two minutes while it is on screen, and whenever the
 * phone comes back to the page, so a stop the office added, moved or
 * cancelled shows up without anybody reloading.
 */

export interface CrewDayProps extends ChromeProps {
  /** The mounted staff handlers, e.g. "/api/admin/schedule". Ignored when `transport` is given. */
  baseUrl?: string;
  transport?: SchedulingAdminTransport;
  /** Default: the crew picked on this device, else the signed-in person's crew as the server resolves it. */
  resourceId?: string;
  /** Default: the server's today. */
  date?: DateString;
  /** Start / Complete / Couldn't do it / Undo. Default true. */
  canManage?: boolean;
  /** Background refresh while visible, in ms. Default 120000; 0 turns it off. */
  pollMs?: number;
  /**
   * Tenancy 2b-1: a pattern with {id}, the visit's photos-and-files page. Each
   * stop then shows "Photos" (a 44 px link), so a crew member at the job adds
   * the before-and-after photos from their phone. Absent: no link.
   */
  filesHref?: string;
}

/** How long after Complete (or Couldn't do it) the Undo stays. */
const UNDO_MS = 15 * 60_000;
const REMEMBER_PREFIX = "aisw-crew-day-resource";

/**
 * The device's remembered crew, PER SCHEDULE (review T2A-BO-03): keyed by the
 * API the page talks to, which names the company (`/api/app/{id}/schedule`).
 * One global key let an owner of two companies — or an office tablet two
 * companies share — carry Green Acres' crew into Summit's route, where it is
 * "not found" forever.
 */
function rememberKey(scope: string): string {
  return `${REMEMBER_PREFIX}:${scope}`;
}

function readRemembered(scope: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(rememberKey(scope)) : null;
  } catch {
    return null;
  }
}

function remember(scope: string, resourceId: string | null): void {
  try {
    if (resourceId) localStorage.setItem(rememberKey(scope), resourceId);
    else localStorage.removeItem(rememberKey(scope));
  } catch {
    /* private mode: the pick lasts for this page only */
  }
}

function driveText(stop: CrewStop): string | null {
  const drive = stop.driveFromPrevious;
  if (!drive) return null;
  const minutes = Math.round(drive.minutes);
  const time = drive.estimated ? `about ${formatDurationShort(minutes)} drive (estimate)` : `${formatDurationShort(minutes)} drive`;
  const miles = `${Math.round(drive.miles * 10) / 10} mi`;
  return `${time} · ${miles} from ${drive.from === "home_base" ? "home base" : "previous stop"}`;
}

/** Recent enough to undo: within UNDO_MS of when it happened. */
function undoable(instant: string | null, nowMs: number): boolean {
  if (!instant) return false;
  const at = Date.parse(instant);
  return Number.isFinite(at) && nowMs - at < UNDO_MS;
}

export function CrewDay(props: CrewDayProps) {
  const locale = props.locale ?? "en-US";
  const canManage = props.canManage !== false;
  const pollMs = props.pollMs ?? 120_000;
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const scope = props.baseUrl ?? "default";
  const ids = useId();
  const [date, setDate] = useState<DateString | null>(props.date ?? null);
  const [resource, setResource] = useState<string | null>(props.resourceId ?? null);
  const fromMemory = useRef(false);
  const [data, setData] = useState<CrewDayResponse | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsPick, setNeedsPick] = useState(false);
  const [unlinked, setUnlinked] = useState(false);
  const [crews, setCrews] = useState<AdminResource[] | null>(null);
  const [pickChoice, setPickChoice] = useState("");
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});
  const [noting, setNoting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [announce, setAnnounce] = useState("");
  const seq = useRef(0);

  // The crew picked on this device last time, when the page wasn't told one.
  useEffect(() => {
    if (props.resourceId) return;
    const remembered = readRemembered(scope);
    if (remembered) {
      fromMemory.current = true;
      setResource(remembered);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The crews, for the switcher: only somebody allowed to see every crew gets them.
  useEffect(() => {
    let alive = true;
    void transport.listResources().then((res) => {
      if (!alive) return;
      if (res.ok) {
        const active = res.data.resources.filter((r) => r.isActive);
        setCrews(active);
        setPickChoice((current) => current || active[0]?.id || "");
      } else setCrews(null);
    });
    return () => {
      alive = false;
    };
  }, [transport]);

  const load = useCallback(
    async (background = false) => {
      const id = ++seq.current;
      if (!background) setLoading(true);
      const res = await transport.crewDay({ ...(date ? { date } : {}), ...(resource ? { resource } : {}) });
      if (id !== seq.current) return;
      setLoading(false);
      if (res.ok) {
        setData(res.data);
        setError(null);
        setNeedsPick(false);
        setUnlinked(false);
        // `date` stays unset until someone navigates: the server's today is
        // shown from `data.date`, without a second request to ask for it again.
        return;
      }
      // A crew remembered on this device that this login may not open, or
      // that isn't there (deleted, or another company's): forget it and show
      // this login's own route instead of a dead end.
      if ((res.error.code === "forbidden" || res.error.code === "not_found") && resource && fromMemory.current) {
        fromMemory.current = false;
        remember(scope, null);
        setResource(null);
        return;
      }
      // The server couldn't tell whose route this is: ask — or, for a login
      // that may not see the crews, say who can fix it.
      if (res.error.code === "invalid" && !resource) {
        const list = await transport.listResources();
        if (id !== seq.current) return;
        if (list.ok) {
          const active = list.data.resources.filter((r) => r.isActive);
          setCrews(active);
          setPickChoice((current) => current || active[0]?.id || "");
          setNeedsPick(true);
          setError(null);
        } else if (list.error.code === "forbidden" && list.error.status !== 401) {
          setUnlinked(true);
          setError(null);
        } else setError(list.error);
        return;
      }
      if (!background || !data) setError(res.error);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transport, date, resource],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // A crew coming back to the phone between stops sees the day as it is now —
  // and, while the page is on screen, every couple of minutes.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void loadRef.current(true);
    };
    window.addEventListener("focus", refresh);
    const timer = pollMs > 0 ? setInterval(refresh, pollMs) : null;
    return () => {
      window.removeEventListener("focus", refresh);
      if (timer) clearInterval(timer);
    };
  }, [pollMs]);

  const pickCrew = (id: string) => {
    fromMemory.current = false;
    remember(scope, id);
    setResource(id);
  };

  const move = async (stop: CrewStop, to: ProgressStatus, withNote?: string) => {
    const visit = stop.visit;
    setSaving((current) => ({ ...current, [visit.id]: true }));
    setStopErrors((current) => ({ ...current, [visit.id]: "" }));
    // Shown at once; put back with a message if the server says no.
    const before = data;
    const now = new Date().toISOString();
    setData((current) =>
      current
        ? {
            ...current,
            stops: current.stops.map((s) =>
              s.visit.id === visit.id
                ? {
                    ...s,
                    visit: {
                      ...s.visit,
                      status: to,
                      updatedAt: now,
                      ...(to === "in_progress" ? { startedAt: s.visit.startedAt ?? now, completedAt: null } : {}),
                      ...(to === "completed" ? { completedAt: now } : {}),
                    },
                  }
                : s,
            ),
          }
        : current,
    );
    const trimmed = withNote?.trim() ?? "";
    const res = await transport.progress(visit.id, { status: to, ...(trimmed ? { note: trimmed.slice(0, 500) } : {}) });
    setSaving((current) => ({ ...current, [visit.id]: false }));
    if (!res.ok) {
      setData(before);
      setStopErrors((current) => ({ ...current, [visit.id]: `Not saved. ${adminErrorText(res.error)}` }));
      return;
    }
    const next: VisitSnapshot = res.data.visit;
    setData((current) =>
      current ? { ...current, stops: current.stops.map((s) => (s.visit.id === next.id ? { ...s, visit: next } : s)) } : current,
    );
    setNoting(null);
    setNote("");
    const words: Record<ProgressStatus, string> = {
      in_progress: visit.status === "completed" ? "reopened" : "started",
      completed: "done",
      no_show: "couldn't be done",
      confirmed: "back on the route",
    };
    setAnnounce(`${next.customerName ?? "Stop"}: ${words[to]}.`);
  };

  const shownDate = data?.date ?? date;
  const zone = data?.timeZone ?? "UTC";
  const totals = data?.totals;
  const nowMs = Date.now();

  let body;
  if (unlinked) {
    body = (
      <Notice tone="info">
        <span data-aisw-crew-unlinked="">
          Your sign-in isn&apos;t linked to a crew yet. Ask the office to pick you for your crew in Schedule settings → Crews,
          then open this page again.
        </span>
      </Notice>
    );
  } else if (needsPick) {
    body = (
      <form
        className="aisw-card"
        data-aisw-crew-pick=""
        onSubmit={(event) => {
          event.preventDefault();
          if (pickChoice) pickCrew(pickChoice);
        }}
      >
        <div className="aisw-card-body">
          <label className="aisw-label" htmlFor={`${ids}-crew`}>
            Pick a crew
          </label>
          {crews === null && !error ? <Loading label="Loading crews…" /> : null}
          {crews && crews.length === 0 ? <p className="aisw-hint">No crews yet. Add one under Schedule settings.</p> : null}
          {crews && crews.length > 0 ? (
            <>
              <select id={`${ids}-crew`} className="aisw-input" value={pickChoice} onChange={(event) => setPickChoice(event.target.value)}>
                {crews.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="aisw-btn aisw-btn-primary">
                Show the route
              </button>
            </>
          ) : null}
        </div>
      </form>
    );
  } else if (!data && loading) {
    body = <Loading label="Loading the route…" />;
  } else if (data) {
    const abbreviation = zoneAbbreviation(zone, data.stops[0]?.visit.startsAt ?? null, locale);
    const switchable = crews && crews.length > 1;
    body = (
      <>
        <header className="aisw-route-head">
          {switchable ? (
            <div className="aisw-row" data-aisw-crew-switch="">
              <label className="aisw-sr" htmlFor={`${ids}-switch`}>
                Crew
              </label>
              <select
                id={`${ids}-switch`}
                className="aisw-input aisw-grow"
                value={data.resource.id}
                onChange={(event) => pickCrew(event.target.value)}
              >
                {crews!.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <h2 className="aisw-admin-title">{data.resource.name}</h2>
          )}
          {data.todayOnly ? (
            // A crew member opens today's route only (the server refuses any
            // other day), so there is no day to page to.
            <div className="aisw-route-nav" data-aisw-today-only="">
              <p className="aisw-route-date">
                {formatLongDate(data.date, locale)}
                {data.date === data.today ? " (today)" : ""}
              </p>
            </div>
          ) : (
            <div className="aisw-route-nav">
              <button
                type="button"
                className="aisw-btn aisw-btn-secondary aisw-icon-btn"
                aria-label="Previous day"
                onClick={() => shownDate && setDate(addDays(shownDate, -1))}
              >
                <ChevronIcon direction="left" />
              </button>
              <p className="aisw-route-date" aria-live="polite">
                {formatLongDate(data.date, locale)}
                {data.date === data.today ? " (today)" : ""}
              </p>
              <button
                type="button"
                className="aisw-btn aisw-btn-secondary aisw-icon-btn"
                aria-label="Next day"
                onClick={() => shownDate && setDate(addDays(shownDate, 1))}
              >
                <ChevronIcon direction="right" />
              </button>
            </div>
          )}
          {totals ? (
            <p className="aisw-route-totals" data-aisw-totals="">
              {totals.visits} stop{totals.visits === 1 ? "" : "s"} · {formatDurationShort(totals.driveMinutes)} driving
              {totals.estimated ? " (estimates)" : ""}
              {abbreviation ? ` · times in ${abbreviation}` : ""}
            </p>
          ) : null}
          {data.windows.length > 0 ? (
            <p className="aisw-hint">Working {data.windows.map((w) => formatTimeRange(w.start, w.end, locale)).join(" and ")}</p>
          ) : (
            <p className="aisw-hint">Not a working day for this crew.</p>
          )}
          {data.routeUrl ? (
            <a className="aisw-btn aisw-btn-primary aisw-btn-block" href={data.routeUrl} target="_blank" rel="noopener noreferrer">
              Open route in Maps<span className="aisw-sr"> (opens in a new tab)</span>
            </a>
          ) : null}
        </header>
        {error ? <Notice tone="error">{adminErrorText(error)}</Notice> : null}
        {data.stops.length === 0 ? (
          <p className="aisw-cal-empty" data-aisw-empty="">
            No stops on this day.
          </p>
        ) : (
          <ol className="aisw-stops" aria-label="Stops, in order">
            {data.stops.map((stop) => {
              const visit = stop.visit;
              const drive = driveText(stop);
              const doneAt = visit.status === "completed" ? stampTime(visit.completedAt, zone, locale) : null;
              const busy = saving[visit.id] === true;
              const who = visit.customerName ?? "";
              const label = (verb: string) => `${verb} stop ${stop.order}${who ? `, ${who}` : ""}`;
              return (
                <li key={visit.id} className="aisw-stop" data-status={visit.status} data-stop-id={visit.id}>
                  <span className="aisw-stop-n" aria-hidden="true">
                    {stop.order}
                  </span>
                  <div className="aisw-stop-main">
                    <span className="aisw-sr">Stop {stop.order}. </span>
                    <span className="aisw-stop-when">{formatTimeRange(visit.startTime, visit.endTime, locale)}</span>
                    <span className="aisw-stop-who">{visit.customerName ?? visit.title ?? "No name"}</span>
                    <span>{visit.serviceName}</span>
                    {visit.address ? (
                      stop.directionsUrl ? (
                        <a className="aisw-stop-address" href={stop.directionsUrl} target="_blank" rel="noopener noreferrer">
                          {visit.address}
                          <span className="aisw-sr"> (directions, opens in a new tab)</span>
                        </a>
                      ) : (
                        <span className="aisw-stop-address">{visit.address}</span>
                      )
                    ) : (
                      <span className="aisw-hint">No address on file</span>
                    )}
                    {visit.notes ? <span className="aisw-stop-notes">{visit.notes}</span> : null}
                    {drive ? <span className="aisw-stop-drive">{drive}</span> : null}
                    <span className={statusTagClass(visit.status)} data-aisw-status={visit.status}>
                      {visit.status === "no_show" ? "Couldn't do it" : STATUS_LABEL[visit.status]}
                    </span>
                    {visit.status === "no_show" && visit.cancelReason ? <span className="aisw-hint">“{visit.cancelReason}”</span> : null}
                  </div>
                  <div className="aisw-stop-actions">
                    {canManage && visit.status === "confirmed" ? (
                      <button
                        type="button"
                        className="aisw-btn aisw-btn-primary"
                        disabled={busy}
                        aria-busy={busy || undefined}
                        aria-label={label("Start")}
                        onClick={() => void move(stop, "in_progress")}
                      >
                        Start
                      </button>
                    ) : null}
                    {canManage && visit.status === "in_progress" ? (
                      <button
                        type="button"
                        className="aisw-btn aisw-btn-primary"
                        disabled={busy}
                        aria-busy={busy || undefined}
                        aria-label={label("Complete")}
                        onClick={() => void move(stop, "completed")}
                      >
                        Complete
                      </button>
                    ) : null}
                    {visit.status === "completed" ? (
                      <span className="aisw-done-stamp" data-aisw-done="">
                        <CheckIcon />
                        {doneAt ? `Done ${doneAt}` : "Done"}
                      </span>
                    ) : null}
                    {stop.telUrl ? (
                      <a className="aisw-btn aisw-btn-secondary" href={stop.telUrl}>
                        Call<span className="aisw-sr"> {visit.customerName ?? "the customer"}</span>
                      </a>
                    ) : null}
                    {props.filesHref ? (
                      <a className="aisw-btn aisw-btn-secondary" href={fillIdPattern(props.filesHref, visit.id)} data-aisw-stop-files="">
                        Photos<span className="aisw-sr"> for {visit.customerName ?? "this stop"}</span>
                      </a>
                    ) : null}
                    {canManage && (visit.status === "confirmed" || visit.status === "in_progress") && noting !== visit.id ? (
                      <button
                        type="button"
                        className="aisw-btn aisw-btn-secondary"
                        disabled={busy}
                        aria-label={label("Couldn't do")}
                        onClick={() => {
                          setNote("");
                          setNoting(visit.id);
                        }}
                      >
                        Couldn&apos;t do it
                      </button>
                    ) : null}
                    {canManage && visit.status === "in_progress" ? (
                      <button type="button" className="aisw-btn aisw-btn-link" disabled={busy} aria-label={label("Undo starting")} onClick={() => void move(stop, "confirmed")}>
                        Undo start
                      </button>
                    ) : null}
                    {canManage && visit.status === "completed" && undoable(visit.completedAt, nowMs) ? (
                      <button type="button" className="aisw-btn aisw-btn-link" disabled={busy} aria-label={label("Undo completing")} onClick={() => void move(stop, "in_progress")}>
                        Undo
                      </button>
                    ) : null}
                    {canManage && visit.status === "no_show" && undoable(visit.updatedAt, nowMs) ? (
                      <button type="button" className="aisw-btn aisw-btn-link" disabled={busy} aria-label={label("Undo couldn't do")} onClick={() => void move(stop, "confirmed")}>
                        Undo
                      </button>
                    ) : null}
                  </div>
                  {noting === visit.id ? (
                    <form
                      className="aisw-stack-sm"
                      style={{ gridColumn: "1 / -1" }}
                      data-aisw-couldnt=""
                      onSubmit={(event) => {
                        event.preventDefault();
                        void move(stop, "no_show", note);
                      }}
                    >
                      <label className="aisw-label" htmlFor={`${ids}-${visit.id}-note`}>
                        What happened? <span className="aisw-optional">(optional, for the office)</span>
                      </label>
                      <textarea
                        id={`${ids}-${visit.id}-note`}
                        className="aisw-input"
                        rows={2}
                        maxLength={500}
                        placeholder="Gate locked, nobody home…"
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                      />
                      <div className="aisw-actions">
                        <button type="submit" className="aisw-btn aisw-btn-danger" disabled={busy} aria-busy={busy || undefined}>
                          {busy ? "Saving…" : "Couldn't do it"}
                        </button>
                        <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => setNoting(null)}>
                          Back
                        </button>
                      </div>
                    </form>
                  ) : null}
                  {stopErrors[visit.id] ? (
                    <p className="aisw-danger-text" role="alert" style={{ gridColumn: "1 / -1" }}>
                      {stopErrors[visit.id]}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </>
    );
  } else if (error && error.code === "not_found" && error.status !== 401) {
    // The crew asked for isn't there (deleted, or not this company's): no
    // calendar was refreshed, and trying the same crew again can't help. Go
    // back to this login's own route.
    body = (
      <Notice tone="error">
        That crew isn't there any more.{" "}
        <button
          type="button"
          className="aisw-btn aisw-btn-link"
          onClick={() => {
            fromMemory.current = false;
            remember(scope, null);
            setResource(null);
            setError(null);
          }}
        >
          Show my route
        </button>
      </Notice>
    );
  } else if (error) {
    body = (
      <Notice tone="error">
        {adminErrorText(error)}{" "}
        <button type="button" className="aisw-btn aisw-btn-link" onClick={() => void load(false)}>
          Try again
        </button>
      </Notice>
    );
  }

  return (
    <AdminRoot theme={props.theme} nonce={props.nonce} className={props.className} style={props.style} data={{ "aisw-crew-day": data?.date ?? "loading" }}>
      <div className="aisw-admin-inner">
        {body}
        <span className="aisw-sr" role="status" aria-live="polite">
          {announce}
        </span>
      </div>
    </AdminRoot>
  );
}
