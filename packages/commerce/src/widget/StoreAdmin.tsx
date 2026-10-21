import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import type { StoreOrderWire, StoreOrdersResponse, StoreProductWire, StoreProductsResponse, StoreSettingsWire, StoreStatusResponse } from "../store-wire.js";
import { currencyDigits, formatMoney, moneyInputValue, parseMoneyInput } from "./money.js";
import { ErrorNote, request, StoreStyles, whenText } from "./parts.js";
import { StoreAttention } from "./StoreAttention.js";

/**
 * THE OWNER'S STORE SCREEN (commerce 0.2): the products for sale — name,
 * description, price, photo, for sale or not, what is on the shelf and what
 * customers' open checkouts hold — the orders customers placed (number, what
 * was bought, where to send it, what was paid and refunded, "Mark as sent"),
 * and how customers get their order. Everything goes through `baseUrl` (the
 * app's mount of `createStoreAdminHandlers`), which checks the person's
 * permission on every call; this screen only asks.
 */
export interface StoreAdminProps {
  /** e.g. "/api/app/{company id}/store". */
  readonly baseUrl: string;
  /** The public store page, for "See your store". */
  readonly storefrontUrl: string;
  /** The heading. Default "Store"; `false` draws none (and no description), for a host page whose own header says it. */
  readonly title?: string | false;
  /** Can this person change things (store.manage)? The server checks again. */
  readonly canManage?: boolean;
  /** Dates in the company's locale. Default "en-US". */
  readonly locale?: string;
  /**
   * polish 3: the host page's header carries "See your store" (a link to
   * `storefrontUrl` beside its title), so the screen draws none of its own.
   * Default false.
   */
  readonly actionsInHeader?: boolean;
}

type Tab = "products" | "orders" | "settings" | "attention";



