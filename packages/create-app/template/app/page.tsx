import Link from "next/link";
import type { ReactNode } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { HealthCheck } from "@/components/HealthCheck";
import { Card, CardBody, PageHeader } from "@/components/ui";

/**
 * Where the files are. Nothing more.
 *
 * A generated project's landing page has one job — get whoever just ran the
 * generator to the file they are about to edit. Marketing copy here is copy
 * that gets deleted in the first hour, and a hero image is a hero image nobody
 * asked for.
 */
const STARTING_POINTS: readonly { readonly path: string; readonly what: string }[] = [
  { path: "src/permissions/catalog.ts", what: "Permission keys" },
  { path: "src/db/schema.ts", what: "Your tables" },
  { path: "src/server/routers/_app.ts", what: "Your API" },
  { path: "src/trpc/client.tsx", what: "Calling it from a client component" },
  { path: "src/trpc/server.ts", what: "Calling it from a server component" },
  { path: "app/globals.css", what: "Colours, radius, dark mode" },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-6 flex items-center justify-between gap-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          __PROJECT_NAME__
        </p>
        <AuthHeader />
      </div>

      <PageHeader
        title="__PROJECT_NAME__"
        description="Auth, tenancy, permissions, tRPC and the environment contract are wired. Start building features."
      />

      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-muted">
            <HealthCheck />
          </p>
          <Link href="/setup" className="text-sm text-accent underline underline-offset-2">
            What is configured, and what is not
          </Link>
        </CardBody>
      </Card>

      <p className="mt-4 max-w-[62ch] text-sm text-ink-muted">
        Add credentials to <Code>.env.local</Code> whenever you want the feature
        they unlock. Nothing here blocks you from building.
      </p>

      <h2 className="mt-10 mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
        Where to start
      </h2>
      <Card>
        <ul>
          {STARTING_POINTS.map((entry) => (
            <li
              key={entry.path}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 last:border-0"
            >
              <span className="text-sm text-ink">{entry.what}</span>
              <Code>{entry.path}</Code>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[3px] bg-accent-soft px-1 py-px font-mono text-xs text-accent">
      {children}
    </code>
  );
}
