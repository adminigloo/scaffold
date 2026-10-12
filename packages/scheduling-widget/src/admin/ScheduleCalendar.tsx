import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ClientError } from "../http.js";
import { useNow } from "../hooks.js";
import { CheckIcon, ChevronIcon, ClockIcon, CrossIcon, Loading, Notice, PlayIcon, type ChromeProps } from "../parts.js";
import {
  addDays,
  clockIn,
  describeShortWhen,
  formatClock,
  formatDateRange,
  formatLongDate,
  formatShortDate,
  formatTimeRange,
  minutesOf,
  todayIn,
  zoneLabel,
} from "../time.js";
import type { SchedulingAdminTransport } from "./client.js";
import { adminErrorText, crewColor, expiresIn, isMovable, STATUS_LABEL } from "./helpers.js";
import { dayRange, dragStart, hourMarks, layoutLanes, positionVisit, PX_PER_MINUTE, shiftEnd, weekDates } from "./layout.js";
import { NewVisitDialog } from "./NewVisitDialog.js";
import type { CalendarResource, CalendarResponse, DateString, ServiceWire, VisitSnapshot } from "./types.js";
import { AdminNotices, AdminRoot, Check, Dialog, ToastRegion, useAdminStatus, useAdminTransport, useToasts } from "./ui.js";
import { VisitPanel, type PanelChange } from "./VisitPanel.js";

/**
 * <ScheduleCalendar> — the staff calendar (contract 8.5).
 *
 *   Day   one column per crew (plus "Unassigned"), time down the side on the
 *         business's grid, off-hours shaded, visits drawn at their wall-clock
 *         time in the business's zone.
 *   Week  a dispatch board: crews down the side, seven days across.
 *
 * Drag a request or a confirmed visit to move it (up or down for the time,
 * sideways for the crew; in the week, to another day or crew). The move shows
 * at once and goes back, with the server's reason in plain words, if the
 * server refuses ("Overlaps 10:00–12:00"). Before the call, staff are asked
 * whether to email the customer, unless they ticked "Don't ask again". Every
 * drag has a keyboard path: open the visit and use **Move…**.
 *
 * The Requests button holds the inbox: every request not yet answered, soonest
 * first, with where it is, the customer's note and how long it has before it's
 * released, and Accept / Decline right there. Nothing here needs a cron to be
 * correct: the server releases overdue requests itself whenever the calendar
 * loads.
 *
 * HONEST ABOUT EMAIL. Above the calendar, the server's status in plain words:
 * customer emails off, reminders once a day, setup left to do, recent sends
 * that failed. When no customer email can leave, nothing here offers to send
 * one — no "Email the customer?" after a drag, no "Email customers about my
 * answers" box — and the screens say the customer won't be told instead.
 */

export interface ScheduleCalendarProps extends ChromeProps {
  /** The mounted staff handlers, e.g. "/api/admin/schedule". Ignored when `transport` is given. */
  baseUrl?: string;
  transport?: SchedulingAdminTransport;
  /** Default: "day" when the calendar is under 720px wide, else "week". */
  initialView?: "day" | "week";
  /** Default: the server's today (in the business's zone). */
  initialDate?: DateString;
  /** Default true; false = read-only (no accept, decline, move or new visit). */
  canManage?: boolean;
  /** Background refresh, default 60000 ms; 0 = off. The calendar also refreshes when the window regains focus. */
  pollMs?: number;
  /** Shown in the empty state. */
  bookingPageUrl?: string;
  onVisitChange?: (visit: VisitSnapshot) => void;
}

type View = "day" | "week";

interface Target {
  date: DateString;
  startTime: string;
  endTime: string;
  resourceId: string | null;
}

interface ProposedMove {
  visit: VisitSnapshot;
  target: Target;
  kind: "reschedule" | "assign";
}

interface DragState {
  visit: VisitSnapshot;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  view: View;
  targets: Array<{ resourceId: string | null; date: string; rect: { left: number; right: number; top: number; bottom: number } }>;
  current: Target | null;
}

const NOTIFY_KEY = "aisw-notify-choice";

function readSessionChoice(): boolean | null {
  try {
    const value = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(NOTIFY_KEY) : null;
    return value === "yes" ? true : value === "no" ? false : null;
  } catch {
    return null;
  }
}

