import type { PlanFeature, PlanFeatureHeading } from "__SCOPE__/billing";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { featureCell } from "@/components/marketing/pricing/planPresentation";

/**
 * Every feature, side by side: the one place a plan's NOT having something is
 * said ("—"), because here the columns are being weighed against each other.
 * The cards above never say it.
 *
 * Columns are the line's free tier (when the record declares one) and each
 * tier shown on the page, in the record's order.
 */
export function ComparisonTable({
  features,
  columns,
}: {
  /** The line's vocabulary: the rows. */
  readonly features: readonly PlanFeatureHeading[];
  readonly columns: readonly { readonly key: string; readonly name: string; readonly features: Readonly<Record<string, PlanFeature>> }[];
}) {
  if (features.length === 0 || columns.length === 0) return null;

  return (
    <Table>
      <THead>
        <TR>
          <TH className="w-[40%] min-w-[10rem]">Feature</TH>
          {columns.map((column) => (
            <TH key={column.key} className="min-w-[6.5rem]">
              {column.name}
            </TH>
          ))}
        </TR>
      </THead>
      <TBody>
        {features.map((heading) => (
          <TR key={heading.feature}>
            <TD className="text-sm text-ink">{heading.label.charAt(0).toUpperCase() + heading.label.slice(1)}</TD>
            {columns.map((column) => (
              <TD key={column.key} className="text-sm tabular-nums">
                <Cell value={column.features[heading.feature]} where={`${column.key}/${heading.feature}`} />
              </TD>
            ))}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function Cell({ value, where }: { readonly value: PlanFeature | undefined; readonly where: string }) {
  // Unreachable: `definePlans` gives every tier (and the free tier) a value for
  // every feature of its line. If the impossible happens, say which.
  if (value === undefined) {
    return <span className="text-danger">missing: {where}</span>;
  }

  const cell = featureCell(value);

  if (!cell.included) {
    return (
      <>
        <span aria-hidden="true" className="text-ink-muted">
          &mdash;
        </span>
        <span className="sr-only">{cell.text}</span>
      </>
    );
  }

  return <span className="text-ink">{cell.text}</span>;
}
