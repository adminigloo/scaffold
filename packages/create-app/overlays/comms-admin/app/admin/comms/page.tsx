"use client";

import { useEffect, useState } from "react";
import { api } from "@/trpc/client";
import { Badge, Button, Card, CardBody, EmptyState, Input, PageHeader, Textarea } from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";

function statusTone(status: string): BadgeTone {
  if (status === "sent") return "accent";
  if (status === "failed") return "danger";
  return "neutral";
}

/**
 * Communications automation, from __SCOPE__/comms: edit the templates, switch
 * one off, watch the delivery log, and drain the queue. Sends go out for real
 * once a sender is wired in src/server/comms-senders.ts; without one they log a
 * clean "skipped".
 */
export default function CommsPage() {
  const templates = api.comms.templates.useQuery();
  const messages = api.comms.messages.useQuery();
  const runDue = api.comms.runDue.useMutation();
  const [ran, setRan] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Communications"
        description="Templates, the delivery log, and the scheduled queue. Queue a message from your own code; a cron (or the button here) sends what's due."
        actions={
          <Button
            variant="primary"
            disabled={runDue.isPending}
            onClick={() =>
              void runDue.mutateAsync().then((r) => {
                // Every outcome, not just a count: "Sent 3" when two of the
                // three failed is how a broken provider goes unnoticed.
                const parts = [`Sent ${r.sent}`];
                if (r.skipped) parts.push(`skipped ${r.skipped}`);
                if (r.failed) parts.push(`failed ${r.failed}`);
                if (r.retrying) parts.push(`${r.retrying} will retry`);
                if (r.cancelled) parts.push(`cancelled ${r.cancelled}`);
                if (r.expired) parts.push(`expired ${r.expired}`);
                setRan(`${parts.join(" · ")}.${r.stoppedEarly ? " More are due — run again." : ""}`);
                void messages.refetch();
              })
            }
          >
            {runDue.isPending ? "Sending…" : "Send due now"}
          </Button>
        }
      />

      {ran ? <p className="mb-4 text-sm text-accent">{ran}</p> : null}

      <div className="flex flex-col gap-6">
        <Card>
          <CardBody className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-ink">Templates</h2>
            {templates.isLoading ? (
              <p className="text-sm text-ink-muted">Loading templates…</p>
            ) : (
              (templates.data ?? []).map((t) => (
                <TemplateEditor key={t.id} template={t} onSaved={() => void templates.refetch()} />
              ))
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-ink">Delivery log</h2>
            {(messages.data ?? []).length === 0 ? (
              <EmptyState title="Nothing sent yet">Messages appear here as they go out.</EmptyState>
            ) : (
              (messages.data ?? []).map((m) => (
                <div key={m.id} className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-1.5 text-sm">
                  <span className="font-mono text-xs text-ink-faint">
                    {new Date(m.createdAt).toISOString().replace("T", " ").slice(0, 16)}
                  </span>
                  <span className="text-ink">{m.toAddress}</span>
                  <span className="text-xs text-ink-faint">{m.templateKey ?? m.channel}</span>
                  <Badge tone={statusTone(m.status)}>{m.status}</Badge>
                  {/* A skip or cancel carries its reason here too — only a failure is an error. */}
                  {m.error ? (
                    <span className={m.status === "failed" ? "text-xs text-danger" : "text-xs text-ink-muted"}>{m.error}</span>
                  ) : null}
                  {m.missingVars && m.missingVars.length > 0 ? (
                    <span className="text-xs text-ink-muted">blank: {m.missingVars.join(", ")}</span>
                  ) : null}
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function TemplateEditor({
  template,
  onSaved,
}: {
  template: { id: string; key: string; channel: string; subject: string | null; body: string; isActive: boolean };
  onSaved: () => void;
}) {
  const save = api.comms.upsertTemplate.useMutation();
  const toggle = api.comms.setTemplateActive.useMutation();
  const [subject, setSubject] = useState(template.subject ?? "");
  const [body, setBody] = useState(template.body);
  const dirty = subject !== (template.subject ?? "") || body !== template.body;
  // Mirrors the server rule so the editor explains it instead of failing a save.
  const needsSubject = template.channel === "email" && subject.trim() === "";

  useEffect(() => {
    setSubject(template.subject ?? "");
    setBody(template.body);
  }, [template.subject, template.body]);

  return (
    <div className="rounded-control border border-line px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <code className="font-mono text-xs text-ink-muted">{template.key}</code>
        <Badge tone="neutral">{template.channel}</Badge>
        {template.isActive ? null : <Badge tone="warn">off — nothing sends</Badge>}
        <Button
          className="ml-auto"
          disabled={toggle.isPending}
          onClick={() => void toggle.mutateAsync({ key: template.key, active: !template.isActive }).then(onSaved)}
        >
          {template.isActive ? "Switch off" : "Switch on"}
        </Button>
      </div>
      {template.channel === "email" ? (
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="mb-2 w-full" />
      ) : null}
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className="w-full font-mono text-[13px]" />
      <p className="mt-1 text-xs text-ink-faint">
        Use {`{{name}}`}, {`{{date}}`}, {`{{time}}`}, {`{{address}}`} — they fill in per message.
        {template.channel === "sms"
          ? " Every text goes out with your business name in front, and “Reply STOP to opt out.” unless it already says how to opt out."
          : ""}
      </p>
      {needsSubject ? <p className="mt-1 text-xs text-danger">An email needs a subject.</p> : null}
      <div className="mt-2">
        <Button
          variant="primary"
          disabled={!dirty || needsSubject || save.isPending}
          onClick={() =>
            void save
              .mutateAsync({ key: template.key, channel: template.channel as "email" | "sms", subject: subject || null, body })
              .then(onSaved)
          }
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
