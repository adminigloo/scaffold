"use client";

import { useState } from "react";
import { Badge, Button, Card, CardBody, Notice, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { api } from "@/trpc/client";

/**
 * The operator's list of __TENANT_LABEL_LOWER__s with their plan, and "Give free months"
 * (billing 0.3). Words, not states: "Free trial until May 3", "Paused: trial
 * ended". A __TENANT_LABEL_LOWER__ that pays through Stripe can't be given free months here
 * (the server refuses, in words): change or cancel its plan first.
 */
export interface CompanyPlansProps {
  readonly giftable: readonly { readonly key: string; readonly name: string }[];
  /** Each plan's name by its key, so the list says "Pro", not "pro". */
  readonly tierNames: Readonly<Record<string, string>>;
}

type PlanView = {
  readonly state: "trial" | "active" | "ending" | "grace" | "ended" | "none";
  readonly open: boolean;
  readonly tierKey: string | null;
  readonly until: string | null;
} | null;

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A plan's standing in words, for one badge. */
export function planWords(plan: PlanView, tierNames: Readonly<Record<string, string>> = {}): { readonly text: string; readonly tone: "accent" | "neutral" | "danger" | "warn" } {
  if (plan === null) return { text: "No plans in this project", tone: "neutral" };
  const tier = plan.tierKey ? ` (${tierNames[plan.tierKey] ?? plan.tierKey})` : "";
  switch (plan.state) {
    case "trial":
      return { text: plan.until ? `Free trial until ${day(plan.until)}` : "Free trial", tone: "accent" };
    case "active":
      return { text: `Paying${tier}`, tone: "accent" };
    case "ending":
      return { text: plan.until ? `Ends ${day(plan.until)}${tier}` : `Ending${tier}`, tone: "neutral" };
    case "grace":
      return { text: plan.until ? `Payment failed: closes ${day(plan.until)}` : "Payment failed", tone: "warn" };
    case "ended":
      return { text: `Paused: plan ended${tier}`, tone: "danger" };
    case "none":
      return { text: "Paused: trial ended", tone: "danger" };
  }
}

export function CompanyPlans(props: CompanyPlansProps) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const list = api.billing.companies.useQuery({ ...(search ? { q: search } : {}), page });
  const [giving, setGiving] = useState<{ readonly id: string; readonly name: string } | null>(null);
  const [tierKey, setTierKey] = useState(props.giftable[0]?.key ?? "");
  const [months, setMonths] = useState(3);
  const [done, setDone] = useState<string | null>(null);
  const comp = api.billing.compPlan.useMutation({
    onSuccess: (result, variables) => {
      setDone(`Free months given until ${day(result.endsAt)} (${variables.tierKey}).`);
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
          placeholder="Find by name or web address"
          aria-label="Find a __TENANT_LABEL_LOWER__"
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
              Give <strong>{giving.name}</strong> free months of a plan. It ends by itself; nothing is charged.
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

      <Table>
        <THead>
          <TR>
            <TH>__TENANT_LABEL__</TH>
            <TH>Plan</TH>
            <TH>People</TH>
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {(list.data?.companies ?? []).map((company) => {
            const words = planWords(company.plan as PlanView, props.tierNames);
            return (
              <TR key={company.id}>
                <TD>
                  {company.name}
                  {company.status === "suspended" && (
                    <span className="ml-2">
                      <Badge tone="danger">Suspended</Badge>
                    </span>
                  )}
                </TD>
                <TD>
                  <Badge tone={words.tone}>{words.text}</Badge>
                </TD>
                <TD>{company.members}</TD>
                <TD>
                  {company.plan !== null && props.giftable.length > 0 && (
                    <Button variant="secondary" onClick={() => setGiving({ id: company.id, name: company.name })}>
                      Give free months
                    </Button>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>

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
