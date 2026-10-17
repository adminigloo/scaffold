import { useCallback, useEffect, useMemo, useState } from "react";
import type { StoreCheckoutResponse, StoreCheckoutStatusResponse, StorePublicProductWire, StorePublicResponse } from "../store-wire.js";
import { clearCart, emptyCart, loadCart, saveCart, withQuantity, type Cart } from "./cart.js";
import { formatMoney } from "./money.js";
import { ErrorNote, request, StoreStyles } from "./parts.js";

/**
 * A BUSINESS'S STORE PAGE (commerce 0.2): its products with photo, price and
 * "sold out", a cart kept in this browser (ids and quantities only), and
 * "Check out", which asks the server for Stripe's page — every price on it
 * the server's. Talks only to `baseUrl` (the app's mount of
 * `createStorePublicHandlers`).
 */
export interface StorefrontProps {
  /** e.g. "/api/t/{web address}/store". */
  readonly baseUrl: string;
}

export function cartTotal(cart: Cart, products: readonly StorePublicProductWire[]): { minor: number; currency: string | null; count: number } {
  let minor = 0;
  let count = 0;
  let currency: string | null = null;
  for (const line of cart.lines) {
    const product = products.find((p) => p.id === line.productId);
    if (!product) continue;
    minor += product.priceMinor * line.quantity;
    count += line.quantity;
    currency ??= product.currency;
  }
  return { minor, currency, count };
}

