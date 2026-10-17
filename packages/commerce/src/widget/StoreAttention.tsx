import { useCallback, useEffect, useState } from "react";
import type { StoreAlertWire, StoreAlertsResponse } from "../store-wire.js";
import { ErrorNote, request, StoreStyles } from "./parts.js";

/**
 * NEEDS YOUR ATTENTION, FOR THE STORE (commerce 0.2): every store payment the
 * owner has to look at — money Stripe took that couldn't become an order as
 * it was, a refund, a dispute, a bank payment that failed, something sold
 * after it ran out — each in plain words, with a link to it in Stripe and
 * "Mark as handled". Over `{baseUrl}/v1/admin/attention`.
 */
export function StoreAttention(props: { readonly baseUrl: string; readonly canManage?: boolean; readonly heading?: string }) {
  const [items, setItems] = useState<StoreAlertsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems(await request<StoreAlertsResponse>(`${props.baseUrl}/v1/admin/attention`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [props.baseUrl]);
  useEffect(() => void load(), [load]);
  const handled = async (item: StoreAlertWire) => {
    setBusy(item.id);
    try {
      await request(`${props.baseUrl}/v1/admin/attention/${encodeURIComponent(item.id)}/resolve`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };
  return (
    <section className="aics aics-stack" data-store-attention="">
      <StoreStyles />
      {props.heading ? (
        <h2 className="aics-h2">
          {props.heading}
          {items && items.open.length > 0 ? ` (${items.open.length})` : ""}
        </h2>
      ) : null}
      <ErrorNote message={error} />
      {!items ? (
        <p className="aics-muted">Loading…</p>
      ) : items.open.length === 0 ? (
        <p className="aics-muted">Nothing needs your attention. Store payments that couldn&rsquo;t become an order, refunds and disputes show here.</p>
      ) : (
        <ul className="aics-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {items.open.map((item) => (
            <li key={item.id} className="aics-note" data-attention-item={item.kind}>
              <p style={{ margin: 0 }}>{item.message}</p>
              <p className="aics-row" style={{ margin: ".5rem 0 0" }}>
                <span className="aics-muted">{new Date(item.createdAt).toLocaleString()}</span>
                {item.stripeUrl ? (
                  <a href={item.stripeUrl} target="_blank" rel="noreferrer">
                    Open it in Stripe
                  </a>
                ) : null}
                {props.canManage !== false ? (
                  <button type="button" className="aics-btn aics-btn-quiet" disabled={busy === item.id} onClick={() => void handled(item)}>
                    Mark as handled
                  </button>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
