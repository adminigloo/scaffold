"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/trpc/client";
import { Button, Card, CardBody, EmptyState, Input, PageHeader } from "@/components/ui";

/**
 * The terms the assistant should use the way this business does. A term is
 * injected into a turn only when the question actually uses it (or one of its
 * aliases), so the glossary can grow without bloating every prompt.
 */
export default function AssistantGlossaryPage() {
  const terms = api.assistant.glossary.useQuery();
  const create = api.assistant.createGlossaryTerm.useMutation();
  const remove = api.assistant.deactivateGlossaryTerm.useMutation();

  const [termKey, setTermKey] = useState("");
  const [preferred, setPreferred] = useState("");
  const [aliases, setAliases] = useState("");
  const [definition, setDefinition] = useState("");

  const refresh = () => void terms.refetch();

  return (
    <>
      <PageHeader
        title="Assistant glossary"
        description="Preferred terms and their aliases. Each is injected only into questions that use it, so the list stays cheap as it grows."
        actions={
          <Link href="/admin/assistant" className="text-sm text-accent underline underline-offset-2">
            Back to personality
          </Link>
        }
      />

      {terms.isLoading ? (
        <EmptyState title="Loading glossary…">Reading the terms.</EmptyState>
      ) : (
        <Card>
          <CardBody className="flex flex-col gap-2">
            {(terms.data ?? []).length === 0 ? (
              <p className="text-sm text-ink-muted">No terms yet — add the words your product uses in its own way.</p>
            ) : null}
            {(terms.data ?? []).map((term) => (
              <div key={term.id} className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-2">
                <code className="font-mono text-xs text-ink-muted">{term.termKey}</code>
                <span className="text-sm font-medium text-ink">{term.preferred}</span>
                {Array.isArray(term.aliases) && term.aliases.length > 0 ? (
                  <span className="text-xs text-ink-faint">aka {term.aliases.join(", ")}</span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">{term.definition ?? ""}</span>
                <Button variant="danger" onClick={() => void remove.mutateAsync({ id: term.id }).then(refresh)}>
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
                    termKey: termKey.trim(),
                    preferred: preferred.trim(),
                    aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean),
                    definition: definition.trim() || null,
                  })
                  .then(() => {
                    setTermKey("");
                    setPreferred("");
                    setAliases("");
                    setDefinition("");
                    refresh();
                  })
                  .catch(() => undefined);
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Key
                <Input value={termKey} onChange={(event) => setTermKey(event.target.value)} placeholder="widget" className="w-28 font-mono" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Preferred
                <Input value={preferred} onChange={(event) => setPreferred(event.target.value)} placeholder="Widget" className="w-32" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Aliases (comma-sep)
                <Input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="gadget, doohickey" className="w-40" />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-ink-muted">
                Definition
                <Input value={definition} onChange={(event) => setDefinition(event.target.value)} placeholder="Our core product." className="w-full" />
              </label>
              <Button type="submit" variant="primary" disabled={!termKey.trim() || !preferred.trim() || create.isPending}>
                Add term
              </Button>
            </form>
          </CardBody>
        </Card>
      )}
    </>
  );
}
