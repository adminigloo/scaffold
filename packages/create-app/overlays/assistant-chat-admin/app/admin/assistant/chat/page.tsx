"use client";

import Link from "next/link";
import { AssistantChat } from "__SCOPE__/assistant-widget";
import { PageHeader } from "@/components/ui";

/**
 * Talking to THIS SITE'S OWN assistant (Tenancy 2b-3): __SCOPE__/assistant-widget's
 * chat over /api/admin/assistant — streamed answers, Stop, history, and a
 * "Yes, do it" card for any change it offers. It answers in the personality
 * edited at /admin/assistant, and each question counts against the site's AI
 * allowance (src/server/assistant.ts).
 */
export default function AssistantChatPage() {
  return (
    <>
      <PageHeader
        title="Assistant chat"
        description="Ask this site's assistant. It looks things up through its tools, and asks before it changes anything."
        actions={
          <Link href="/admin/assistant" className="text-sm text-accent underline underline-offset-2">
            Personality
          </Link>
        }
      />
      <div className="h-[70vh] min-h-[420px] overflow-hidden rounded-[6px] border border-line bg-surface">
        <AssistantChat config={{ baseUrl: "/api/admin/assistant", title: "Assistant" }} />
      </div>
    </>
  );
}
