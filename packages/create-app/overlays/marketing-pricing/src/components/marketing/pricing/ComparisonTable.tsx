import type { PlanCatalog, PlanTier } from "__SCOPE__/billing";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { featureCell } from "@/components/marketing/pricing/planPresentation";

/**
 * Every feature the catalog declares, against every tier still sold.
 *
 * THIS TABLE IS WHY THE RECORD HAS TWO LEVELS. The vocabulary is declared once
 * and each tier supplies only values, so `definePlans` makes a feature added to
 * Pro and forgotten on Starter a compile error — which means this table cannot
 * have a hole in it. Under the flat shape a pricing page normally has, the hole
 * is silent in both directions at once: the cell renders empty and
 * `checkEntitlement` answers "your plan does not include seats at all" for a
 * tier where somebody merely missed a line.
 *
 * ROWS ARE `catalog.features`, IN DECLARATION ORDER. Not the keys of the first
 * tier, which would be the same list right up until it was not, and not sorted,
 * because the order features are declared in is the order they were thought
 * about in and it is the only ordering anybody maintains.
 *
 * A WITHHELD FEATURE STILL GETS A CELL. It renders as a dash rather than as
 * nothing, because a blank cell in a comparison table is indistinguishable from
 * a row that failed to render — and the reader's guess about which is never the
 * charitable one. The dash is `aria-hidden` with the real answer beside it for a
 * screen reader, since "—" read aloud is silence.
 */
export function ComparisonTable({
  catalog,
  tiers,
}: {
  readonly catalog: PlanCatalog;
  readonly tiers: readonly PlanTier[];
}) {
  if (catalog.features.length === 0) return null;

  return (
    <Table>
      <THead>
        <TR>
          <TH className="w-[40%] min-w-[10rem]">Feature</TH>
          {tiers.map((tier) => (
            <TH key={tier.key} className="min-w-[6.5rem]">
              {tier.name}
            </TH>
          ))}
        </TR>
      </THead>
      <TBody>
        {catalog.features.map((heading) => (
          <TR key={heading.feature}>
            <TD className="text-sm text-ink">{heading.label}</TD>
            {tiers.map((tier) => (
              <TD key={tier.key} className="text-sm tabular-nums">
                <Cell tier={tier} feature={heading.feature} />
              </TD>
            ))}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function Cell({
  tier,
  feature,
}: {
  readonly tier: PlanTier;
  readonly feature: string;
}) {
  const value = tier.features[feature];

  // Unreachable: `definePlans` gives every tier a value for every declared
  // feature, and that is the invariant the whole two-level shape exists to
  // enforce. The guard is for `noUncheckedIndexedAccess`, and it says which
  // tier and which feature rather than rendering an empty cell, because if the
  // impossible does happen the useful output is the pair of names.
  if (value === undefined) {
    return (
      <span className="text-danger">
        missing: {tier.key}/{feature}
      </span>
    );
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
