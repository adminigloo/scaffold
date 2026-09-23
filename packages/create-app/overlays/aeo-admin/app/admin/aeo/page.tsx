"use client";

import { useState } from "react";
import { api } from "@/trpc/client";
import { Badge, Button, Card, CardBody, EmptyState, Input, PageHeader } from "@/components/ui";

/**
 * AI citation tracking, from __SCOPE__/aeo. Track the questions customers ask an
 * assistant, then "Run checks" to ask the injected model each one and see
 * whether the answer mentions you. The honest, doable version of "does an AI
 * engine cite us" — evidence, not a vanity number. Checks are a no-op until an
 * asker is wired in src/server/aeo-asker.ts.
 */
export default function AeoPage() {
  const dashboard = api.aeo.dashboard.useQuery();
  const run = api.aeo.runChecks.useMutation();
  const create = api.aeo.createQuery.useMutation();
  const remove = api.aeo.deactivateQuery.useMutation();
  const [ran, setRan] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("");
  const [domain, setDomain] = useState("");
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  const add = async () => {
    if (!query.trim() || !brand.trim()) return;
    await create.mutateAsync({ query: query.trim(), brand: brand.trim(), domain: domain.trim() || null });
    setQuery("");
    void dashboard.refetch();
  };

  return (
    <>
      <PageHeader
        title="AI citations"
        description="For the questions your customers ask an assistant, does the answer mention you? Track queries and check them over time."
        actions={
          <Button
            variant="primary"
            disabled={run.isPending}
            onClick={() =>
              void run.mutateAsync().then((r) => {
                setRan(`Checked ${r.checked} quer${r.checked === 1 ? "y" : "ies"} — cited in ${r.cited}.`);
                void dashboard.refetch();
              })
            }
          >
            {run.isPending ? "Checking…" : "Run checks"}
          </Button>
        }
      />

      {ran ? <p className="mb-4 text-sm text-accent">{ran}</p> : null}

      {dashboard.isLoading ? (
        <EmptyState title="Loading…">Reading tracked queries.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardBody className="flex flex-col gap-2">
              {(dashboard.data ?? []).length === 0 ? (
                <p className="text-sm text-ink-muted">No queries tracked yet — add one below.</p>
              ) : (
                (dashboard.data ?? []).map(({ query: q, latest }) => (
                  <div key={q.id}>
                    <div className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-2 text-sm">
                      <span className="text-ink">{q.query}</span>
                      <span className="text-xs text-ink-faint">→ {q.brand}</span>
                      {latest ? (
                        <Badge tone={latest.cited ? "accent" : "neutral"}>
                          {latest.cited ? `cited · ${latest.matchedOn}` : "not cited"}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">never checked</Badge>
                      )}
                      {latest ? (
                        <span className="text-xs text-ink-faint">{new Date(latest.checkedAt).toLocaleDateString()}</span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setOpenHistory(openHistory === q.id ? null : q.id)}
                        className="text-xs text-accent underline underline-offset-2"
                      >
                        History
                      </button>
                      <Button variant="danger" className="ml-auto" onClick={() => void remove.mutateAsync({ id: q.id }).then(() => dashboard.refetch())}>
                        Remove
                      </Button>
                    </div>
                    {openHistory === q.id ? <History queryId={q.id} /> : null}
                  </div>
                ))
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody className="flex flex-wrap items-end gap-2">
              <label className="flex flex-1 flex-col gap-1 text-xs font-medium uppercase tracking-wider text-ink-faint">
                Question a customer might ask
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="best wheelchair ramp installer near me" className="w-full" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wider text-ink-faint">
                Brand
                <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="your brand" className="w-40" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wider text-ink-faint">
                Domain
                <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" className="w-44" />
              </label>
              <Button variant="primary" disabled={!query.trim() || !brand.trim() || create.isPending} onClick={() => void add()}>
                Track it
              </Button>
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}

function History({ queryId }: { queryId: string }) {
  const history = api.aeo.history.useQuery({ queryId });
  return (
    <div className="ml-3 mt-1 flex flex-col gap-1 border-l border-line pl-3 text-xs text-ink-muted">
      {(history.data ?? []).length === 0 ? (
        <p>No checks yet.</p>
      ) : (
        (history.data ?? []).map((c) => (
          <p key={c.id}>
            <span className="font-mono">{new Date(c.checkedAt).toISOString().slice(0, 10)}</span> · {c.engine} ·{" "}
            <span className={c.cited ? "text-accent" : "text-ink-faint"}>{c.cited ? "cited" : "not cited"}</span>
          </p>
        ))
      )}
    </div>
  );
}