export function StoreAdmin(props: StoreAdminProps) {
  const [tab, setTab] = useState<Tab>("products");
  const [status, setStatus] = useState<StoreStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadStatus = useCallback(() => {
    request<StoreStatusResponse>(`${props.baseUrl}/v1/admin/status`)
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [props.baseUrl]);
  useEffect(() => loadStatus(), [loadStatus]);
  const canManage = props.canManage ?? true;
  return (
    <section className="aics aics-stack" data-store-admin="">
      <StoreStyles />
      {props.title === false && props.actionsInHeader ? null : (
        <header className="aics-row" style={{ justifyContent: props.title === false ? "flex-end" : "space-between" }}>
          {props.title === false ? null : (
            <div>
              <h1 className="aics-h1">{props.title ?? "Store"}</h1>
              <p className="aics-muted">Sell your own products online. Customers pay by card into your own Stripe account.</p>
            </div>
          )}
          {props.actionsInHeader ? null : (
            <a className="aics-btn aics-btn-quiet" href={props.storefrontUrl} target="_blank" rel="noopener noreferrer">
              See your store ↗<span className="aics-sr"> (opens in a new tab)</span>
            </a>
          )}
        </header>
      )}
      <ErrorNote message={error} />
      {status && !status.takingOrders ? <p className="aics-note">{status.takingOrdersNote}</p> : null}
      <div className="aics-tabs" role="tablist">
        {(
          [
            ["products", "Products"],
            ["orders", "Orders"],
            ["settings", "How customers get it"],
            ["attention", `Needs your attention${status && status.openAttention > 0 ? ` (${status.openAttention})` : ""}`],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" role="tab" className="aics-tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "products" ? <ProductsPanel baseUrl={props.baseUrl} status={status} canManage={canManage} /> : null}
      {tab === "orders" ? <OrdersPanel baseUrl={props.baseUrl} canManage={canManage} locale={props.locale} /> : null}
      {tab === "settings" && status ? <SettingsPanel baseUrl={props.baseUrl} settings={status.settings} canManage={canManage} onSaved={loadStatus} /> : null}
      {tab === "attention" ? <StoreAttention baseUrl={props.baseUrl} canManage={canManage} locale={props.locale} /> : null}
    </section>
  );
}

// --- Products -------------------------------------------------------------------

export interface ProductDraft {
  name: string;
  description: string;
  price: string;
  currency: string;
  forSale: boolean;
  counting: boolean;
  /** On the shelf (what the owner counts) — never what carts hold. */
  stock: string;
  maxPerOrder: string;
}

export function draftOf(product: StoreProductWire | null, currency: string): ProductDraft {
  return product
    ? {
        name: product.name,
        description: product.description ?? "",
        price: moneyInputValue(product.priceMinor, product.currency),
        currency: product.currency,
        forSale: product.status === "active",
        counting: product.stock !== null,
        stock: product.stock === null ? "" : String(product.stock),
        maxPerOrder: String(product.maxPerOrder),
      }
    : { name: "", description: "", price: "", currency, forSale: true, counting: false, stock: "", maxPerOrder: "5" };
}

/**
 * The draft as the route's body, or the sentence saying what to fix. The
 * shelf count is sent ONLY when the owner changed it, with the number the
 * form started from (`stockWas`), so a sale made while they typed is never
 * overwritten — the server refuses and says how many sold.
 */
export function productBody(draft: ProductDraft, startedFrom: StoreProductWire | null = null): { body: Record<string, unknown> } | { problem: string } {
  const priceMinor = parseMoneyInput(draft.price, draft.currency);
  if (!draft.name.trim()) return { problem: "Give the product a name." };
  if (priceMinor === null || priceMinor < 1) {
    return { problem: currencyDigits(draft.currency) === 0 ? "Type the price as a whole number, like 1200." : "Type the price like 12.50." };
  }
  let stock: number | null = null;
  if (draft.counting) {
    if (!/^\d{1,7}$/.test(draft.stock.trim())) return { problem: "Type how many you have on the shelf, like 12 (0 means sold out)." };
    stock = Number(draft.stock.trim());
  }
  if (!/^\d{1,2}$/.test(draft.maxPerOrder.trim()) || Number(draft.maxPerOrder) < 1) return { problem: "Type the most one customer can buy in one order, from 1 to 99." };
  const stockChanged = startedFrom === null ? stock !== null : stock !== startedFrom.stock;
  return {
    body: {
      name: draft.name,
      description: draft.description,
      priceMinor,
      currency: draft.currency,
      status: draft.forSale ? "active" : "inactive",
      maxPerOrder: Number(draft.maxPerOrder),
      ...(stockChanged ? { stock, ...(startedFrom ? { stockWas: startedFrom.stock } : {}) } : {}),
    },
  };
}

/** "On the shelf: 5 · Held in carts: 2" in plain words. */
export function stockWords(product: Pick<StoreProductWire, "stock" | "held">): string {
  if (product.stock === null) return "No stock count";
  const available = Math.max(0, product.stock - product.held);
  const shelf = `On the shelf: ${product.stock}`;
  if (product.held > 0) return `${shelf} · Held in carts: ${product.held} · Available: ${available}`;
  return product.stock === 0 ? `${shelf} (sold out)` : shelf;
}

function ProductsPanel(props: { readonly baseUrl: string; readonly status: StoreStatusResponse | null; readonly canManage: boolean }) {
  const [list, setList] = useState<StoreProductsResponse | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList(await request<StoreProductsResponse>(`${props.baseUrl}/v1/admin/products`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [props.baseUrl]);
  useEffect(() => void load(), [load]);
  const release = async (product: StoreProductWire) => {
    setBusy(product.id);
    setError(null);
    try {
      await request(`${props.baseUrl}/v1/admin/products/${encodeURIComponent(product.id)}/release`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };
  const atLimit = list !== null && list.limit !== null && list.products.length >= list.limit;
  return (
    <div className="aics-stack" data-store-products="">
      <ErrorNote message={error} />
      {props.canManage ? (
        <div className="aics-row">
          <button type="button" className="aics-btn" disabled={editing === "new" || atLimit} onClick={() => setEditing("new")}>
            Add a product
          </button>
          {list && list.limit !== null ? (
            <span className="aics-muted">
              {list.products.length} of {list.limit} products on your plan
            </span>
          ) : null}
        </div>
      ) : null}
      {editing === "new" ? (
        <ProductForm
          baseUrl={props.baseUrl}
          product={null}
          currency={props.status?.currency ?? "usd"}
          photosEnabled={props.status?.photosEnabled ?? false}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
      {!list ? (
        <p className="aics-muted">Loading…</p>
      ) : list.products.length === 0 ? (
        <div className="aics-card aics-empty" data-store-empty="">
          <p className="aics-empty-title">Nothing for sale yet</p>
          <p className="aics-muted">
            Once you add products, customers buy them on your own store page and pay by card. Every order lands here with what they bought
            and where to send it, and you get an email.
          </p>
          {props.canManage ? (
            <button type="button" className="aics-btn" disabled={editing === "new" || atLimit} onClick={() => setEditing("new")}>
              Add your first product
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="aics-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {list.products.map((product) =>
            editing === product.id ? (
              <li key={product.id}>
                <ProductForm
                  baseUrl={props.baseUrl}
                  product={product}
                  currency={product.currency}
                  photosEnabled={props.status?.photosEnabled ?? false}
                  onDone={() => {
                    setEditing(null);
                    void load();
                  }}
                />
              </li>
            ) : (
              <li key={product.id} className="aics-card aics-row" data-store-product={product.id}>
                {product.photoUrl ? <img className="aics-thumb" src={product.photoUrl} alt="" /> : <span className="aics-thumb" aria-hidden="true" />}
                <div style={{ flex: 1, minWidth: "12rem" }}>
                  <p style={{ margin: 0, fontWeight: 600 }}>{product.name}</p>
                  <p className="aics-muted" style={{ margin: 0 }}>
                    <span className="aics-price">{formatMoney(product.priceMinor, product.currency)}</span>
                    {" · "}
                    {product.status === "active" ? "For sale" : "Not for sale"}
                    {" · "}
                    <span data-store-stock="">{stockWords(product)}</span>
                  </p>
                </div>
                {product.stock !== null && product.stock - product.held <= 0 ? <span className="aics-tag aics-tag-bad">Sold out</span> : null}
                {product.status !== "active" ? <span className="aics-tag">Hidden</span> : null}
                {props.canManage && product.held > 0 ? (
                  <button type="button" className="aics-btn aics-btn-quiet" disabled={busy === product.id} onClick={() => void release(product)} title="Close the open checkouts holding it, so it is back for sale">
                    Release held items
                  </button>
                ) : null}
                {props.canManage ? (
                  <button type="button" className="aics-btn aics-btn-quiet" onClick={() => setEditing(product.id)}>
                    Edit
                  </button>
                ) : null}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

const CURRENCIES = ["usd", "cad", "gbp", "eur", "aud", "nzd"] as const;

function ProductForm(props: {
  readonly baseUrl: string;
  readonly product: StoreProductWire | null;
  readonly currency: string;
  readonly photosEnabled: boolean;
  readonly onDone: () => void;
}) {
  const [draft, setDraft] = useState<ProductDraft>(() => draftOf(props.product, props.currency));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const set = (patch: Partial<ProductDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    const built = productBody(draft, props.product);
    if ("problem" in built) return setError(built.problem);
    setBusy(true);
    setError(null);
    try {
      const url = props.product ? `${props.baseUrl}/v1/admin/products/${encodeURIComponent(props.product.id)}` : `${props.baseUrl}/v1/admin/products`;
      await request(url, { method: "POST", body: JSON.stringify(built.body) });
      props.onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!props.product) return;
    setBusy(true);
    try {
      await request(`${props.baseUrl}/v1/admin/products/${encodeURIComponent(props.product.id)}/remove`, { method: "POST", body: "{}" });
      props.onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !props.product) return;
    if (file.size > 4 * 1024 * 1024) return setError("That photo is over 4 MB. Choose a smaller one.");
    setBusy(true);
    setError(null);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("That photo couldn't be read."));
        reader.readAsDataURL(file);
      });
      await request(`${props.baseUrl}/v1/admin/products/${encodeURIComponent(props.product.id)}/photo`, {
        method: "POST",
        body: JSON.stringify({ contentType: file.type, data }),
      });
      props.onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="aics-card aics-stack"
      data-store-product-form=""
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="aics-h2">{props.product ? `Edit ${props.product.name}` : "Add a product"}</h2>
      <ErrorNote message={error} />
      <label className="aics-label">
        Name
        <input className="aics-input" value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} required />
      </label>
      <label className="aics-label">
        Description <span className="aics-muted">(optional)</span>
        <textarea className="aics-textarea" value={draft.description} maxLength={2000} onChange={(e) => set({ description: e.target.value })} />
      </label>
      <div className="aics-row">
        <label className="aics-label">
          Price
          <input className="aics-input" inputMode="decimal" value={draft.price} placeholder={currencyDigits(draft.currency) === 0 ? "1200" : "12.50"} onChange={(e) => set({ price: e.target.value })} />
        </label>
        <label className="aics-label">
          Currency
          <select className="aics-select" value={draft.currency} onChange={(e) => set({ currency: e.target.value })}>
            {[...new Set([draft.currency, ...CURRENCIES])].map((code) => (
              <option key={code} value={code}>
                {code.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="aics-row" style={{ fontSize: ".875rem" }}>
        <input type="checkbox" checked={draft.forSale} onChange={(e) => set({ forSale: e.target.checked })} /> For sale on your store
      </label>
      <div className="aics-row">
        <label className="aics-row" style={{ fontSize: ".875rem" }}>
          <input type="checkbox" checked={draft.counting} onChange={(e) => set({ counting: e.target.checked })} /> Keep a stock count
        </label>
        {draft.counting ? (
          <label className="aics-label">
            On the shelf
            <input className="aics-input aics-qty" inputMode="numeric" value={draft.stock} onChange={(e) => set({ stock: e.target.value })} />
          </label>
        ) : null}
        <label className="aics-label">
          Most per order
          <input className="aics-input aics-qty" inputMode="numeric" value={draft.maxPerOrder} onChange={(e) => set({ maxPerOrder: e.target.value })} />
        </label>
      </div>
      {draft.counting ? (
        <p className="aics-muted">
          Count what you have on the shelf. An item in a customer&rsquo;s open checkout is held for them for up to 30 minutes and comes off the shelf when they pay
          {props.product && props.product.held > 0 ? ` (${props.product.held} held in carts right now)` : ""}.
        </p>
      ) : null}
      {props.product ? (
        props.photosEnabled ? (
          <label className="aics-label">
            Photo <span className="aics-muted">(counts toward your file storage)</span>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={(e) => void upload(e)} />
          </label>
        ) : (
          <p className="aics-muted">Photo uploads aren&rsquo;t switched on here yet.</p>
        )
      ) : (
        <p className="aics-muted">Save the product first, then add its photo.</p>
      )}
      <div className="aics-row">
        <button type="submit" className="aics-btn" disabled={busy}>
          {props.product ? "Save changes" : "Add product"}
        </button>
        <button type="button" className="aics-btn aics-btn-quiet" disabled={busy} onClick={props.onDone}>
          Cancel
        </button>
        {props.product && !confirmRemove ? (
          <button type="button" className="aics-btn aics-btn-quiet" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remove
          </button>
        ) : null}
      </div>
      {confirmRemove ? (
        <div className="aics-note aics-row" role="group" aria-label="Remove this product?">
          <span>Remove {props.product?.name}? It comes off your store; its past orders stay.</span>
          <button type="button" className="aics-btn" disabled={busy} onClick={() => void remove()}>
            Yes, remove it
          </button>
          <button type="button" className="aics-btn aics-btn-quiet" onClick={() => setConfirmRemove(false)}>
            Keep it
          </button>
        </div>
      ) : null}
      {props.product ? <p className="aics-muted">Changing the price closes any checkout already open with this product, so nobody pays the old price.</p> : null}
    </form>
  );
}

// --- How customers get their order ----------------------------------------------

function SettingsPanel(props: { readonly baseUrl: string; readonly settings: StoreSettingsWire; readonly canManage: boolean; readonly onSaved: () => void }) {
  const [fulfilment, setFulfilment] = useState(props.settings.fulfilment);
  const [countries, setCountries] = useState(props.settings.shipCountries.join(", "));
  const [shipping, setShipping] = useState(moneyInputValue(props.settings.shippingMinor, props.settings.currency));
  const [currency, setCurrency] = useState(props.settings.currency);
  const [includesTax, setIncludesTax] = useState(props.settings.pricesIncludeTax);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setError(null);
    setSaved(false);
    const shippingMinor = parseMoneyInput(shipping || "0", currency);
    if (shippingMinor === null) return setError("Type the shipping price like 5.00 (0 for free shipping).");
    try {
      await request(`${props.baseUrl}/v1/admin/settings`, {
        method: "POST",
        body: JSON.stringify({
          fulfilment,
          shipCountries: countries.split(/[\s,]+/).filter(Boolean),
          shippingMinor,
          currency,
          pricesIncludeTax: includesTax,
        }),
      });
      setSaved(true);
      props.onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <form
      className="aics-card aics-stack"
      data-store-settings=""
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="aics-h2">How customers get their order</h2>
      <ErrorNote message={error} />
      {saved ? <p className="aics-ok">Saved.</p> : null}
      <label className="aics-row" style={{ fontSize: ".875rem" }}>
        <input type="radio" name="fulfilment" checked={fulfilment === "ship"} disabled={!props.canManage} onChange={() => setFulfilment("ship")} /> I ship it
      </label>
      <label className="aics-row" style={{ fontSize: ".875rem" }}>
        <input type="radio" name="fulfilment" checked={fulfilment === "pickup"} disabled={!props.canManage} onChange={() => setFulfilment("pickup")} /> Pickup or digital only
      </label>
      {fulfilment === "ship" ? (
        <div className="aics-row">
          <label className="aics-label">
            Shipping price per order
            <input className="aics-input aics-qty" inputMode="decimal" value={shipping} onChange={(e) => setShipping(e.target.value)} />
          </label>
          <label className="aics-label">
            Currency
            <select className="aics-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {[...new Set([currency, ...CURRENCIES])].map((code) => (
                <option key={code} value={code}>
                  {code.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="aics-label">
            Countries you ship to
            <input className="aics-input" value={countries} placeholder="US, CA" onChange={(e) => setCountries(e.target.value)} />
          </label>
        </div>
      ) : null}
      {fulfilment === "ship" ? <p className="aics-muted">Customers give their address on Stripe&rsquo;s page; it shows on the order.</p> : null}
      <label className="aics-row" style={{ fontSize: ".875rem" }}>
        <input type="checkbox" checked={includesTax} disabled={!props.canManage} onChange={(e) => setIncludesTax(e.target.checked)} /> Prices include any sales tax
      </label>
      <p className="aics-muted">Sales tax isn&rsquo;t worked out automatically yet: customers pay exactly the prices you set (plus shipping).</p>
      {props.canManage ? (
        <div>
          <button type="submit" className="aics-btn">
            Save
          </button>
        </div>
      ) : null}
    </form>
  );
}

// --- Orders -----------------------------------------------------------------------

export function orderStatusWords(order: StoreOrderWire): string {
  if (order.status === "refunded") return "Refunded";
  if (order.refundedMinor > 0) return `Part refunded (${formatMoney(order.refundedMinor, order.currency)})`;
  if (order.status === "sent") return "Sent";
  if (order.status === "pending") return "Payment on its way";
  return "Paid — to send";
}

const FLAG_WORDS: Readonly<Record<string, string>> = {
  disputed: "Disputed by the customer's bank",
  dispute_lost: "Dispute lost",
};

function addressLines(order: StoreOrderWire): string[] {
  const a = order.shipTo;
  if (!a) return [];
  return [a.name, a.line1, a.line2, [a.city, a.region, a.postalCode].filter(Boolean).join(" "), a.country].filter((part): part is string => Boolean(part));
}

function OrdersPanel(props: { readonly baseUrl: string; readonly canManage: boolean; readonly locale?: string }) {
  const [orders, setOrders] = useState<readonly StoreOrderWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setOrders((await request<StoreOrdersResponse>(`${props.baseUrl}/v1/admin/orders`)).orders);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [props.baseUrl]);
  useEffect(() => void load(), [load]);
  const sent = async (order: StoreOrderWire) => {
    setBusy(order.id);
    try {
      await request(`${props.baseUrl}/v1/admin/orders/${encodeURIComponent(order.id)}/sent`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };
  if (!orders) return <p className="aics-muted">Loading…</p>;
  if (orders.length === 0) {
    return (
      <div className="aics-card aics-empty" data-store-orders-empty="">
        <p className="aics-empty-title">No orders yet</p>
        <p className="aics-muted">When a customer pays, the order lands here with what they bought and where to send it, and you get an email.</p>
      </div>
    );
  }
  return (
    <div className="aics-stack" data-store-orders="">
      <ErrorNote message={error} />
      {/* A phone scrolls the table sideways instead of squeezing it. */}
      <div className="aics-scroll">
        <table className="aics-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>What they bought</th>
              <th>Paid</th>
              <th>Where it stands</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id} data-store-order={order.orderNumber}>
                <td>
                  <strong>{order.orderNumber}</strong>
                  <br />
                  <span className="aics-muted">{order.placedAt ? whenText(order.placedAt, props.locale) : ""}</span>
                </td>
                <td>
                  {order.email || <span className="aics-muted">No email given</span>}
                  {addressLines(order).length > 0 ? (
                    <div className="aics-muted" data-store-ship-to="">
                      Send to: {addressLines(order).join(", ")}
                    </div>
                  ) : null}
                </td>
                <td>
                  {order.lines.map((line, index) => (
                    <div key={index}>
                      {line.quantity} × {line.name}
                    </div>
                  ))}
                  {order.shippingMinor > 0 ? <div className="aics-muted">Shipping {formatMoney(order.shippingMinor, order.currency)}</div> : null}
                </td>
                <td className="aics-price">{formatMoney(order.totalMinor, order.currency)}</td>
                <td>
                  {orderStatusWords(order)}
                  {order.flag ? (
                    <>
                      <br />
                      <span className="aics-tag aics-tag-warn">{FLAG_WORDS[order.flag]}</span>
                    </>
                  ) : null}
                  {order.oversold ? (
                    <>
                      <br />
                      <span className="aics-tag aics-tag-bad">Sold after it ran out</span>
                    </>
                  ) : null}
                </td>
                <td>
                  <div className="aics-row">
                    {props.canManage && order.status === "paid" ? (
                      <button type="button" className="aics-btn aics-btn-quiet" disabled={busy === order.id} onClick={() => void sent(order)}>
                        Mark as sent
                      </button>
                    ) : null}
                    {order.stripeUrl ? (
                      <a href={order.stripeUrl} target="_blank" rel="noreferrer">
                        Refund in Stripe
                      </a>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
