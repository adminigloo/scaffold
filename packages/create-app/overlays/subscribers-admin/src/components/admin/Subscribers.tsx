"use client";

import { useState } from "react";
import { Badge, Button, Card, CardBody, Notice, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { api } from "@/trpc/client";

/**
 * The founder's list of subscribers (billing 0.5): each person, and where
 * they stand on every product line — "Weather Pro, renews", "Sports: ends Nov
 * 3", "Not subscribed". With no search it lists the people who have (or had) a
 * plan; a search finds anyone by name or email, so free months can go to
 * someone who never paid. Free months of a line someone already pays for by
 * card are refused by the server, in words.
 */
export interface SubscribersProps {
  readonly giftable: readonly { readonly key: string; readonly name: string }[];
}

interface LineView {
  readonly line: string;
  readonly lineName: string;
  readonly state: "trial" | "active" | "ending" | "grace" | "ended" | "none";
  readonly tierName: string | null;
  readonly until: string | null;
  readonly paidByCard: boolean;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** One line's standing in words, for one badge. */
export function lineWords(line: LineView, showLine: boolean): { readonly text: string; readonly tone: "accent" | "neutral" | "danger" | "warn" } {
  const name = line.tierName ?? line.lineName;
  const prefix = showLine && line.tierName !== null && !line.tierName.includes(line.lineName) ? `${line.lineName} ${line.tierName}` : name;
  switch (line.state) {
    case "active":
      return { text: `${prefix}${line.paidByCard ? "" : " (free months)"}`, tone: "accent" };
    case "trial":
      return { text: line.until ? `${prefix}: free trial until ${day(line.until)}` : `${prefix}: free trial`, tone: "accent" };
    case "ending":
      return { text: line.until ? `${prefix}: ends ${day(line.until)}` : `${prefix}: ending`, tone: "neutral" };
    case "grace":
      return { text: line.until ? `${prefix}: payment failed, stops ${day(line.until)}` : `${prefix}: payment failed`, tone: "warn" };
    case "ended":
      return { text: `${prefix}: ended`, tone: "neutral" };
    case "none":
      return { text: showLine ? `${line.lineName}: not subscribed` : "Not subscribed", tone: "neutral" };
  }
}

export function Subscribers(props: SubscribersProps) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const list = api.billing.subscribers.useQuery({ ...(search ? { q: search } : {}), page });
  const [giving, setGiving] = useState<{ readonly id: string; readonly name: string } | null>(null);
  const [tierKey, setTierKey] = useState(props.giftable[0]?.key ?? "");
  const [months, setMonths] = useState(1);
  const [done, setDone] = useState<string | null>(null);
  const comp = api.billing.compPlan.useMutation({
    onSuccess: (result) => {
      setDone(`Free months given until ${day(result.endsAt)}.`);
      setGiving(null);
      void list.refetch();
    },
  });
  const failure = list.error ?? comp.error;

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setSearch(q.trim());
        }}
      >
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Find anyone by name or email"
          aria-label="Find a person"
          className="min-w-0 flex-1 rounded-md border border-line bg-transparent px-3 py-2 text-sm"
        />
        <Button type="submit" variant="secondary">
          Find
        </Button>
      </form>

      {done && (
        <Notice tone="info" title="Free months given" role="status">
          {done}
        </Notice>
      )}
      {failure && (
        <Notice tone="danger" title="That didn't work" role="alert">
          {failure.message}
        </Notice>
      )}

      {giving && (
        <Card>
          <CardBody className="flex flex-col gap-3">
            <p className="text-sm">
              Give <strong>{giving.name}</strong> free months of a plan. They end by themselves; nothing is charged.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                Plan
                <select
                  value={tierKey}
                  onChange={(event) => setTierKey(event.target.value)}
                  className="rounded-md border border-line bg-transparent px-2 py-1 text-sm"
                >
                  {props.giftable.map((tier) => (
                    <option key={tier.key} value={tier.key}>
                      {tier.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                Months
                <input
                  type="number"
                  min={1}
                  max={36}
                  value={months}
                  onChange={(event) => setMonths(Math.max(1, Math.min(36, Number(event.target.value) || 1)))}
                  className="w-20 rounded-md border border-line bg-transparent px-2 py-1 text-sm"
                />
              </label>
              <Button
                variant="primary"
                disabled={comp.isPending || tierKey === ""}
                onClick={() => comp.mutate({ tenantId: giving.id, tierKey, months })}
              >
                {comp.isPending ? "Giving…" : "Give free months"}
              </Button>
              <Button variant="secondary" disabled={comp.isPending} onClick={() => setGiving(null)}>
                Cancel
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {list.data && list.data.people.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {search ? "Nobody by that name or email." : "Nobody has a plan yet. Search for someone to give them free months."}
        </p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Person</TH>
              <TH>Plans</TH>
              <TH>Joined</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {(list.data?.people ?? []).map((person) => (
              <TR key={person.tenantId}>
                <TD>
                  <span className="block">{person.name}</span>
                  {person.email && <span className="block text-xs text-ink-muted">{person.email}</span>}
                </TD>
                <TD>
                  <span className="flex flex-wrap gap-1">
                    {person.lines.map((line) => {
                      const words = lineWords(line as LineView, person.lines.length > 1);
                      return (
                        <Badge key={line.line} tone={words.tone}>
                          {words.text}
                        </Badge>
                      );
                    })}
                  </span>
                </TD>
                <TD>{day(person.joinedAt)}</TD>
                <TD>
                  {props.giftable.length > 0 && (
                    <Button variant="secondary" onClick={() => setGiving({ id: person.tenantId, name: person.name })}>
                      Give free months
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {list.data && list.data.total > list.data.pageSize && (
        <div className="flex items-center gap-2 text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-ink-muted">
            Page {list.data.page} of {Math.ceil(list.data.total / list.data.pageSize)}
          </span>
          <Button
            variant="secondary"
            disabled={list.data.page * list.data.pageSize >= list.data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
