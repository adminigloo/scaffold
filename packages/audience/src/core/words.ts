import { DEFAULT_REASON_LABELS, REASON_ORDER } from "./labels.js";

/**
 * The "Excluded: N (…)" words, as plain functions with no React and no Node
 * import — so a server component, the weekly digest and the AI report build
 * the same sentence the `ExcludedNote` component draws. (A function exported
 * from the "use client" `./ui` entry is not callable from server code.)
 */

export interface ExcludedCounts {
  total: number;
  byReason: Partial<Record<string, number>>;
  unit?: string;
}

const number = (value: number) => value.toLocaleString("en-US");

/** The ordered "label count" parts of a breakdown, reasons with the same word summed. */
export function excludedParts(excluded: ExcludedCounts, labels: Partial<Record<string, string>> = {}): Array<{ label: string; count: number }> {
  const order = [...REASON_ORDER, ...Object.keys(excluded.byReason).filter((key) => !(REASON_ORDER as readonly string[]).includes(key))];
  const parts: Array<{ label: string; count: number }> = [];
  for (const reason of order) {
    const count = excluded.byReason[reason] ?? 0;
    if (!count) continue;
    const label = labels[reason] ?? DEFAULT_REASON_LABELS[reason as keyof typeof DEFAULT_REASON_LABELS] ?? reason;
    const existing = parts.find((part) => part.label === label);
    if (existing) existing.count += count;
    else parts.push({ label, count });
  }
  return parts;
}

/** "1 session", "2 sessions" — the unit is given in the plural. */
function unitFor(total: number, unit: string): string {
  return total === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit;
}

/** "Excluded: 312 sessions (staff 200, named person 100, automation 12)" — every card, the digest, the AI report. */
export function excludedSentence(excluded: ExcludedCounts, options: { unit?: string; labels?: Partial<Record<string, string>>; includeInternal?: boolean } = {}): string {
  const unit = options.unit ?? excluded.unit ?? "sessions";
  const parts = excludedParts(excluded, options.labels);
  const detail = parts.length ? ` (${parts.map((part) => `${part.label} ${number(part.count)}`).join(", ")})` : "";
  if (options.includeInternal) {
    return excluded.total > 0
      ? `Including ${number(excluded.total)} internal ${unitFor(excluded.total, unit)}${detail}`
      : `Including internal ${unit}: none`;
  }
  return excluded.total > 0 ? `Excluded: ${number(excluded.total)} ${unitFor(excluded.total, unit)}${detail}` : "Excluded: none";
}

