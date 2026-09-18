"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/trpc/client";
import { Badge, Button, Card, CardBody, EmptyState, Input, PageHeader } from "@/components/ui";

/**
 * Per-tenant personality overlays — the layer that lets one customer bend the
 * assistant without forking the shared personality. A rule tied to a section
 * key appends to that global section for this tenant; an untied rule is a
 * standalone instruction. This deployment is a single tenant, so the page
 * edits that tenant's rules directly.
 */
// The tenant whose overlays this page edits. A generated project is
// often multi-tenant — wire this to the signed-in workspace instead of a
// constant once you have more than one. "default" is a safe starting id.
const TENANT_ID = "default";

export default function AssistantTenantRulesPage() {
  const rules = api.assistant.tenantRules.useQuery({ tenantId: TENANT_ID });
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
        title="Tenant rules"
        description="Overlays for this workspace. Tie a rule to a personality section to extend it, or leave it standalone for a one-off instruction."
        actions={
          <Link href="/admin/assistant" className="text-sm text-accent underline underline-offset-2">
            Back to personality
          </Link>
        }
      />

      {rules.isLoading ? (
        <EmptyState title="Loading rules…">Reading this workspace's overlays.</EmptyState>
      ) : (
        <Card>
          <CardBody className="flex flex-col gap-2">
            {(rules.data ?? []).filter((r) => r.isActive).length === 0 ? (
              <p className="text-sm text-ink-muted">No overlays yet — the assistant runs on the shared personality alone.</p>
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
                    tenantId: TENANT_ID,
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
