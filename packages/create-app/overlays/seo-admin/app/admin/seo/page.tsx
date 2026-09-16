"use client";

import { useState } from "react";
import { api } from "@/trpc/client";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";

/**
 * SEO & AEO reports — the site grading itself, with receipts.
 *
 * Every run is stored whole, so an old report re-renders exactly as it was
 * scored; the page never re-derives history. The two halves are shown as two
 * numbers on purpose: "search engines read us fine" and "answer engines
 * cannot see us" is the exact split this feature exists to reveal, and one
 * blended score would hide it.
 */

type SiteCheck = {
  id: string;
  label: string;
  kind: "seo" | "aeo";
  status: "pass" | "warn" | "fail";
  detail: string;
};

type ReportPage = { path: string; checks: SiteCheck[] };

const STATUS_TONE: Record<SiteCheck["status"], BadgeTone> = {
  pass: "neutral",
  warn: "warn",
  fail: "danger",
};

export default function SeoReportsPage() {
  const reports = api.seo.list.useQuery();
  const run = api.seo.run.useMutation();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const activeId = selectedId ?? reports.data?.[0]?.id ?? null;
  const report = api.seo.get.useQuery(
    { reportId: activeId ?? "" },
    { enabled: activeId !== null },
  );

  return (
    <>
      <PageHeader
        title="SEO & AEO"
        description="How search engines and answer engines read this site — audited from the outside, the way a crawler arrives, with every check carrying its evidence."
        actions={
          <Button
            variant="primary"
            disabled={run.isPending}
            onClick={() =>
              void run.mutateAsync().then((result) => {
                setSelectedId(result.id);
                void reports.refetch();
              })
            }
          >
            {run.isPending ? "Crawling…" : "Run a report"}
          </Button>
        }
      />

      {reports.data && reports.data.length === 0 ? (
        <EmptyState
          title="No reports yet"
          action={
            <Button variant="primary" disabled={run.isPending} onClick={() => void run.mutateAsync().then((r) => { setSelectedId(r.id); void reports.refetch(); })}>
              {run.isPending ? "Crawling…" : "Run the first report"}
            </Button>
          }
        >
          A report crawls this site's own sitemap and scores how search engines and answer
          engines will read it. Takes a few seconds.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <Card className="self-start">
            <CardHeader title="Runs" hint="Newest first." />
            <ul className="divide-y divide-line">
              {(reports.data ?? []).map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    className={
                      row.id === activeId
                        ? "flex w-full items-center gap-2 bg-accent-soft/60 px-4 py-2.5 text-left text-sm text-ink"
                        : "flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-ink-muted transition-colors hover:bg-canvas"
                    }
                  >
                    <span className="font-semibold tabular-nums">{row.score}</span>
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {new Date(row.finishedAt).toLocaleString()}
                    </span>
                    <span className="text-xs text-ink-muted tabular-nums">{row.pageCount}p</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <div className="flex flex-col gap-4">
            {report.data ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <ScoreTile label="Overall" value={report.data.score} />
                  <ScoreTile label="Search engines" value={report.data.seoScore} />
                  <ScoreTile label="Answer engines" value={report.data.aeoScore} />
                </div>

                <Card>
                  <CardHeader
                    title="Site-level checks"
                    hint="robots.txt, llms.txt, the sitemap, and who is allowed in."
                  />
                  <CardBody className="flex flex-col gap-2">
                    {(report.data.siteChecks as SiteCheck[]).map((check) => (
                      <CheckRow key={check.id} check={check} />
                    ))}
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader
                    title={`Pages (${(report.data.pages as ReportPage[]).length})`}
                    hint="From this site's own sitemap, same origin only."
                  />
                  <CardBody className="flex flex-col gap-2">
                    {(report.data.pages as ReportPage[]).map((page) => {
                      const worst = page.checks.some((c) => c.status === "fail")
                        ? "fail"
                        : page.checks.some((c) => c.status === "warn")
                          ? "warn"
                          : "pass";
                      return (
                        <details key={page.path} className="rounded-[--radius-card] border border-line">
                          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
                            <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                              {page.path}
                            </code>
                            <Badge tone={STATUS_TONE[worst]}>{worst}</Badge>
                          </summary>
                          <div className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
                            {page.checks.map((check) => (
                              <CheckRow key={check.id} check={check} />
                            ))}
                          </div>
                        </details>
                      );
                    })}
                  </CardBody>
                </Card>
              </>
            ) : activeId ? (
              <EmptyState title="Loading the report…">Reading the stored run.</EmptyState>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function ScoreTile({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <Card>
      <CardBody>
        <p className="text-[11px] font-semibold tracking-wider text-ink-muted uppercase">{label}</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
          {value}
          <span className="text-base font-normal text-ink-muted">/100</span>
        </p>
      </CardBody>
    </Card>
  );
}

function CheckRow({ check }: { readonly check: SiteCheck }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-sm">
      <Badge tone={STATUS_TONE[check.status]}>{check.status}</Badge>
      <Badge tone={check.kind === "aeo" ? "accent" : "neutral"}>{check.kind}</Badge>
      <span className="font-medium text-ink">{check.label}</span>
      <span className="min-w-0 flex-1 text-ink-muted">{check.detail}</span>
    </div>
  );
}