function writeSessionChoice(choice: boolean): void {
  try {
    sessionStorage.setItem(NOTIFY_KEY, choice ? "yes" : "no");
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

function browserToday(): DateString {
  try {
    return todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function ScheduleCalendar(props: ScheduleCalendarProps) {
  const locale = props.locale ?? "en-US";
  const canManage = props.canManage !== false;
  const pollMs = props.pollMs ?? 60_000;
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const ids = useId();
  const innerRef = useRef<HTMLDivElement | null>(null);
  const calRef = useRef<HTMLDivElement | null>(null);

  const [view, setView] = useState<View | null>(props.initialView ?? null);
  const [date, setDate] = useState<DateString>(props.initialDate ?? browserToday());
  const userNavigated = useRef(Boolean(props.initialDate));
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [loadError, setLoadError] = useState<ClientError | null>(null);
  const [loading, setLoading] = useState(false);
  const [crewFilter, setCrewFilter] = useState<ReadonlySet<string> | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Target>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [prompt, setPrompt] = useState<ProposedMove | null>(null);
  const [services, setServices] = useState<ServiceWire[] | null>(null);
  const [preview, setPreview] = useState<{ id: string; target: Target } | null>(null);
  const toasts = useToasts();
  const status = useAdminStatus(transport);
  // Unknown (an older server) behaves as before: the email choices are offered.
  const emailsOff = status?.customerEmails === false;
  const nowMs = useNow(true, 60_000);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef<string | null>(null);
  const loadSeq = useRef(0);
  const lastMutation = useRef(0);
  const lastPanelVisit = useRef<VisitSnapshot | null>(null);
  const onVisitChange = props.onVisitChange;

  // The first view is chosen by the room there is (contract 8.5).
  useLayoutEffect(() => {
    if (view !== null) return;
    const width = innerRef.current?.clientWidth ?? 0;
    setView(width >= 720 ? "week" : "day");
  }, [view]);

  const range = useMemo(() => {
    if (view === "week") {
      const dates = weekDates(date);
      return { from: dates[0]!, to: dates[6]!, dates };
    }
    return { from: date, to: date, dates: [date] };
  }, [view, date]);

  const load = useCallback(
    async (background = false) => {
      if (view === null) return;
      const seq = ++loadSeq.current;
      const startedAt = Date.now();
      if (!background) setLoading(true);
      const res = await transport.calendar({ from: range.from, to: range.to });
      if (seq !== loadSeq.current) return;
      setLoading(false);
      if (!res.ok) {
        // A background refresh that fails keeps what's on screen.
        if (!background || !data) setLoadError(res.error);
        return;
      }
      // An answer that left before a change landed may not include it: ask again.
      if (startedAt < lastMutation.current) {
        void load(true);
        return;
      }
      setLoadError(null);
      setData(res.data);
      // The first answer says what "today" is in the business's zone; open on
      // it once. After that the date is whatever staff navigated to.
      if (!userNavigated.current) {
        userNavigated.current = true;
        if (res.data.today !== date) setDate(res.data.today);
      }
    },
    // `data` only decides whether a background failure shows; reading it stale is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transport, view, range.from, range.to, date],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Services, for the panel's and the new-visit form's service lists.
  useEffect(() => {
    let alive = true;
    void transport.getSettings().then((res) => {
      if (alive && res.ok) setServices(res.data.settings.services);
    });
    return () => {
      alive = false;
    };
  }, [transport]);

  // Background refresh: on a timer, and when the window comes back into focus.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = () => {
      if (dragRef.current || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      void loadRef.current(true);
    };
    window.addEventListener("focus", refresh);
    const timer = pollMs > 0 ? setInterval(refresh, pollMs) : null;
    return () => {
      window.removeEventListener("focus", refresh);
      if (timer) clearInterval(timer);
    };
  }, [pollMs]);

  const zone = data?.timeZone ?? "UTC";
  const step = data?.slotStepMinutes ?? 30;

  /** A visit as it should be drawn: its optimistic move or drag preview on top. */
  const shown = useCallback(
    (visit: VisitSnapshot): VisitSnapshot => {
      const target = preview?.id === visit.id ? preview.target : overrides[visit.id];
      return target ? { ...visit, ...target, resourceName: visit.resourceName } : visit;
    },
    [preview, overrides],
  );

  const allVisits = useMemo(() => (data?.visits ?? []).map(shown), [data, shown]);
  const resources = data?.resources ?? [];
  const shownResources = crewFilter ? resources.filter((r) => crewFilter.has(r.id)) : resources;
  const hasUnassigned = allVisits.some((v) => v.resourceId === null);
  const columns: Array<{ id: string | null; name: string; resource: CalendarResource | null }> = [
    ...shownResources.map((r) => ({ id: r.id, name: r.name, resource: r })),
    ...(hasUnassigned && !crewFilter ? [{ id: null, name: "Unassigned", resource: null }] : []),
  ];
  const windowsFor = useCallback(
    (resourceId: string, day: DateString) => data?.windows.find((w) => w.resourceId === resourceId && w.date === day)?.windows ?? [],
    [data],
  );
  const visible = allVisits.filter((v) => columns.some((c) => c.id === v.resourceId));

  const findVisit = (id: string): VisitSnapshot | null =>
    data?.visits.find((v) => v.id === id) ?? data?.pending.find((v) => v.id === id) ?? null;

  /** Put the server's copy of a visit in place, and refresh the rest in the background. */
  const applyVisit = useCallback(
    (visit: VisitSnapshot) => {
      lastMutation.current = Date.now();
      setData((current) => {
        if (!current) return current;
        const replace = (list: VisitSnapshot[]) => list.map((v) => (v.id === visit.id ? visit : v));
        const inList = current.visits.some((v) => v.id === visit.id);
        return {
          ...current,
          visits: inList ? replace(current.visits) : current.visits,
          pending: visit.status === "pending" ? replace(current.pending) : current.pending.filter((v) => v.id !== visit.id),
        };
      });
      onVisitChange?.(visit);
      void loadRef.current(true);
    },
    [onVisitChange],
  );

  // ---------------------------------------------------------------------------
  // Moving a visit
  // ---------------------------------------------------------------------------

  const commit = async (move: ProposedMove, notify: boolean) => {
    const { visit, target, kind } = move;
    setOverrides((current) => ({ ...current, [visit.id]: target }));
    const crewChanged = target.resourceId !== visit.resourceId;
    // No email on file: nobody can be told, so `notify` isn't sent at all.
    const notifyField = visit.customerEmail ? { notify } : {};
    // CONTRACT: a drag sends no `endTime`; the server's "start + the visit's
    // own length" keeps the duration exactly (8.5 says a drag keeps the
    // length), and can't disagree with the preview the way a client-computed
    // end near midnight could.
    const res =
      kind === "reschedule"
        ? await transport.reschedule(visit.id, {
            date: target.date,
            startTime: target.startTime,
            ...(crewChanged && target.resourceId ? { resourceId: target.resourceId } : {}),
            ...notifyField,
          })
        : await transport.assign(visit.id, { resourceId: target.resourceId!, ...notifyField });
    setOverrides((current) => {
      const next = { ...current };
      delete next[visit.id];
      return next;
    });
    if (!res.ok) {
      toasts.push("error", `${visit.customerName ?? "The visit"} wasn't moved. ${adminErrorText(res.error)}`);
      if (res.error.code === "not_found") void loadRef.current(true);
      return;
    }
    applyVisit(res.data.visit);
    const next = res.data.visit;
    toasts.push(
      "ok",
      kind === "reschedule"
        ? `${next.customerName ?? "Visit"} moved to ${describeShortWhen(next, locale)}${crewChanged && next.resourceName ? ` with ${next.resourceName}` : ""}.`
        : `${next.customerName ?? "Visit"} is now with ${next.resourceName ?? "the new crew"}.`,
    );
    for (const warning of res.data.warnings) toasts.push("warn", warning);
  };

  const propose = (visit: VisitSnapshot, target: Target) => {
    const timeChanged = target.date !== visit.date || target.startTime !== visit.startTime;
    const crewChanged = target.resourceId !== visit.resourceId;
    if (!timeChanged && !crewChanged) return;
    // CONTRACT: AssignBody needs a crew, so a drop on "Unassigned" can't be
    // sent; it's refused here in words rather than as a server `invalid`.
    if (crewChanged && target.resourceId === null) {
      toasts.push("error", "A visit can't be moved to Unassigned. Drop it on a crew.");
      return;
    }
    const move: ProposedMove = { visit, target, kind: timeChanged ? "reschedule" : "assign" };
    if (!visit.customerEmail || emailsOff) {
      // Nobody can be emailed: don't ask a question whose "yes" sends nothing.
      void commit(move, false);
      if (visit.customerEmail && emailsOff) {
        toasts.push("warn", `Customer emails are off, so ${visit.customerName ?? "the customer"} won't be told about this change.`);
      }
      return;
    }
    const remembered = readSessionChoice();
    if (remembered !== null) {
      void commit(move, remembered);
      return;
    }
    // Show where it's going while staff decide.
    setOverrides((current) => ({ ...current, [visit.id]: target }));
    setPrompt(move);
  };

  const resolvePrompt = (choice: boolean | null, remember: boolean) => {
    const move = prompt;
    setPrompt(null);
    if (!move) return;
    if (choice === null) {
      setOverrides((current) => {
        const next = { ...current };
        delete next[move.visit.id];
        return next;
      });
      return;
    }
    if (remember) writeSessionChoice(choice);
    void commit(move, choice);
  };

  // ---------------------------------------------------------------------------
  // Drag (pointer events: mouse, touch and pen)
  // ---------------------------------------------------------------------------

  const targetAt = (drag: DragState, x: number, y: number) =>
    drag.targets.find((t) =>
      drag.view === "day" ? x >= t.rect.left && x < t.rect.right && t.rect.right > t.rect.left : x >= t.rect.left && x < t.rect.right && y >= t.rect.top && y < t.rect.bottom,
    ) ?? null;

  const stepRef = useRef(step);
  stepRef.current = step;
  const proposeRef = useRef(propose);
  proposeRef.current = propose;

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    event.preventDefault();
    const visit = drag.visit;
    const over = targetAt(drag, event.clientX, event.clientY);
    let target: Target;
    if (drag.view === "day") {
      const startTime = dragStart(visit, dy, stepRef.current);
      target = {
        date: visit.date,
        startTime,
        endTime: shiftEnd(visit, startTime),
        resourceId: over ? over.resourceId : visit.resourceId,
      };
    } else {
      target = {
        date: over ? over.date : visit.date,
        startTime: visit.startTime,
        endTime: visit.endTime,
        resourceId: over ? over.resourceId : visit.resourceId,
      };
    }
    drag.current = target;
    setPreview({ id: visit.id, target });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const endDrag = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      setPreview(null);
      if (!drag.moved) return;
      // The click that follows this pointerup must not open the panel.
      suppressClick.current = drag.visit.id;
      setTimeout(() => {
        if (suppressClick.current === drag.visit.id) suppressClick.current = null;
      }, 400);
      if (event.type === "pointercancel" || !drag.current) return;
      proposeRef.current(drag.visit, drag.current);
    },
    [onPointerMove],
  );

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    },
    [onPointerMove, endDrag],
  );

  const startDrag = (event: ReactPointerEvent<HTMLElement>, visit: VisitSnapshot) => {
    if (!canManage || !isMovable(visit) || dragRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const container = calRef.current;
    const targets = container
      ? [...container.querySelectorAll<HTMLElement>("[data-drop]")].map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            resourceId: el.dataset.resource ? el.dataset.resource : null,
            date: el.dataset.date ?? visit.date,
            rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          };
        })
      : [];
    dragRef.current = {
      visit,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      view: view ?? "day",
      targets,
      current: null,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* some engines refuse capture for synthetic pointers; window listeners still see the moves */
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  };

  const openVisit = (visit: VisitSnapshot) => {
    if (suppressClick.current === visit.id) {
      suppressClick.current = null;
      return;
    }
    setOpenId(visit.id);
  };

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  const navigate = (next: DateString) => {
    userNavigated.current = true;
    setDate(next);
  };
  const stepDays = view === "week" ? 7 : 1;
  const today = data?.today ?? browserToday();
  const label =
    view === "week" ? formatDateRange(range.from, range.to, locale) : `${formatLongDate(date, locale)}${date === today ? " (today)" : ""}`;
  // A visit moved out of the days on screen (to next week, say) leaves the
  // calendar's data on the next refresh; its panel keeps the last copy it had
  // rather than vanishing under the person using it.
  const found = openId ? (allVisits.find((v) => v.id === openId) ?? findVisit(openId)) : null;
  if (found) lastPanelVisit.current = found;
  const openVisitRow = openId ? (found ?? (lastPanelVisit.current?.id === openId ? lastPanelVisit.current : null)) : null;
  const pendingCount = data?.pending.length ?? 0;
  const empty = data !== null && visible.length === 0;
  const dragHintId = `${ids}-drag-hint`;

  const blockLabel = (visit: VisitSnapshot) =>
    `${formatTimeRange(visit.startTime, visit.endTime, locale)}, ${visit.customerName ?? "No name"}, ${visit.serviceName}, ${STATUS_LABEL[visit.status]}${
      visit.resourceName ? `, ${visit.resourceName}` : ", not assigned"
    }`;

  const statusMark = (visit: VisitSnapshot) => (
    <span className="aisw-block-status">
      {visit.status === "completed" ? <CheckIcon /> : visit.status === "in_progress" ? <PlayIcon /> : visit.status === "pending" ? <ClockIcon /> : visit.status === "no_show" ? <CrossIcon /> : null}
      {STATUS_LABEL[visit.status]}
    </span>
  );

  const blockProps = (visit: VisitSnapshot) => {
    const movable = canManage && isMovable(visit);
    return {
      type: "button" as const,
      "data-visit-id": visit.id,
      "data-status": visit.status,
      "data-fixed": movable ? undefined : "",
      "data-dragging": preview?.id === visit.id ? "" : undefined,
      "data-saving": overrides[visit.id] && !prompt ? "" : undefined,
      "aria-label": blockLabel(visit),
      "aria-describedby": movable ? dragHintId : undefined,
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => startDrag(event, visit),
      onClick: () => openVisit(visit),
    };
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  let grid = null;
  if (data && view === "day") {
    const dayVisits = visible.filter((v) => v.date === date);
    const allWindows = columns.flatMap((c) => (c.id ? windowsFor(c.id, date) : []));
    const span = dayRange(allWindows, dayVisits);
    const height = (span.endMinute - span.startMinute) * PX_PER_MINUTE;
    const marks = hourMarks(span);
    // The business's start-time grid between the hour lines (every 30 minutes,
    // say): where a dragged visit will snap.
    const stepMarks: number[] = [];
    if (step < 60) {
      for (let m = span.startMinute + step; m < span.endMinute; m += step) if (m % 60 !== 0) stepMarks.push(m);
    }
    const nowMinute = date === data.today ? minutesOf(clockIn(zone, new Date(nowMs))) : null;
    grid = (
      <div className="aisw-cal" ref={calRef} data-aisw-view="day">
        <div className="aisw-day-grid" style={{ gridTemplateColumns: `64px repeat(${Math.max(1, columns.length)}, minmax(170px, 1fr))` }}>
          <div className="aisw-col-head" aria-hidden="true" />
          {columns.map((column) => (
            <div key={column.id ?? "unassigned"} className="aisw-col-head" data-col-head={column.id ?? ""}>
              <span className="aisw-swatch" style={{ background: crewColor(column.id, resources) }} aria-hidden="true" />
              <span>
                {column.name}
                {column.resource && !column.resource.isActive ? <small> (removed)</small> : null}
              </span>
            </div>
          ))}
          <div className="aisw-times-col" style={{ height }} aria-hidden="true">
            {marks.map((m) => (
              <span key={m} className="aisw-hour" style={{ top: (m - span.startMinute) * PX_PER_MINUTE }}>
                {m === span.startMinute ? "" : formatClock(`${String(Math.floor(m / 60)).padStart(2, "0")}:00`, locale)}
              </span>
            ))}
          </div>
          {columns.map((column) => {
            const windows = column.id ? windowsFor(column.id, date) : [{ start: "00:00", end: "24:00" }];
            const colVisits = dayVisits.filter((v) => v.resourceId === column.id);
            const lanes = layoutLanes(colVisits.map((v) => ({ id: v.id, start: minutesOf(v.startTime), end: minutesOf(v.endTime) })));
            const dropping = preview && preview.target.resourceId === column.id;
            return (
              <div
                key={column.id ?? "unassigned"}
                className="aisw-col"
                style={{ height }}
                data-drop=""
                data-resource={column.id ?? ""}
                data-date={date}
                data-drop-target={dropping ? "" : undefined}
                role="group"
                aria-label={`${column.name}, ${formatLongDate(date, locale)}${column.id && windows.length === 0 ? ", not working" : ""}`}
              >
                {windows.map((w) => {
                  const pos = positionVisit({ startTime: w.start, endTime: w.end }, span, PX_PER_MINUTE, 0);
                  return <div key={`${w.start}-${w.end}`} className="aisw-col-window" style={{ top: pos.top, height: pos.height }} />;
                })}
                {marks.map((m) => (
                  <div key={m} className="aisw-hour-line" style={{ top: (m - span.startMinute) * PX_PER_MINUTE }} />
                ))}
                {stepMarks.map((m) => (
                  <div key={`s${m}`} className="aisw-step-line" style={{ top: (m - span.startMinute) * PX_PER_MINUTE }} />
                ))}
                {nowMinute !== null && nowMinute >= span.startMinute && nowMinute <= span.endMinute ? (
                  <div className="aisw-now-line" style={{ top: (nowMinute - span.startMinute) * PX_PER_MINUTE }} aria-hidden="true" />
                ) : null}
                {colVisits.map((visit) => {
                  const pos = positionVisit(visit, span);
                  const lane = lanes.get(visit.id) ?? { lane: 0, lanes: 1 };
                  const width = 100 / lane.lanes;
                  return (
                    <button
                      key={visit.id}
                      className="aisw-block"
                      style={{
                        top: pos.top,
                        height: pos.height,
                        left: `calc(${lane.lane * width}% + 3px)`,
                        width: `calc(${width}% - 6px)`,
                        ["--aisw-crew" as string]: crewColor(visit.resourceId, resources),
                      }}
                      {...blockProps(visit)}
                    >
                      <span className="aisw-block-time">{formatTimeRange(visit.startTime, visit.endTime, locale)}</span>
                      <span className="aisw-block-who">{visit.customerName ?? visit.title ?? "No name"}</span>
                      <span className="aisw-block-what">{visit.serviceName}</span>
                      {statusMark(visit)}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    );
  } else if (data && view === "week") {
    const rows = columns;
    grid = (
      <div className="aisw-cal" ref={calRef} data-aisw-view="week">
        <div className="aisw-week-grid" style={{ gridTemplateColumns: `140px repeat(7, minmax(120px, 1fr))` }}>
          <div className="aisw-week-head">Crew</div>
          {range.dates.map((day) => (
            <div key={day} className="aisw-week-head" data-today={day === data.today ? "" : undefined}>
              <button
                type="button"
                className="aisw-btn aisw-btn-link"
                style={{ minHeight: 28, padding: 0 }}
                onClick={() => {
                  navigate(day);
                  setView("day");
                }}
                aria-label={`Open ${formatLongDate(day, locale)} as a day`}
              >
                {formatShortDate(day, locale)}
              </button>
            </div>
          ))}
          {rows.map((row) => (
            <Fragment key={row.id ?? "unassigned"}>
              <div className="aisw-week-crew">
                <span className="aisw-swatch" style={{ background: crewColor(row.id, resources), marginTop: 6 }} aria-hidden="true" />
                <span>
                  {row.name}
                  {row.resource && !row.resource.isActive ? <small className="aisw-muted"> (removed)</small> : null}
                </span>
              </div>
              {range.dates.map((day) => {
                const off = row.id !== null && windowsFor(row.id, day).length === 0;
                const cellVisits = visible
                  .filter((v) => v.resourceId === row.id && v.date === day)
                  .sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
                const dropping = preview && preview.target.resourceId === row.id && preview.target.date === day;
                return (
                  <div
                    key={day}
                    className="aisw-cell"
                    data-drop=""
                    data-resource={row.id ?? ""}
                    data-date={day}
                    data-off={off ? "" : undefined}
                    data-drop-target={dropping ? "" : undefined}
                    role="group"
                    aria-label={`${row.name}, ${formatLongDate(day, locale)}${off ? ", not working" : ""}`}
                  >
                    {off ? <span className="aisw-cell-off">Off</span> : null}
                    {cellVisits.map((visit) => (
                      <button
                        key={visit.id}
                        className="aisw-chip"
                        style={{ ["--aisw-crew" as string]: crewColor(visit.resourceId, resources) }}
                        {...blockProps(visit)}
                      >
                        <span className="aisw-block-time">{formatClock(visit.startTime, locale)}</span>
                        <span className="aisw-block-who">{visit.customerName ?? visit.title ?? "No name"}</span>
                        {visit.status !== "confirmed" ? statusMark(visit) : null}
                      </button>
                    ))}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    );
  }

  return (
    <AdminRoot
      theme={props.theme}
      nonce={props.nonce}
      className={props.className}
      style={props.style}
      locale={locale}
      data={{ "aisw-calendar": view ?? "measuring" }}
    >
      <div className="aisw-admin-inner" ref={innerRef}>
        <div className="aisw-toolbar" role="group" aria-label="Calendar controls">
          <h2 className="aisw-toolbar-label" aria-live="polite">
            {label}
          </h2>
          <button type="button" className="aisw-btn aisw-btn-secondary aisw-icon-btn" aria-label={view === "week" ? "Previous week" : "Previous day"} onClick={() => navigate(addDays(date, -stepDays))}>
            <ChevronIcon direction="left" />
          </button>
          <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => navigate(today)}>
            Today
          </button>
          <button type="button" className="aisw-btn aisw-btn-secondary aisw-icon-btn" aria-label={view === "week" ? "Next week" : "Next day"} onClick={() => navigate(addDays(date, stepDays))}>
            <ChevronIcon direction="right" />
          </button>
          <div className="aisw-seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "day"} onClick={() => setView("day")}>
              Day
            </button>
            <button type="button" aria-pressed={view === "week"} onClick={() => setView("week")}>
              Week
            </button>
          </div>
          <button
            type="button"
            className="aisw-btn aisw-btn-secondary"
            onClick={() => setRequestsOpen(true)}
            aria-label={`Requests, ${pendingCount} waiting`}
            data-aisw-requests-button=""
          >
            Requests <span className="aisw-count">{pendingCount}</span>
          </button>
          {canManage ? (
            <button type="button" className="aisw-btn aisw-btn-primary" onClick={() => setNewOpen(true)}>
              New visit
            </button>
          ) : null}
        </div>

        {resources.length > 1 ? (
          <div className="aisw-chips" role="group" aria-label="Show crews">
            <button type="button" className="aisw-chip-filter" aria-pressed={crewFilter === null} onClick={() => setCrewFilter(null)}>
              All
            </button>
            {resources.map((r) => (
              <button
                key={r.id}
                type="button"
                className="aisw-chip-filter"
                aria-pressed={crewFilter?.has(r.id) ?? false}
                onClick={() =>
                  setCrewFilter((current) => {
                    const next = new Set(current ?? []);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    return next.size === 0 ? null : next;
                  })
                }
              >
                <span className="aisw-swatch" style={{ background: crewColor(r.id, resources) }} aria-hidden="true" />
                {r.name}
              </button>
            ))}
          </div>
        ) : null}

        {status ? <AdminNotices notices={status.notices} /> : null}

        {data ? (
          <p className="aisw-hint">
            Times are {zoneLabel(zone, data.visits[0]?.startsAt ?? null, locale)}.
            {canManage ? " Drag a request or a confirmed visit to move it, or open it and choose Move." : ""}
          </p>
        ) : null}
        <span id={dragHintId} className="aisw-sr">
          Opens the visit. To move it, drag it, or open it and choose Move.
        </span>

        {loadError ? (
          <Notice tone="error">
            {adminErrorText(loadError)}{" "}
            <button type="button" className="aisw-btn aisw-btn-link" onClick={() => void load(false)}>
              Try again
            </button>
          </Notice>
        ) : null}
        {!data && !loadError ? <Loading label="Loading the schedule…" /> : null}
        {data && resources.length === 0 ? (
          <Notice tone="info">No crews yet. Add one under Schedule settings, then visits can be booked.</Notice>
        ) : null}
        {empty ? (
          <p className="aisw-cal-empty" data-aisw-empty="">
            {view === "week" ? "No visits this week yet." : "No visits on this day yet."}
            {props.bookingPageUrl ? (
              <>
                {" "}
                Customers book at <a href={props.bookingPageUrl}>{props.bookingPageUrl}</a>.
              </>
            ) : null}
          </p>
        ) : null}
        {grid}
        {loading && data ? (
          <span className="aisw-sr" role="status">
            Updating…
          </span>
        ) : null}
      </div>

      {openVisitRow ? (
        <VisitPanel
          key={openVisitRow.id}
          visit={openVisitRow}
          transport={transport}
          resources={resources}
          services={services}
          slotStepMinutes={step}
          canManage={canManage}
          customerEmails={!emailsOff}
          locale={locale}
          nowMs={nowMs}
          onClose={() => setOpenId(null)}
          onChanged={(change: PanelChange) => {
            applyVisit(change.visit);
            toasts.push("ok", change.message);
            for (const warning of change.warnings ?? []) toasts.push("warn", warning);
          }}
          returnFocus={() => calRef.current?.querySelector<HTMLElement>(`[data-visit-id="${CSS_escape(openVisitRow.id)}"]`) ?? null}
        />
      ) : null}

      {requestsOpen && data ? (
        <RequestsDialog
          pending={data.pending}
          transport={transport}
          canManage={canManage}
          customerEmails={!emailsOff}
          locale={locale}
          nowMs={nowMs}
          onClose={() => setRequestsOpen(false)}
          onOpenVisit={(id) => {
            setRequestsOpen(false);
            setOpenId(id);
          }}
          onChanged={(visit, message) => {
            applyVisit(visit);
            toasts.push("ok", message);
          }}
        />
      ) : null}

      {newOpen ? (
        <NewVisitDialog
          transport={transport}
          resources={resources}
          services={services}
          slotStepMinutes={step}
          defaultDate={date < today ? today : date}
          customerEmails={!emailsOff}
          locale={locale}
          onClose={() => setNewOpen(false)}
          onCreated={(result) => {
            setNewOpen(false);
            lastMutation.current = Date.now();
            onVisitChange?.(result.visit);
            toasts.push("ok", `${result.visit.customerName ?? "Visit"} booked for ${describeShortWhen(result.visit, locale)}.`);
            for (const warning of result.warnings) toasts.push("warn", warning);
            if (result.visit.date !== date && view === "day") navigate(result.visit.date);
            void loadRef.current(true);
          }}
        />
      ) : null}

      {prompt ? <NotifyPrompt move={prompt} locale={locale} onAnswer={resolvePrompt} /> : null}

      <ToastRegion toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </AdminRoot>
  );
}

/** CSS.escape where it exists; ids are uuids, so a plain fallback is enough. */
function CSS_escape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/** "Email the customer about this change?" before a dragged move goes out. */
function NotifyPrompt({
  move,
  locale,
  onAnswer,
}: {
  move: ProposedMove;
  locale: string;
  onAnswer: (choice: boolean | null, remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  const { visit, target, kind } = move;
  const descId = useId();
  return (
    <Dialog title="Email the customer about this change?" onClose={() => onAnswer(null, false)} describedBy={descId} data={{ "aisw-notify-prompt": "" }}>
      <p id={descId}>
        {kind === "reschedule"
          ? `${visit.customerName ?? "The visit"} moves from ${describeShortWhen(visit, locale)} to ${describeShortWhen(target, locale)}.`
          : `${visit.customerName ?? "The visit"} goes to another crew. The time stays the same.`}{" "}
        We can email {visit.customerEmail} with the new details.
      </p>
      <Check checked={remember} onChange={setRemember} label="Don't ask again this session" />
      <div className="aisw-actions">
        <button type="button" className="aisw-btn aisw-btn-primary" data-autofocus="" onClick={() => onAnswer(true, remember)}>
          Yes, email them
        </button>
        <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => onAnswer(false, remember)}>
          No, just move it
        </button>
      </div>
      <button type="button" className="aisw-btn aisw-btn-link" onClick={() => onAnswer(null, false)}>
        Don't move it
      </button>
    </Dialog>
  );
}

/** The request inbox: everything waiting for an answer, soonest first. */
function RequestsDialog({
  pending,
  transport,
  canManage,
  customerEmails,
  locale,
  nowMs,
  onClose,
  onOpenVisit,
  onChanged,
}: {
  pending: readonly VisitSnapshot[];
  transport: SchedulingAdminTransport;
  canManage: boolean;
  /** False: no customer email can leave, so none is offered. */
  customerEmails: boolean;
  locale: string;
  nowMs: number;
  onClose: () => void;
  onOpenVisit: (id: string) => void;
  onChanged: (visit: VisitSnapshot, message: string) => void;
}) {
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const ids = useId();
  const list = pending.filter((v) => !answered.has(v.id));

  const answer = async (visit: VisitSnapshot, kind: "accept" | "decline") => {
    setBusy(visit.id);
    setErrors((current) => ({ ...current, [visit.id]: "" }));
    const trimmed = reason.trim();
    const tell = customerEmails && notify;
    const res =
      kind === "accept"
        ? await transport.accept(visit.id, { notify: tell })
        : await transport.decline(visit.id, { notify: tell, ...(trimmed ? { reason: trimmed.slice(0, 500) } : {}) });
    setBusy(null);
    if (!res.ok) {
      setErrors((current) => ({ ...current, [visit.id]: adminErrorText(res.error) }));
      return;
    }
    setDeclining(null);
    setReason("");
    setAnswered((current) => new Set([...current, visit.id]));
    onChanged(res.data.visit, kind === "accept" ? `Accepted: ${visit.customerName ?? "the request"}.` : `Declined: ${visit.customerName ?? "the request"}.`);
  };

  return (
    <Dialog title={`Requests (${list.length})`} onClose={onClose} data={{ "aisw-requests": "" }}>
      {list.length === 0 ? (
        <p className="aisw-hint" role="status">
          Nothing waiting. New online requests show up here.
        </p>
      ) : (
        <>
          {canManage && customerEmails ? <Check checked={notify} onChange={setNotify} label="Email customers about my answers" /> : null}
          {canManage && !customerEmails ? (
            <p className="aisw-hint" data-aisw-no-email="">
              Customer emails are off, so customers won&apos;t hear your answers from here. Call them.
            </p>
          ) : null}
          <ul className="aisw-requests">
            {list.map((visit) => {
              const expiry = expiresIn(visit.pendingExpiresAt, nowMs);
              const firstNoteLine = visit.notes?.split(/\r?\n/).find((line) => line.trim())?.trim() ?? null;
              return (
                <li key={visit.id} className="aisw-request" data-request-id={visit.id}>
                  {/* The time ONCE ("Mon, Nov 2, 9:00 – 10:00 AM"), then what a
                      field-service owner decides on: where it is, and what the
                      customer said (BO-10). */}
                  <span className="aisw-request-when">
                    {formatShortDate(visit.date, locale)}, {formatTimeRange(visit.startTime, visit.endTime, locale)}
                  </span>
                  <span className="aisw-request-meta">
                    {visit.customerName ?? "No name"} · {visit.serviceName}
                    {visit.resourceName ? ` · ${visit.resourceName}` : ""}
                  </span>
                  <span className="aisw-request-where" data-aisw-request-address="">
                    {visit.address ?? "No address given"}
                  </span>
                  {firstNoteLine ? (
                    <span className="aisw-hint" data-aisw-request-note="">
                      “{firstNoteLine.length > 140 ? `${firstNoteLine.slice(0, 139)}…` : firstNoteLine}”
                    </span>
                  ) : null}
                  {expiry ? <span className="aisw-hint">{expiry[0]!.toUpperCase() + expiry.slice(1)} if nobody answers.</span> : null}
                  {declining === visit.id ? (
                    <div className="aisw-stack-sm">
                      <label className="aisw-label" htmlFor={`${ids}-${visit.id}-reason`}>
                        A note for the customer <span className="aisw-optional">(optional)</span>
                      </label>
                      <textarea
                        id={`${ids}-${visit.id}-reason`}
                        className="aisw-input"
                        rows={2}
                        maxLength={500}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                      <div className="aisw-actions">
                        <button type="button" className="aisw-btn aisw-btn-danger" disabled={busy !== null} onClick={() => void answer(visit, "decline")}>
                          {busy === visit.id ? "Saving…" : "Decline request"}
                        </button>
                        <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => setDeclining(null)}>
                          Back
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="aisw-actions">
                      {canManage ? (
                        <>
                          <button
                            type="button"
                            className="aisw-btn aisw-btn-primary aisw-btn-sm"
                            disabled={busy !== null}
                            aria-label={`Accept ${visit.customerName ?? "request"}, ${describeShortWhen(visit, locale)}`}
                            onClick={() => void answer(visit, "accept")}
                          >
                            {busy === visit.id ? "Saving…" : "Accept"}
                          </button>
                          <button
                            type="button"
                            className="aisw-btn aisw-btn-danger-outline aisw-btn-sm"
                            disabled={busy !== null}
                            aria-label={`Decline ${visit.customerName ?? "request"}, ${describeShortWhen(visit, locale)}`}
                            onClick={() => {
                              setReason("");
                              setDeclining(visit.id);
                            }}
                          >
                            Decline
                          </button>
                        </>
                      ) : null}
                      <button type="button" className="aisw-btn aisw-btn-secondary aisw-btn-sm" onClick={() => onOpenVisit(visit.id)}>
                        Details
                      </button>
                    </div>
                  )}
                  {errors[visit.id] ? (
                    <p className="aisw-danger-text" role="alert">
                      {errors[visit.id]}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Dialog>
  );
}
