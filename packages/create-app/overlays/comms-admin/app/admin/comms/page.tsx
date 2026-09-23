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
 * Communications automation, from __SCOPE__/comms: edit the templates, watch the
 * delivery log, and drain the queue. Sends go out for real once a sender is
 * wired in src/server/comms-senders.ts; without one they log a clean "skipped".
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
                setRan(`Sent ${r.processed} due message${r.processed === 1 ? "" : "s"}.`);
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
                  {m.error ? <span className="text-xs text-danger">{m.error}</span> : null}
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
  template: { id: string; key: string; channel: string; subject: string | null; body: string };
  onSaved: () => void;
}) {
  const save = api.comms.upsertTemplate.useMutation();
  const [subject, setSubject] = useState(template.subject ?? "");
  const [body, setBody] = useState(template.body);
  const dirty = subject !== (template.subject ?? "") || body !== template.body;

  useEffect(() => {
    setSubject(template.subject ?? "");
    setBody(template.body);
  }, [template.subject, template.body]);

  return (
    <div className="rounded-control border border-line px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <code className="font-mono text-xs text-ink-muted">{template.key}</code>
        <Badge tone="neutral">{template.channel}</Badge>
      </div>
      {template.channel === "email" ? (
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="mb-2 w-full" />
      ) : null}
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className="w-full font-mono text-[13px]" />
      <p className="mt-1 text-xs text-ink-faint">Use {`{{name}}`}, {`{{date}}`}, {`{{time}}`}, {`{{address}}`} — they fill in per message.</p>
      <div className="mt-2">
        <Button
          variant="primary"
          disabled={!dirty || save.isPending}
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
