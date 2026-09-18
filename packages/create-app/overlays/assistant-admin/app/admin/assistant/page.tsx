"use client";

import { useState } from "react";
import Link from "next/link";
import { estimateTokens } from "__SCOPE__/assistant";
import { api } from "@/trpc/client";
import { Badge, Button, Card, CardBody, EmptyState, Notice, PageHeader } from "@/components/ui";

/**
 * The assistant's personality, as an editable list.
 *
 * Each row is a section of the system prompt. Publishing an edit versions it;
 * the version history and a one-click rollback sit behind each row. Every rule
 * the server enforces — the token budget, the required identity phrases, and
 * the refusal to overwrite a change you didn't see (409) — surfaces here as a
 * message rather than a silent failure. Core sections (the guardrails) can be
 * edited but say so, and refuse to lose their identity phrases.
 */
export default function AssistantSectionsPage() {
  const sections = api.assistant.sections.useQuery();
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Assistant personality"
        description="Each section is part of the assistant's system prompt. Edits are versioned and reversible; the guardrails are seeded and marked core."
        actions={
          <div className="flex gap-3">
            <Link href="/admin/assistant/rules" className="text-sm text-accent underline underline-offset-2">
              Tenant rules
            </Link>
            <Link href="/admin/assistant/glossary" className="text-sm text-accent underline underline-offset-2">
              Glossary
            </Link>
            <Link href="/admin/assistant/changes" className="text-sm text-accent underline underline-offset-2">
              Change log
            </Link>
          </div>
        }
      />

      {notice ? (
        <div className="mb-4">
          <Notice tone="warn" role="status">{notice}</Notice>
        </div>
      ) : null}

      {sections.isLoading ? (
        <EmptyState title="Loading the personality…">Reading the assistant's sections.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {(sections.data ?? []).map((section) => (
            <SectionCard key={section.id} section={section} onNotice={setNotice} onSaved={() => void sections.refetch()} />
          ))}
        </div>
      )}
    </>
  );
}

type Section = {
  id: string;
  key: string;
  label: string;
  content: string;
  isCore: boolean;
  requiredPhrases: string[];
  maxTokens: number;
};

function SectionCard({
  section,
  onNotice,
  onSaved,
}: {
  readonly section: Section;
  readonly onNotice: (message: string | null) => void;
  readonly onSaved: () => void;
}) {
  const versions = api.assistant.versions.useQuery({ sectionId: section.id });
  const publish = api.assistant.publishSection.useMutation();
  const rollback = api.assistant.rollbackSection.useMutation();
  const [content, setContent] = useState(section.content);
  const [open, setOpen] = useState(false);

  const headVersion = versions.data?.[0]?.versionNumber ?? 0;
  const tokens = estimateTokens(content);
  const overBudget = tokens > Math.floor(section.maxTokens * 0.9);
  const dirty = content !== section.content;

  const save = async () => {
    onNotice(null);
    const result = await publish.mutateAsync({
      sectionId: section.id,
      baseVersion: headVersion,
      content,
      changeSummary: "edited from the admin",
    });
    if (result.published) {
      onSaved();
      void versions.refetch();
      return;
    }
    // Every refusal is a specific, fixable message — never a silent no-op.
    onNotice(
      result.reason === "conflict"
        ? `"${section.label}" changed since you opened it (now v${result.headVersion}) — reload before saving so you don't overwrite that edit.`
        : result.reason === "budget"
          ? `"${section.label}" is over its ${result.maxTokens}-token budget — trim it and try again.`
          : result.reason === "missing_phrase"
            ? `"${section.label}" must keep the phrase "${result.phrase}" — it's what stops the assistant losing its identity.`
            : "That section no longer exists; refreshing.",
    );
    if (result.reason === "unknown") onSaved();
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-xs text-ink-muted">{section.key}</code>
          <span className="text-sm font-semibold text-ink">{section.label}</span>
          {section.isCore ? <Badge tone="accent">core guardrail</Badge> : null}
          <span
            className={`ml-auto font-mono text-xs tabular-nums ${overBudget ? "text-danger" : "text-ink-faint"}`}
            title="Estimated tokens vs the section's budget"
          >
            {tokens}/{section.maxTokens}
          </span>
        </div>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={Math.min(10, Math.max(3, content.split("\n").length))}
          className="w-full rounded-control border border-line bg-canvas px-3 py-2 font-mono text-[13px] text-ink"
        />
        {section.isCore && section.requiredPhrases.length > 0 ? (
          <p className="text-xs text-ink-faint">
            Must contain: {section.requiredPhrases.map((p) => `“${p}”`).join(", ")}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={!dirty || overBudget || publish.isPending} onClick={() => void save()}>
            {publish.isPending ? "Publishing…" : "Publish"}
          </Button>
          {dirty ? (
            <Button onClick={() => setContent(section.content)}>Discard</Button>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto text-xs text-accent underline underline-offset-2"
          >
            {open ? "Hide history" : `History (v${headVersion})`}
          </button>
        </div>
        {open ? (
          <ul className="mt-1 divide-y divide-line border-t border-line">
            {(versions.data ?? []).map((v) => (
              <li key={v.versionNumber} className="flex items-center gap-2 py-2 text-xs">
                <span className="font-mono tabular-nums text-ink-muted">v{v.versionNumber}</span>
                <span className="text-ink-muted">{v.changeSummary ?? "—"}</span>
                <span className="ml-auto text-ink-faint">{new Date(v.createdAt).toLocaleString()}</span>
                {v.versionNumber !== headVersion ? (
                  <Button
                    disabled={rollback.isPending}
                    onClick={() =>
                      void rollback
                        .mutateAsync({ sectionId: section.id, toVersion: v.versionNumber })
                        .then((r) => {
                          if (r.published) {
                            onSaved();
                            void versions.refetch();
                          }
                        })
                    }
                  >
                    Roll back
                  </Button>
                ) : (
                  <Badge tone="neutral">current</Badge>
                )}
              </li>
            ))}
            {versions.data?.length === 0 ? (
              <li className="py-2 text-xs text-ink-faint">No published versions yet — the seeded text is the starting point.</li>
            ) : null}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
