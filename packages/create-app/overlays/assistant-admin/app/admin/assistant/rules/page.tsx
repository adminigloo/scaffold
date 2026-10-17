"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/trpc/client";
import { Badge, Button, Card, CardBody, EmptyState, Input, PageHeader } from "@/components/ui";

/**
 * House rules for THIS SITE'S OWN assistant — the layer that bends it without
 * forking its personality. A rule tied to a section key extends that section;
 * an untied rule is a standalone instruction. In a companies project each
 * company writes its own assistant's rules at /app/assistant; this page is
 * the site's, for its staff.
 */
export default function AssistantTenantRulesPage() {
  const rules = api.assistant.tenantRules.useQuery();
  const sections = api.assistant.sections.useQuery();
  const create = api.assistant.createTenantRule.useMutation();
  const remove = api.assistant.deactivateTenantRule.useMutation();

  const [sectionKey, setSectionKey] = useState("");
  const [label, setLabel] = useState("");
  const [instruction, setInstruction] = useState("");

  const refresh = () => void rules.refetch();

  return (
    <>
      <PageHeader
        title="House rules"
        description="What this site's own assistant must always or never do. Tie a rule to a personality section to extend it, or leave it standalone."
        actions={
          <Link href="/admin/assistant" className="text-sm text-accent underline underline-offset-2">
            Back to personality
          </Link>
        }
      />

      {rules.isLoading ? (
        <EmptyState title="Loading rules…">Reading the house rules.</EmptyState>
      ) : (
        <Card>
          <CardBody className="flex flex-col gap-2">
            {(rules.data ?? []).filter((r) => r.isActive).length === 0 ? (
              <p className="text-sm text-ink-muted">No house rules yet — the assistant runs on its personality alone.</p>
            ) : null}
            {(rules.data ?? [])
              .filter((r) => r.isActive)
              .map((rule) => (
                <div key={rule.id} className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-2">
                  {rule.sectionKey ? (
                    <Badge tone="accent">{rule.sectionKey}</Badge>
                  ) : (
                    <Badge tone="neutral">standalone</Badge>
                  )}
                  <span className="text-sm font-medium text-ink">{rule.label}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">{rule.instruction}</span>
                  <Button variant="danger" onClick={() => void remove.mutateAsync({ id: rule.id }).then(refresh)}>
                    Remove
                  </Button>
                </div>
              ))}

            <form
              className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void create
                  .mutateAsync({
                    sectionKey: sectionKey || null,
                    label: label.trim(),
                    instruction: instruction.trim(),
                  })
                  .then(() => {
                    setSectionKey("");
                    setLabel("");
                    setInstruction("");
                    refresh();
                  });
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Section (optional)
                <select
                  value={sectionKey}
                  onChange={(event) => setSectionKey(event.target.value)}
                  className="w-40 rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
                >
                  <option value="">— standalone —</option>
                  {(sections.data ?? []).map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Label
                <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Refund tone" className="w-40" />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-ink-muted">
                Instruction
                <Input
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Always mention our 30-day guarantee."
                  className="w-full"
                />
              </label>
              <Button type="submit" variant="primary" disabled={!label.trim() || !instruction.trim() || create.isPending}>
                Add rule
              </Button>
            </form>
          </CardBody>
        </Card>
      )}
    </>
  );
}
