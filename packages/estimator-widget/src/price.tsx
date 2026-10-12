import { formatMoney, formatRange } from "./format.js";
import type { PublicPrice } from "./types.js";

/**
 * The customer's price card (contract 9.3, step 6): the amount, the tax note,
 * the result in a sentence, how it was worked out, what was assumed, and why
 * it is a range. Every sentence is the SERVER's, shown verbatim: the widget
 * doesn't know a step from a square foot, and never re-derives a number. The
 * price book's preview renders this same card, so the owner sees exactly what
 * the customer will.
 */

export type PriceState =
  | { status: "idle" }
  | { status: "needs_inputs" }
  | { status: "quote_only" }
  | { status: "priced"; price: PublicPrice }
  | { status: "error"; message: string };

/** The amount as the customer reads it: whole currency units; one number when single, else "low – high". */
export function priceText(price: PublicPrice, locale: string): string {
  return price.single
    ? formatMoney(price.low, price.currency, locale, { whole: true })
    : formatRange(price.low, price.high, price.currency, locale);
}

export function PriceCard({
  state,
  previous,
  loading,
  locale,
  label = "Your estimate",
  confirmNote = "We'll confirm the final price once we've seen the job.",
}: {
  state: PriceState;
  /** The last price shown: kept on screen, dimmed, while a new one loads or after an error. */
  previous?: PublicPrice | null;
  loading?: boolean;
  locale: string;
  label?: string;
  confirmNote?: string | null;
}) {
  const shown = state.status === "priced" ? state.price : state.status === "error" || loading ? (previous ?? null) : null;
  return (
    <section className="aiew-price" aria-live="polite" aria-busy={loading ? true : undefined} data-aiew-price={state.status}>
      <p className="aiew-price-label">{label}</p>
      {shown ? (
        <div className="aiew-price-main aiew-stack-sm">
          <p className="aiew-amount" data-aiew-amount="">
            {priceText(shown, locale)}
          </p>
          {shown.taxNote ? <p className="aiew-tax">{shown.taxNote}</p> : null}
          {shown.resultPhrase ? <p className="aiew-result">{shown.resultPhrase}</p> : null}
          {shown.explanation.length > 0 ? (
            <ol className="aiew-explain" aria-label="How we worked it out" data-aiew-explain="">
              {shown.explanation.map((line, i) => (
                <li key={`${i}:${line}`}>{line}</li>
              ))}
            </ol>
          ) : null}
          {shown.assumption ? (
            <p className="aiew-note" data-aiew-assumption="">
              {shown.assumption}
            </p>
          ) : null}
          {!shown.single && shown.reasons.length > 0 ? (
            <p className="aiew-why" data-aiew-why="">
              <strong>Why a range?</strong> {shown.reasons.join("; ")}
            </p>
          ) : null}
          {confirmNote ? <p className="aiew-confirm-note">{confirmNote}</p> : null}
        </div>
      ) : state.status === "quote_only" ? (
        <p className="aiew-desc">This one needs a quick look to price. Leave your details and we&apos;ll be in touch.</p>
      ) : state.status !== "error" ? (
        <p className="aiew-desc" data-aiew-needs="">
          {loading ? "Working out your price…" : "Answer the questions above to see your price."}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="aiew-field-error" role="alert">
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
