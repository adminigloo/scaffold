"use client";

import { useMemo, useState } from "react";
// Type-only, so nothing from the server package reaches the browser bundle.
import type { BookingStatus } from "__SCOPE__/scheduling";
import { api } from "@/trpc/client";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  Notice,
  PageHeader,
} from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";
import { crewHoursLabel, scheduleRange, statusLabel } from "@/components/schedule/scheduleView";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function statusTone(status: string): BadgeTone {
  // Pending is a web request nobody has accepted yet — the row that needs a person.
  if (status === "pending") return "warn";
  if (status === "confirmed" || status === "completed") return "accent";
  if (status === "cancelled" || status === "no_show") return "danger";
  return "neutral";
}

const selectClass = "rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-ink";

/**
 * The scheduling board, from __SCOPE__/scheduling: upcoming visits, the crews
 * that run them, and each crew's weekly availability. Customers request visits
 * online (they land "Requested" here, to accept or decline); this is where
 * staff see and steer the calendar.
 *
 * A request gets Accept and Decline buttons. Every other visit gets a status
 * menu offering only the moves the package allows from where it is (the server
 * sends them as `nextStatuses`), so a misclick can't turn a completed visit
 * back into a request. Bringing a cancelled visit back re-checks its slot, and
 * if somebody has taken it since, the refusal is shown here.
 */
