"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/trpc/client";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

const STATUSES = ["draft", "sent", "viewed", "approved", "rejected", "expired", "converted"] as const;

function statusTone(status: string): BadgeTone {
  if (status === "approved" || status === "converted") return "accent";
  if (status === "rejected" || status === "expired") return "danger";
  return "neutral";
}

/**
 * The estimates queue — quotes built by the public tool and by staff, from
 * __SCOPE__/estimator. Click one to read its lines and move it along its
 * lifecycle. Read-through the tRPC caller so the staff permission rung is where
 * the scope audit can see it, exactly like the feedback and catalog queues.
 */
export default function EstimatesPage() {
  const estimates = api.estimator.estimates.useQuery({ limit: 100 });
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = api.estimator.estimate.useQuery({ id: openId ?? "" }, { enabled: openId !== null });
  const setStatus = api.estimator.setEstimateStatus.useMutation();
  // Turning an approved estimate into an invoice is a cross-feature action, so
  // it lives with the project, not this overlay. Generate with `--invoicing`,
  // add `createFromEstimate` to the invoicing router (reading `getEstimate`),
  // and call `api.invoicing.createFromEstimate` from a button here.

  return (
    <>
      <PageHeader
        title="Estimates"
        description="Quotes from the public instant-estimate tool and from staff. The customer, the measurements, and the priced lines all arrive here."
        actions={
          <Link href="/estimate" target="_blank" className="text-sm text-accent underline underline-offset-2">
            Open the public tool ↗
          </Link>
        }
      />

      {estimates.isLoading ? (
        <EmptyState title="Loading estimates…">Reading the queue.</EmptyState>
      ) : (estimates.data ?? []).length === 0 ? (
        <EmptyState title="No estimates yet">
          They appear the moment someone saves one from the{" "}
          <Link href="/estimate" className="text-accent underline underline-offset-2">
            instant-estimate tool
          </Link>
          .
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <Table>
              <THead>
                <TR>
                  <TH className="w-28">Number</TH>
                  <TH className="w-36">When</TH>
                  <TH>Customer</TH>
                  <TH className="w-24">Source</TH>
                  <TH className="w-24">Total</TH>
                  <TH className="w-24">Status</TH>
                </TR>
              </THead>
              <TBody>
                {(estimates.data ?? []).map((e) => (
                  <TR key={e.id}>
                    <TD className="align-top">
                      <button
                        type="button"
                        onClick={() => setOpenId(openId === e.id ? null : e.id)}
                        className="font-mono text-xs text-accent underline underline-offset-2"
                      >
                        {e.estimateNumber}
                      </button>
                    </TD>
                    <TD className="whitespace-nowrap align-top font-mono text-xs text-ink-muted">
                      {new Date(e.createdAt).toISOString().replace("T", " ").slice(0, 16)}
                    </TD>
                    <TD className="align-top text-sm">
                      <span className="text-ink">{e.customerName ?? "—"}</span>
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        {e.customerEmail ?? e.customerPhone ?? e.jobAddress ?? ""}
                      </span>
                    </TD>
                    <TD className="align-top text-xs text-ink-muted">{e.source}</TD>
                    <TD className="align-top font-mono text-sm tabular-nums">{usd(e.total)}</TD>
                    <TD className="align-top">
                      <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>

          {openId && detail.data ? (
            <Card>
              <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-sm text-ink">{detail.data.estimate.estimateNumber}</span>
                  <Badge tone={statusTone(detail.data.estimate.status)}>{detail.data.estimate.status}</Badge>
                  <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
                    Status
                    <select
                      value={detail.data.estimate.status}
                      onChange={(event) =>
                        void setStatus
                          .mutateAsync({ id: detail.data!.estimate.id, status: event.target.value as (typeof STATUSES)[number] })
                          .then(() => {
                            void estimates.refetch();
                            void detail.refetch();
                          })
                      }
                      className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                  <p><span className="text-ink-faint">Customer:</span> {detail.data.estimate.customerName ?? "—"}</p>
                  <p><span className="text-ink-faint">Email:</span> {detail.data.estimate.customerEmail ?? "—"}</p>
                  <p><span className="text-ink-faint">Phone:</span> {detail.data.estimate.customerPhone ?? "—"}</p>
                  <p><span className="text-ink-faint">Address:</span> {detail.data.estimate.jobAddress ?? "—"}</p>
                </div>

                {detail.data.estimate.photoUrl ? (
                  <a href={detail.data.estimate.photoUrl} target="_blank" rel="noreferrer" className="block w-fit">
                    {/* eslint-disable-next-line @next/next/no-img-element -- blob URL, no loader */}
                    <img
                      src={detail.data.estimate.photoUrl}
                      alt="Job photo"
                      loading="lazy"
                      className="max-h-64 rounded-[--radius-card] border border-line"
                    />
                  </a>
                ) : null}

                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Line</TH>
                        <TH className="w-24">Measure</TH>
                        <TH className="w-16">Qty</TH>
                        <TH className="w-24">Unit</TH>
                        <TH className="w-24">Total</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {detail.data.items.map((item) => (
                        <TR key={item.id}>
                          <TD className="align-top text-sm text-ink">{item.description}</TD>
                          <TD className="align-top text-xs text-ink-muted">{formatMeasure(item.measurement)}</TD>
                          <TD className="align-top text-sm tabular-nums">{item.quantity}</TD>
                          <TD className="align-top font-mono text-sm tabular-nums">{usd(item.unitPrice)}</TD>
                          <TD className="align-top font-mono text-sm tabular-nums">{usd(item.total)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>

                <div className="ml-auto text-right text-sm">
                  <p><span className="text-ink-faint">Subtotal:</span> <span className="font-mono tabular-nums">{usd(detail.data.estimate.subtotal)}</span></p>
                  <p><span className="text-ink-faint">Tax:</span> <span className="font-mono tabular-nums">{usd(detail.data.estimate.taxAmount)}</span></p>
                  <p className="text-base font-semibold"><span className="text-ink-faint">Total:</span> <span className="font-mono tabular-nums">{usd(detail.data.estimate.total)}</span></p>
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}

function formatMeasure(m: unknown): string {
  if (!m || typeof m !== "object") return "—";
  const v = m as { widthIn?: number; heightIn?: number; linearFt?: number; units?: number };
  if (v.linearFt) return `${v.linearFt} ft`;
  if (v.widthIn && v.heightIn) return `${v.widthIn}×${v.heightIn} in`;
  if (v.units) return `${v.units} unit${v.units === 1 ? "" : "s"}`;
  return "—";
}
