import { EmptyState, PageHeader } from "@/components/ui";

/**
 * A placeholder that says it is one.
 *
 * The scaffold deliberately ships no ticket schema. Every business already has
 * a shape for this — a queue in Zendesk, a shared inbox, a table with three
 * columns — and a generated model they have to fight is worse than an empty
 * page that tells them where to start.
 */
export default function SupportPage() {
  return (
    <>
      <PageHeader
        title="Support"
        description="Copied source. Model the queue on whatever this business already uses rather than forcing them onto a shape the scaffold picked."
      />
      <EmptyState title="No ticket model yet">
        Add a table in <code className="font-mono">src/db/schema.ts</code>, a
        router under <code className="font-mono">src/server/routers/</code> with
        each procedure gated by{" "}
        <code className="font-mono">requireStaff(&quot;staff.support.…&quot;)</code>
        , and a permission key in{" "}
        <code className="font-mono">src/permissions/catalog.ts</code> so this
        section can appear in the sidebar.
      </EmptyState>
    </>
  );
}
