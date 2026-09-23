"use client";

import { useMemo, useState } from "react";
import { api } from "@/trpc/client";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  PageHeader,
} from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUSES = ["pending", "confirmed", "in_progress", "completed", "cancelled", "no_show"] as const;

function statusTone(status: string): BadgeTone {
  if (status === "confirmed" || status === "completed") return "accent";
  if (status === "cancelled" || status === "no_show") return "danger";
  return "neutral";
}

const selectClass = "rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-ink";

/**
 * The scheduling board, from __SCOPE__/scheduling: upcoming visits, the crews
 * that run them, and each crew's weekly availability. Booking itself happens on
 * the drive-time-scored slots (from the estimate flow and the package's
 * findAvailableSlots); this is where staff see and steer the calendar.
 */
export default function SchedulePage() {
  const range = useMemo(() => {
    const from = new Date();
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return { from, to };
  }, []);
  const bookings = api.scheduling.bookings.useQuery(range);
  const setStatus = api.scheduling.setBookingStatus.useMutation();

  return (
    <>
      <PageHeader
        title="Schedule"
        description="Upcoming visits and the crews that run them. New bookings are placed on drive-time-scored slots, so a day of jobs clusters instead of crisscrossing."
      />

      <div className="flex flex-col gap-6">
        <ResourcesCard />

        <Card>
          <CardBody className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-ink">Next 30 days</h2>
            {bookings.isLoading ? (
              <p className="text-sm text-ink-muted">Loading the calendar…</p>
            ) : (bookings.data ?? []).length === 0 ? (
              <EmptyState title="No visits booked yet">
                They appear here when a customer books from the estimate flow, or you add one.
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
                    <Badge tone={statusTone(b.status)}>{b.status}</Badge>
                    <select
                      value={b.status}
                      onChange={(e) =>
                        void setStatus
                          .mutateAsync({ id: b.id, status: e.target.value as (typeof STATUSES)[number] })
                          .then(() => bookings.refetch())
                      }
                      className={`${selectClass} ml-auto`}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
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

function ResourcesCard() {
  const resources = api.scheduling.resources.useQuery();
  const create = api.scheduling.createResource.useMutation();
  const remove = api.scheduling.deactivateResource.useMutation();
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim()) return;
    await create.mutateAsync({ name: name.trim(), homeBaseAddress: base.trim() || null });
    setName("");
    setBase("");
    void resources.refetch();
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">Crews &amp; resources</h2>
        <div className="flex flex-col gap-1.5">
          {(resources.data ?? []).map((r) => (
            <div key={r.id}>
              <div className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-1.5 text-sm">
                <span className="text-ink">{r.name}</span>
                {r.homeBaseAddress ? <span className="text-xs text-ink-faint">{r.homeBaseAddress}</span> : null}
                <span className="font-mono text-xs text-ink-faint">{r.workStartTime}–{r.workEndTime}</span>
                <button
                  type="button"
                  onClick={() => setSelected(selected === r.id ? null : r.id)}
                  className="ml-auto text-xs text-accent underline underline-offset-2"
                >
                  {selected === r.id ? "Hide hours" : "Hours"}
                </button>
                <Button variant="danger" onClick={() => void remove.mutateAsync({ id: r.id }).then(() => resources.refetch())}>
                  Remove
                </Button>
              </div>
              {selected === r.id ? <AvailabilityEditor resourceId={r.id} /> : null}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Input placeholder="Crew name" value={name} onChange={(e) => setName(e.target.value)} className="w-48" />
          <Input placeholder="Home base (city, state)" value={base} onChange={(e) => setBase(e.target.value)} className="w-56" />
          <Button variant="primary" disabled={!name.trim() || create.isPending} onClick={() => void add()}>
            Add crew
          </Button>
        </div>
        <p className="text-xs text-ink-faint">
          A crew with no set hours works Mon–Fri, {`{workStartTime}`}–{`{workEndTime}`}. Set a home base
          (and a maps key) to turn on drive-time-aware slot scoring.
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

function AvailabilityEditor({ resourceId }: { resourceId: string }) {
  const current = api.scheduling.availability.useQuery({ resourceId });
  const save = api.scheduling.setAvailability.useMutation();
  const [week, setWeek] = useState<WeekRow[] | null>(null);

  // Initialize the grid from stored rows the first time they load.
  const rows = week ?? initWeek(current.data);

  const set = (i: number, patch: Partial<WeekRow>) =>
    setWeek(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const commit = async () => {
    const blocks = rows
      .map((r, dow) => (r.on ? { dayOfWeek: dow, startTime: r.start, endTime: r.end, isAvailable: true } : null))
      .filter((b): b is { dayOfWeek: number; startTime: string; endTime: string; isAvailable: boolean } => b !== null);
    await save.mutateAsync({ resourceId, blocks });
    void current.refetch();
  };

  return (
    <div className="mt-1 ml-3 flex flex-col gap-1 border-l border-line pl-3">
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
      <div>
        <Button variant="primary" disabled={save.isPending} onClick={() => void commit()}>
          {save.isPending ? "Saving…" : "Save hours"}
        </Button>
      </div>
    </div>
  );
}

function initWeek(
  data: Array<{ dayOfWeek: number | null; specificDate: Date | string | null; startTime: string; endTime: string; isAvailable: boolean }> | undefined,
): WeekRow[] {
  const week: WeekRow[] = Array.from({ length: 7 }, (_, dow) => ({
    on: dow >= 1 && dow <= 5,
    start: "08:00",
    end: "17:00",
  }));
  if (!data) return week;
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
