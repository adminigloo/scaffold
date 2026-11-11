import { formatMinor } from "__SCOPE__/catalog";
import { Badge } from "@/components/ui";

/**
 * Bits the two order pages share (create-app 0.44). Here rather than exported
 * from a page: a Next page module may export only what Next reads from it.
 */

/** An order's state as one badge: refunded, part refunded, paid, or what the status says. */
export function StatusBadge({ status, refunded }: { readonly status: string; readonly refunded: boolean }) {
  if (status === "refunded") return <Badge tone="warn">refunded</Badge>;
  if (refunded) return <Badge tone="warn">part refunded</Badge>;
  if (status === "paid" || status === "fulfilled") return <Badge tone="ok">{status}</Badge>;
  return <Badge>{status}</Badge>;
}

/** `formatMinor` throws on a currency code Intl doesn't know; the raw number is better than a broken page. */
export function money(minor: bigint, currency: string): string {
  try {
    return formatMinor(minor, currency);
  } catch {
    return `${minor.toString()} ${currency.toUpperCase()}`;
  }
}