export function Storefront(props: StorefrontProps) {
  const [store, setStore] = useState<StorePublicResponse | null>(null);
  const [cart, setCart] = useState<Cart>(() => emptyCart());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCart(loadCart(props.baseUrl)), [props.baseUrl]);
  const load = useCallback(async () => {
    try {
      // The cart's id goes along, so what this cart already holds counts as this customer's own.
      const id = loadCart(props.baseUrl).id;
      setStore(await request<StorePublicResponse>(`${props.baseUrl}/v1/store?cart=${encodeURIComponent(id)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [props.baseUrl]);
  useEffect(() => void load(), [load]);

  const products = store?.products ?? [];
  // A product that is gone or sold out leaves the cart (it can't be bought).
  const live = useMemo<Cart>(
    () => ({ id: cart.id, lines: cart.lines.filter((line) => products.some((p) => p.id === line.productId && !p.soldOut)) }),
    [cart, products],
  );
  const total = cartTotal(live, products);
  const change = (productId: string, quantity: number) => {
    const next = withQuantity(cart, productId, quantity);
    setCart(next);
    saveCart(props.baseUrl, next);
  };
  const checkout = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await request<StoreCheckoutResponse>(`${props.baseUrl}/v1/store/checkout`, {
        method: "POST",
        body: JSON.stringify({ cartId: live.id, lines: live.lines }),
      });
      window.location.assign(started.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      void load();
    }
  };

  if (!store) {
    return (
      <div className="aics">
        <StoreStyles />
        <ErrorNote message={error} />
        {!error ? <p className="aics-muted">Loading…</p> : null}
      </div>
    );
  }
  const locale = store.locale;
  return (
    <div className="aics aics-stack" data-storefront="">
      <StoreStyles />
      {!store.takingOrders ? <p className="aics-note">{store.takingOrdersNote}</p> : null}
      {products.length === 0 ? (
        <p className="aics-muted">Nothing for sale yet. Check back soon.</p>
      ) : (
        <ul className="aics-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {products.map((product) => {
            const inCart = cart.lines.find((line) => line.productId === product.id)?.quantity ?? 0;
            const most = product.fewLeft !== null ? Math.min(product.maxPerOrder, product.fewLeft) : product.maxPerOrder;
            return (
              <li key={product.id} className="aics-card aics-stack" data-store-item={product.id}>
                {product.photoUrl ? <img className="aics-photo" src={product.photoUrl} alt={product.name} /> : null}
                <div>
                  <p style={{ margin: 0, fontWeight: 600 }}>{product.name}</p>
                  {product.description ? <p className="aics-muted" style={{ margin: ".25rem 0 0", whiteSpace: "pre-line" }}>{product.description}</p> : null}
                </div>
                <div className="aics-row" style={{ justifyContent: "space-between" }}>
                  <span className="aics-price">{formatMoney(product.priceMinor, product.currency, locale)}</span>
                  {product.soldOut ? (
                    <span className="aics-tag aics-tag-bad">Sold out</span>
                  ) : product.fewLeft !== null ? (
                    <span className="aics-tag aics-tag-warn">Only {product.fewLeft} left</span>
                  ) : null}
                </div>
                {!product.soldOut && store.takingOrders ? (
                  inCart > 0 ? (
                    <div className="aics-row">
                      <button type="button" className="aics-btn aics-btn-quiet" aria-label={`One fewer ${product.name}`} onClick={() => change(product.id, inCart - 1)}>
                        −
                      </button>
                      <span aria-live="polite">{inCart} in your cart</span>
                      <button
                        type="button"
                        className="aics-btn aics-btn-quiet"
                        aria-label={`One more ${product.name}`}
                        disabled={inCart >= most}
                        onClick={() => change(product.id, inCart + 1)}
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="aics-btn" onClick={() => change(product.id, 1)}>
                      Add to cart
                    </button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {total.count > 0 && store.takingOrders ? (
        <section className="aics-card aics-stack" aria-label="Your cart" data-store-cart="">
          <h2 className="aics-h2">Your cart</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {live.lines.map((line) => {
              const product = products.find((p) => p.id === line.productId)!;
              return (
                <li key={line.productId} className="aics-row" style={{ justifyContent: "space-between" }}>
                  <span>
                    {line.quantity} × {product.name}
                  </span>
                  <span>{formatMoney(product.priceMinor * line.quantity, product.currency, locale)}</span>
                </li>
              );
            })}
          </ul>
          {store.shipping && store.shipping.minor > 0 ? (
            <p className="aics-row" style={{ justifyContent: "space-between", margin: 0 }}>
              <span>Shipping</span>
              <span>{formatMoney(store.shipping.minor, store.shipping.currency, locale)}</span>
            </p>
          ) : null}
          <p className="aics-row" style={{ justifyContent: "space-between", margin: 0 }}>
            <strong>Total</strong>
            <strong>{formatMoney(total.minor + (store.shipping && store.shipping.currency === total.currency ? store.shipping.minor : 0), total.currency ?? "usd", locale)}</strong>
          </p>
          <p className="aics-muted" style={{ margin: 0 }}>
            {store.pricesIncludeTax ? "Prices include any sales tax." : "Prices don't include sales tax."}
            {store.shipping ? " You give your delivery address on the next page." : " Pickup or digital delivery only."}
          </p>
          <ErrorNote message={error} />
          <div className="aics-row">
            <button type="button" className="aics-btn" disabled={busy} onClick={() => void checkout()}>
              {busy ? "Opening checkout…" : "Check out"}
            </button>
            <span className="aics-muted">You pay on Stripe&rsquo;s secure page. The final price is confirmed there.</span>
          </div>
        </section>
      ) : (
        <ErrorNote message={error} />
      )}
    </div>
  );
}

/**
 * THE THANK-YOU PAGE: Stripe sends the customer here after paying. It asks
 * the server whether the order is in (the webhook writes it, usually within
 * seconds) and shows its number; a bank payment says it's on its way.
 */
export function StoreThanks(props: { readonly baseUrl: string; readonly checkoutId: string; readonly storeHref: string }) {
  const [status, setStatus] = useState<StoreCheckoutStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let tries = 0;
    const ask = async () => {
      try {
        const next = await request<StoreCheckoutStatusResponse>(`${props.baseUrl}/v1/store/checkouts/${encodeURIComponent(props.checkoutId)}`);
        if (stopped) return;
        setStatus(next);
        if (next.state === "paid" || next.state === "processing") clearCart(props.baseUrl);
        tries += 1;
        if (next.state === "pending" && tries < 15) setTimeout(() => void ask(), 2000);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void ask();
    return () => {
      stopped = true;
    };
  }, [props.baseUrl, props.checkoutId]);
  return (
    <section className="aics aics-stack" data-store-thanks={status?.state ?? "loading"}>
      <StoreStyles />
      <ErrorNote message={error} />
      {!status && !error ? <p className="aics-muted">Checking your order…</p> : null}
      {status?.state === "paid" ? (
        <div className="aics-ok">
          <p style={{ margin: 0, fontWeight: 600 }}>Thank you — your order is in.</p>
          <p style={{ margin: ".25rem 0 0" }}>Order number {status.orderNumber}. A receipt is on its way to your email.</p>
        </div>
      ) : null}
      {status?.state === "processing" ? <p className="aics-note">Thank you. Your bank payment is on its way; you&rsquo;ll get an email when it clears and your order is in.</p> : null}
      {status?.state === "pending" ? <p className="aics-note">Thank you. We&rsquo;re confirming your payment — this page updates in a moment.</p> : null}
      {status?.state === "closed" ? <p className="aics-note">This checkout was closed without a payment, so nothing was charged.</p> : null}
      {status ? (
        <div className="aics-card">
          {status.lines.map((line, index) => (
            <p key={index} className="aics-row" style={{ justifyContent: "space-between", margin: 0 }}>
              <span>
                {line.quantity} × {line.name}
              </span>
              <span>{formatMoney(line.unitPriceMinor * line.quantity, status.currency)}</span>
            </p>
          ))}
          {status.shippingMinor > 0 ? (
            <p className="aics-row" style={{ justifyContent: "space-between", margin: 0 }}>
              <span>Shipping</span>
              <span>{formatMoney(status.shippingMinor, status.currency)}</span>
            </p>
          ) : null}
          <p className="aics-row" style={{ justifyContent: "space-between", margin: ".5rem 0 0" }}>
            <strong>Total</strong>
            <strong>{formatMoney(status.totalMinor, status.currency)}</strong>
          </p>
        </div>
      ) : null}
      <p>
        <a href={props.storeHref}>Back to the store</a>
      </p>
    </section>
  );
}