export default function SchedulePage() {
  // From today's UTC midnight, so today's visits stay listed (see scheduleRange).
  const range = useMemo(() => scheduleRange(new Date()), []);
  const bookings = api.scheduling.bookings.useQuery(range);
  const setStatus = api.scheduling.setBookingStatus.useMutation();

  const move = (id: string, status: BookingStatus) =>
    void setStatus
      .mutateAsync({ id, status })
      .catch(() => undefined) // shown in the notice above the list
      .then(() => bookings.refetch());

  return (
    <>
      <PageHeader
        title="Schedule"
        description="Upcoming visits and the crews that run them. Online requests arrive as Requested for you to accept or decline; each one holds its time until you do."
      />

      <div className="flex flex-col gap-6">
        <ResourcesCard />

        <Card>
          <CardBody className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-ink">Today and the next 30 days</h2>
            {setStatus.error ? (
              <Notice tone="warn" role="alert">
                {setStatus.error.message}
              </Notice>
            ) : null}
            {bookings.isLoading ? (
              <p className="text-sm text-ink-muted">Loading the calendar…</p>
            ) : (bookings.data ?? []).length === 0 ? (
              <EmptyState title="No visits booked yet">
                Requests from your booking page land here for you to accept.
              </EmptyState>
            ) : (
              <div className="flex flex-col gap-1.5">
                {(bookings.data ?? []).map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-2 text-sm">
                    <span className="font-mono text-xs text-ink-muted">
                      {new Date(b.scheduledDate).toISOString().slice(0, 10)} {b.startTime}–{b.endTime}
                    </span>
                    <span className="text-ink">{b.customerName ?? b.title ?? b.serviceType}</span>
                    {b.address ? <span className="text-xs text-ink-faint">{b.address}</span> : null}
                    <Badge tone={statusTone(b.status)}>{statusLabel(b.status)}</Badge>
                    {b.status === "pending" ? (
                      <div className="ml-auto flex gap-2">
                        <Button variant="primary" disabled={setStatus.isPending} onClick={() => move(b.id, "confirmed")}>
                          Accept
                        </Button>
                        <Button disabled={setStatus.isPending} onClick={() => move(b.id, "cancelled")}>
                          Decline
                        </Button>
                      </div>
                    ) : (
                      <select
                        value={b.status}
                        aria-label={`Status of the ${b.startTime} visit`}
                        disabled={setStatus.isPending}
                        onChange={(e) => move(b.id, e.target.value as BookingStatus)}
                        className={`${selectClass} ml-auto`}
                      >
                        {[b.status, ...b.nextStatuses].map((s) => (
                          <option key={s} value={s}>
                            {statusLabel(s)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

interface CrewHours {
  id: string;
  workStartTime: string;
  workEndTime: string;
  hoursConfigured: boolean;
}

/**
 * Run a crew action and say what happened. The three crew buttons used to
 * call `mutateAsync` with no catch: a failure was an unhandled rejection with
 * nothing on screen, and a "not found" answer (`null`, or `{ ok: false }`) was
 * dropped. Now both land in the card's notice.
 */
async function reportProblems(work: () => Promise<unknown>, onProblem: (message: string | null) => void): Promise<void> {
  onProblem(null);
  try {
    const result = await work();
    const missed =
      result === null || (typeof result === "object" && result !== null && "ok" in result && result.ok === false);
    if (missed) onProblem("That crew is no longer on this workspace's schedule. Refresh the page.");
  } catch (error) {
    onProblem(error instanceof Error ? error.message : "That didn't save. Try again.");
  }
}

function ResourcesCard() {
  const resources = api.scheduling.resources.useQuery();
  const create = api.scheduling.createResource.useMutation();
  const update = api.scheduling.updateResource.useMutation();
  const remove = api.scheduling.deactivateResource.useMutation();
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const act = (work: () => Promise<unknown>) =>
    void reportProblems(work, setProblem).then(() => resources.refetch());

  const add = () => {
    if (!name.trim()) return;
    act(async () => {
      const row = await create.mutateAsync({ name: name.trim(), homeBaseAddress: base.trim() || null });
      setName("");
      setBase("");
      return row;
    });
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">Crews &amp; resources</h2>
        {problem ? (
          <Notice tone="warn" role="alert">
            {problem}
          </Notice>
        ) : null}
        <div className="flex flex-col gap-1.5">
          {(resources.data ?? []).map((r) => {
            const hours = crewHoursLabel(r);
            return (
              <div key={r.id}>
                <div className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-1.5 text-sm">
                  <span className="text-ink">{r.name}</span>
                  {r.homeBaseAddress ? <span className="text-xs text-ink-faint">{r.homeBaseAddress}</span> : null}
                  {hours.off ? (
                    <Badge tone="danger">{hours.text}</Badge>
                  ) : (
                    <span className="font-mono text-xs text-ink-faint">{hours.text}</span>
                  )}
                  {r.acceptsPublicBookings ? null : <Badge tone="warn">online booking paused</Badge>}
                  <button
                    type="button"
                    onClick={() => setSelected(selected === r.id ? null : r.id)}
                    className="ml-auto text-xs text-accent underline underline-offset-2"
                  >
                    {selected === r.id ? "Hide hours" : "Hours"}
                  </button>
                  <Button
                    disabled={update.isPending}
                    onClick={() =>
                      act(() => update.mutateAsync({ id: r.id, patch: { acceptsPublicBookings: !r.acceptsPublicBookings } }))
                    }
                  >
                    {r.acceptsPublicBookings ? "Pause online booking" : "Resume online booking"}
                  </Button>
                  <Button variant="danger" disabled={remove.isPending} onClick={() => act(() => remove.mutateAsync({ id: r.id }))}>
                    Remove
                  </Button>
                </div>
                {selected === r.id ? <AvailabilityEditor crew={r} onSaved={() => void resources.refetch()} /> : null}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Input placeholder="Crew name" value={name} onChange={(e) => setName(e.target.value)} className="w-48" />
          <Input placeholder="Home base (city, state)" value={base} onChange={(e) => setBase(e.target.value)} className="w-56" />
          <Button variant="primary" disabled={!name.trim() || create.isPending} onClick={add}>
            Add crew
          </Button>
        </div>
        <p className="text-xs text-ink-faint">
          Until you save its hours, a new crew works Monday to Friday during its work hours. Once saved, the
          ticked days are its whole week: untick every day and save to stop it working. &ldquo;Pause online
          booking&rdquo; keeps a crew on your calendar but stops customers booking it from the website.
          &ldquo;Remove&rdquo; takes it off the schedule; its booked visits stay as they are. Customers see open
          times in time order, with 30 minutes kept clear around each visit for travel. Addresses and home bases
          are stored as typed: drive times come into it once a geocoding maps provider is wired into the
          scheduling router.
        </p>
      </CardBody>
    </Card>
  );
}

interface WeekRow {
  on: boolean;
  start: string;
  end: string;
}

function AvailabilityEditor({ crew, onSaved }: { crew: CrewHours; onSaved: () => void }) {
  const current = api.scheduling.availability.useQuery({ resourceId: crew.id });
  const save = api.scheduling.setAvailability.useMutation();
  const [week, setWeek] = useState<WeekRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Nothing to edit until the stored rows are here. Rendering the grid first
  // showed a configured crew as off every day, and a tick in that moment
  // snapshotted the empty week — which is what Save then sent.
  const stored = current.data;
  if (!stored) {
    return <p className="mt-1 ml-3 border-l border-line pl-3 text-xs text-ink-faint">Loading hours…</p>;
  }

  // Initialize the grid from stored rows the first time they load.
  const rows = week ?? initWeek(crew, stored);

  const set = (i: number, patch: Partial<WeekRow>) =>
    setWeek(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const commit = async () => {
    const weekly = rows
      .map((r, dow) => (r.on ? { dayOfWeek: dow, startTime: r.start, endTime: r.end, isAvailable: true } : null))
      .filter((b): b is { dayOfWeek: number; startTime: string; endTime: string; isAvailable: boolean } => b !== null);
    // Saving replaces the crew's whole availability, so send its dated
    // exceptions (time off, special hours) back with the week — this editor
    // only changes the week, and must not wipe a day off it doesn't show.
    const dated = stored
      .filter((r) => r.specificDate !== null)
      .map((r) => ({
        specificDate: r.specificDate,
        startTime: r.startTime,
        endTime: r.endTime,
        isAvailable: r.isAvailable,
        note: r.note,
      }));
    await reportProblems(() => save.mutateAsync({ resourceId: crew.id, blocks: [...weekly, ...dated] }), setProblem);
    void current.refetch();
    onSaved();
  };

  return (
    <div className="mt-1 ml-3 flex flex-col gap-1 border-l border-line pl-3">
      {problem ? (
        <Notice tone="warn" role="alert">
          {problem}
        </Notice>
      ) : null}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <label className="flex w-16 items-center gap-1.5">
            <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} />
            {DOW[i]}
          </label>
          {r.on ? (
            <>
              <Input type="time" value={r.start} onChange={(e) => set(i, { start: e.target.value })} className="w-28" />
              <Input type="time" value={r.end} onChange={(e) => set(i, { end: e.target.value })} className="w-28" />
            </>
          ) : (
            <span className="text-xs text-ink-faint">off</span>
          )}
        </div>
      ))}
      {rows.every((r) => !r.on) ? (
        <p className="text-xs text-ink-faint">No days ticked: saving turns this crew off every day.</p>
      ) : null}
      <div>
        <Button variant="primary" disabled={save.isPending} onClick={() => void commit()}>
          {save.isPending ? "Saving…" : "Save hours"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The week as the scheduler sees it. A crew whose hours were never saved works
 * Mon–Fri on its own work hours (the package's fallback), so that is what the
 * grid shows; once saved, the stored weekly rows are the whole week and an
 * unticked day is off — an empty week is shown empty, not as Mon–Fri.
 */
function initWeek(
  crew: CrewHours,
  data: Array<{ dayOfWeek: number | null; specificDate: Date | string | null; startTime: string; endTime: string; isAvailable: boolean }>,
): WeekRow[] {
  const week: WeekRow[] = Array.from({ length: 7 }, (_, dow) => ({
    on: !crew.hoursConfigured && dow >= 1 && dow <= 5,
    start: crew.workStartTime,
    end: crew.workEndTime,
  }));
  const recurring = data.filter((r) => !r.specificDate && r.dayOfWeek !== null);
  if (recurring.length > 0) {
    for (const row of week) row.on = false;
    for (const r of recurring) {
      const i = r.dayOfWeek!;
      week[i] = { on: r.isAvailable, start: r.startTime, end: r.endTime };
    }
  }
  return week;
}
