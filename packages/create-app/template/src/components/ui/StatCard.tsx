import Link from "next/link";

/**
 * One number that matters, with what it is and where it goes: "Money owed ·
 * $4,210 · 3 invoices". The dashboard's whole vocabulary. The value is
 * formatted by the server (money in the company's currency and locale); this
 * only lays it out.
 */
export function StatCard({
  label,
  value,
  detail,
  href,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly href?: string;
}) {
  const body = (
    <>
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-ink tabular-nums">{value}</p>
      {detail ? <p className="mt-1 text-sm text-ink-muted">{detail}</p> : null}
    </>
  );
  const shape = "block rounded-[--radius-card] border border-line bg-surface p-5 shadow-card";
  return href ? (
    <Link href={href} className={`${shape} no-underline transition-colors hover:border-line-strong`}>
      {body}
    </Link>
  ) : (
    <div className={shape}>{body}</div>
  );
}
