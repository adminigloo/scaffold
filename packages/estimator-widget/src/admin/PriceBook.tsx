import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { formatMoney, formatPercent } from "../format.js";
import type { ClientError } from "../http.js";
import { ChevronIcon, describedBy, Dialog, Field, Loading, Notice, useMounted } from "../parts.js";
import type { UnitType } from "../types.js";
import type { EstimatorAdminTransport } from "./client.js";
import { adminErrorText, centsToInput, parseMoneyInput, recipeInfoFor, UNIT_LABEL } from "./helpers.js";
import { ProductEditor } from "./ProductEditor.js";
import type { AdminProduct, SupplyWire } from "./types.js";
import { AdminFrame, LoadError, Outcome, ToastRegion, useAdminBasics, useAdminTransport, useToasts, type AdminChromeProps } from "./ui.js";

/**
 * <PriceBook> — the owner's products and the supplies their prices are built
 * from (contract 9.7).
 *
 *   Products   each product, how it's measured, whether it's on the website,
 *              priced instantly or by quote; reorder with buttons; retire and
 *              restore; open one to edit it (and test a quote) in place
 *   Supplies   the library: what each costs the business, from whom, used by
 *              which products; change a cost and see which prices it moves
 *
 * An empty price book offers "Load a sample catalog" — on purpose, with a
 * confirmation; nothing ever loads it by itself (ES-V1).
 */

export interface PriceBookProps extends AdminChromeProps {
  /** Which tab to open on. Default "products". */
  initialTab?: "products" | "supplies";
  /**
   * Offer the controls that change the price book: add, edit, reorder,
   * retire and restore products and supplies, and the sample catalog. The
   * server still refuses a change without `estimator.pricebook.manage`; false
   * only stops offering buttons that would fail (Tenancy 2a: a company's
   * member quotes from the price book, its owner and admins keep it).
   * Default true.
   */
  canManage?: boolean;
  /** The heading. Default "Price book"; `false` draws none, for a host page whose own header says it. */
  title?: string | false;
}

/** What someone who may read the price book but not change it is told, once, at the top. */
export const READ_ONLY_PRICE_BOOK = "You can see the price book. Only the owner or an admin can change it.";

/**
 * The sample arrives OFF the website: its made-up prices reach no customer
 * until the owner has changed them and turned each product on (review EST-R01).
 */
export const SAMPLE_CONFIRM =
  "This adds sample products and supplies with sample prices. They stay off your website until you turn each one on, so change the prices to yours first.";

/**
 * The trades a sample price book is offered for, and what each adds (Tenancy
 * 2a review T2A-BO-10): a lawn or cleaning business is offered its own kind
 * of work, never a wheelchair-ramp company's. The counts match
 * @adminigloo/estimator's SAMPLE_CATALOGS (both packages' tests hold them).
 */
export const SAMPLE_TRADES: ReadonlyArray<{ readonly key: "lawn" | "cleaning" | "ramps"; readonly label: string; readonly products: number; readonly supplies: number }> = [
  { key: "lawn", label: "Lawn care and landscaping", products: 5, supplies: 8 },
  { key: "cleaning", label: "Home cleaning", products: 5, supplies: 5 },
  { key: "ramps", label: "Wheelchair ramps and accessibility", products: 5, supplies: 10 },
];

export function PriceBook(props: PriceBookProps) {
  const canManage = props.canManage !== false;
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const basics = useAdminBasics(transport);
  const mounted = useMounted();
  const ids = useId();
  const locale = props.locale ?? basics.settings?.locale ?? "en-US";
  const currency = basics.settings?.currency ?? "USD";
  const [tab, setTab] = useState<"products" | "supplies">(props.initialTab ?? "products");
  const [products, setProducts] = useState<AdminProduct[] | null>(null);
  const [productsError, setProductsError] = useState<ClientError | null>(null);
  const [supplies, setSupplies] = useState<SupplyWire[] | null>(null);
  const [suppliesError, setSuppliesError] = useState<ClientError | null>(null);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  // The editor's React key, set when it OPENS: creating a product moves
  // `editing` from "new" to its id without remounting the editor, so the owner
  // sees "Created" and keeps the test answers (review EST-R14).
  const [editorKey, setEditorKey] = useState(0);
  const openEditor = (id: string | "new") => {
    setEditorKey((n) => n + 1);
    setEditing(id);
  };
  const [confirmSample, setConfirmSample] = useState(false);
  // Which trade's sample: asked, never assumed (T2A-BO-10).
  const [sampleTrade, setSampleTrade] = useState<"lawn" | "cleaning" | "ramps" | null>(null);
  const sampleIds = useId();
  const [sampleBusy, setSampleBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    let alive = true;
    setProductsError(null);
    void transport.listProducts({ includeInactive: true }).then((res) => {
      if (!alive) return;
      if (res.ok) setProducts(res.data.products);
      else setProductsError(res.error);
    });
    void transport.listSupplies({ includeInactive: true }).then((res) => {
      if (!alive) return;
      if (res.ok) {
        setSupplies(res.data.supplies);
        setSuppliesError(null);
      } else setSuppliesError(res.error);
    });
    return () => {
      alive = false;
    };
  }, [transport, reload]);

  const replaceProduct = useCallback((next: AdminProduct) => {
    setProducts((list) => (list ? (list.some((p) => p.id === next.id) ? list.map((p) => (p.id === next.id ? next : p)) : [...list, next]) : [next]));
  }, []);
  const replaceSupply = useCallback((next: SupplyWire) => {
    setSupplies((list) => (list ? (list.some((s) => s.id === next.id) ? list.map((s) => (s.id === next.id ? next : s)) : [...list, next]) : [next]));
  }, []);

  const loadSample = async () => {
    if (!sampleTrade) return;
    setSampleBusy(true);
    const res = await transport.loadSampleCatalog(sampleTrade);
    if (!mounted.current) return;
    setSampleBusy(false);
    setConfirmSample(false);
    if (!res.ok) {
      push("error", adminErrorText(res.error));
      return;
    }
    push("ok", `Loaded ${res.data.products} products and ${res.data.supplies} supplies, off your website. Change the prices to yours, then turn each one on.`);
    setReload((n) => n + 1);
    basics.refresh();
  };

  const active = (products ?? []).filter((p) => p.isActive).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const retired = (products ?? []).filter((p) => !p.isActive);

  const move = async (index: number, delta: number) => {
    const order = active.map((p) => p.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    setListError(null);
    const res = await transport.reorderProducts(order);
    if (!mounted.current) return;
    if (res.ok) setProducts((list) => mergeProducts(list, res.data.products));
    else setListError(adminErrorText(res.error));
  };

  const setActive = async (product: AdminProduct, on: boolean) => {
    setListError(null);
    const res = on ? await transport.reactivateProduct(product.id) : await transport.deactivateProduct(product.id);
    if (!mounted.current) return;
    if (res.ok) {
      replaceProduct(res.data.product);
      basics.refresh();
    } else setListError(adminErrorText(res.error));
  };

  const editingProduct = editing && editing !== "new" ? (products ?? []).find((p) => p.id === editing) ?? null : null;

  return (
    <AdminFrame chrome={props} basics={basics} data={{ "aiew-pricebook": products ? "ready" : productsError ? "error" : "loading" }}>
      {editing ? (
        <ProductEditor
          key={editorKey}
          product={editingProduct}
          supplies={supplies}
          suppliesError={suppliesError}
          settings={basics.settings}
          transport={transport}
          locale={locale}
          currency={currency}
          onSaved={(product) => {
            replaceProduct(product);
            if (editing === "new") setEditing(product.id);
            basics.refresh();
          }}
          onSupplyCreated={replaceSupply}
          onClose={() => setEditing(null)}
        />
      ) : (
        <>
          {props.title === false ? null : (
            <div className="aiew-admin-head" data-titled="">
              <h2 className="aiew-admin-title">{props.title ?? "Price book"}</h2>
            </div>
          )}
          {canManage ? null : (
            <p className="aiew-muted" data-aiew-read-only="">
              {READ_ONLY_PRICE_BOOK}
            </p>
          )}
          <div className="aiew-tabs" role="tablist" aria-label="Price book">
            {(["products", "supplies"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`${ids}-tab-${key}`}
                aria-controls={`${ids}-panel-${key}`}
                aria-selected={tab === key}
                tabIndex={tab === key ? 0 : -1}
                className="aiew-tab"
                onClick={() => setTab(key)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    const next = key === "products" ? "supplies" : "products";
                    setTab(next);
                    (event.currentTarget.parentElement?.querySelector(`[id="${ids}-tab-${next}"]`) as HTMLElement | null)?.focus();
                  }
                }}
              >
                {key === "products" ? "Products" : "Supplies"}
              </button>
            ))}
          </div>
          {tab === "products" ? (
            <div role="tabpanel" id={`${ids}-panel-products`} aria-labelledby={`${ids}-tab-products`} className="aiew-stack" data-aiew-products="">
              {productsError ? <LoadError error={productsError} onRetry={() => setReload((n) => n + 1)} /> : null}
              {!products && !productsError ? <Loading label="Loading products…" /> : null}
              {products && products.length === 0 ? (
                <section className="aiew-panel" data-aiew-empty="products">
                  <div className="aiew-panel-body aiew-empty">
                    <p className="aiew-empty-title">No products yet.</p>
                    {canManage ? (
                      <>
                        <p>Add what you sell, priced from your own supplies and labor. Or start from a sample and change the prices to yours.</p>
                        <div className="aiew-row">
                          <button type="button" className="aiew-btn aiew-btn-primary" onClick={() => openEditor("new")}>
                            Add a product
                          </button>
                          <button type="button" className="aiew-btn aiew-btn-secondary" onClick={() => setConfirmSample(true)} data-aiew-load-sample="">
                            Load a sample catalog
                          </button>
                        </div>
                      </>
                    ) : (
                      <p>The owner or an admin adds what you sell here.</p>
                    )}
                  </div>
                </section>
              ) : null}
              {products && products.length > 0 ? (
                <>
                  {canManage ? (
                    <div className="aiew-row">
                      <button type="button" className="aiew-btn aiew-btn-primary" onClick={() => openEditor("new")}>
                        Add a product
                      </button>
                    </div>
                  ) : null}
                  {listError ? <Notice tone="error">{listError}</Notice> : null}
                  <ul className="aiew-plist" aria-label="Products, in the order customers see them">
                    {active.map((product, i) => (
                      <li key={product.id} className="aiew-pitem" data-aiew-product={product.id}>
                        <div className="aiew-pitem-main">
                          <span className="aiew-pitem-name">{product.name}</span>
                          <span className="aiew-hint">How it&apos;s measured: {recipeInfoFor(product.recipe, product.recipeInfo).label}</span>
                          {product.example ? (
                            <span className="aiew-hint" data-aiew-example="">
                              {exampleText(product.example, currency, locale)}
                            </span>
                          ) : null}
                          <span className="aiew-tags">
                            {product.showInEstimator ? <span className="aiew-tag aiew-tag-ok">On your website</span> : <span className="aiew-tag">Staff only</span>}
                            {!product.isEstimatable ? <span className="aiew-tag aiew-tag-warn">Price by quote</span> : null}
                          </span>
                        </div>
                        {canManage ? (
                          <>
                            <button type="button" className="aiew-btn aiew-btn-secondary aiew-icon-btn" aria-label={`Move ${product.name} up`} disabled={i === 0} onClick={() => void move(i, -1)}>
                              <ChevronIcon direction="up" />
                            </button>
                            <button
                              type="button"
                              className="aiew-btn aiew-btn-secondary aiew-icon-btn"
                              aria-label={`Move ${product.name} down`}
                              disabled={i === active.length - 1}
                              onClick={() => void move(i, 1)}
                            >
                              <ChevronIcon direction="down" />
                            </button>
                            <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => openEditor(product.id)}>
                              Edit
                            </button>
                            <button type="button" className="aiew-btn aiew-btn-danger-outline aiew-btn-sm" onClick={() => void setActive(product, false)}>
                              Retire
                            </button>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {retired.length > 0 ? (
                    <details>
                      <summary>Retired products ({retired.length})</summary>
                      <ul className="aiew-plist">
                        {retired.map((product) => (
                          <li key={product.id} className="aiew-pitem" data-aiew-retired={product.id}>
                            <span className="aiew-pitem-main">{product.name}</span>
                            {canManage ? (
                              <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => void setActive(product, true)}>
                                Restore
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : (
            <div role="tabpanel" id={`${ids}-panel-supplies`} aria-labelledby={`${ids}-tab-supplies`} className="aiew-stack">
              <SuppliesLibrary
                supplies={supplies}
                error={suppliesError}
                currency={currency}
                locale={locale}
                transport={transport}
                canManage={canManage}
                onChanged={(supply, affected) => {
                  replaceSupply(supply);
                  // A cost moved: the products using it re-read, so their editors show the new numbers.
                  if (affected.length > 0) setReload((n) => n + 1);
                }}
                onRetry={() => setReload((n) => n + 1)}
              />
            </div>
          )}
        </>
      )}
      {confirmSample ? (
        <Dialog title="Load a sample catalog?" onClose={() => setConfirmSample(false)} data={{ "aiew-sample-confirm": "" }}>
          <fieldset className="aiew-fieldset" data-aiew-sample-trade="">
            <legend className="aiew-label" id={`${sampleIds}-trade`}>
              What kind of work do you do?
            </legend>
            {SAMPLE_TRADES.map((trade) => (
              <label key={trade.key} className="aiew-check">
                <input
                  type="radio"
                  name={`${sampleIds}-trade`}
                  value={trade.key}
                  checked={sampleTrade === trade.key}
                  onChange={() => setSampleTrade(trade.key)}
                />
                <span>{trade.label}</span>
              </label>
            ))}
          </fieldset>
          <p>
            {(() => {
              const picked = SAMPLE_TRADES.find((trade) => trade.key === sampleTrade);
              return picked
                ? `This adds ${picked.products} sample products and ${picked.supplies} supplies with sample prices. They stay off your website until you turn each one on, so change the prices to yours first.`
                : SAMPLE_CONFIRM;
            })()}
          </p>
          <div className="aiew-actions">
            <button
              type="button"
              className="aiew-btn aiew-btn-primary"
              disabled={sampleBusy || !sampleTrade}
              aria-busy={sampleBusy || undefined}
              onClick={() => void loadSample()}
            >
              {sampleBusy ? "Loading…" : "Load the sample"}
            </button>
            <button type="button" className="aiew-btn aiew-btn-secondary" onClick={() => setConfirmSample(false)}>
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </AdminFrame>
  );
}

/** "3 steps: $6,921.46, margin 28.57%": the server's price at an everyday answer (the margin only with access to costs). */
export function exampleText(example: NonNullable<AdminProduct["example"]>, currency: string, locale: string): string {
  const price = formatMoney(example.price, currency, locale);
  return example.marginBp !== null ? `${example.label}: ${price}, margin ${formatPercent(example.marginBp)}` : `${example.label}: ${price}`;
}

/** The reorder answer is the active list; retired products stay as they were. */
function mergeProducts(list: AdminProduct[] | null, next: AdminProduct[]): AdminProduct[] {
  const byId = new Map(next.map((p) => [p.id, p]));
  const merged = (list ?? []).map((p) => byId.get(p.id) ?? p);
  for (const p of next) if (!merged.some((m) => m.id === p.id)) merged.push(p);
  return merged;
}

// ---------------------------------------------------------------------------
// The supplies library
// ---------------------------------------------------------------------------

const UNIT_TYPES: UnitType[] = ["per_linear_ft", "per_sqft", "per_unit", "flat"];

interface SupplyDraft {
  name: string;
  unitType: UnitType;
  cost: string;
  supplier: string;
  sku: string;
  note: string;
}

function draftOf(supply: SupplyWire | null): SupplyDraft {
  return {
    name: supply?.name ?? "",
    unitType: supply?.unitType ?? "per_unit",
    cost: centsToInput(supply?.unitCost ?? null),
    supplier: supply?.supplier ?? "",
    sku: supply?.sku ?? "",
    note: supply?.note ?? "",
  };
}

/** "Updated. This changes the price of: Modular aluminum ramp, Handrail only." */
export function affectedText(prefix: string, affected: ReadonlyArray<{ name: string }>): string {
  return affected.length > 0 ? `${prefix} This changes the price of: ${affected.map((p) => p.name).join(", ")}.` : prefix;
}

export function SuppliesLibrary({
  supplies,
  error,
  currency,
  locale,
  transport,
  canManage = true,
  onChanged,
  onRetry,
}: {
  supplies: SupplyWire[] | null;
  error: ClientError | null;
  currency: string;
  locale: string;
  transport: EstimatorAdminTransport;
  /** Offer add, edit, retire and restore (PriceBookProps.canManage). Default true. */
  canManage?: boolean;
  onChanged: (supply: SupplyWire, affected: Array<{ id: string; name: string }>) => void;
  onRetry: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<SupplyWire | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  if (error) return <LoadError error={error} onRetry={onRetry} />;
  if (!supplies) return <Loading label="Loading supplies…" />;
  const active = supplies.filter((s) => s.isActive);
  const retired = supplies.filter((s) => !s.isActive);
  const costsHidden = supplies.some((s) => s.unitCost === null);

  const retire = async (supply: SupplyWire) => {
    const res = await transport.deactivateSupply(supply.id);
    setRetiring(null);
    if (!res.ok) return setMessage({ tone: "error", text: adminErrorText(res.error) });
    onChanged(res.data.supply, res.data.affectedProducts);
    setMessage({ tone: "ok", text: affectedText(`Retired ${supply.name}.`, res.data.affectedProducts) });
  };
  const restore = async (supply: SupplyWire) => {
    const res = await transport.reactivateSupply(supply.id);
    if (!res.ok) return setMessage({ tone: "error", text: adminErrorText(res.error) });
    onChanged(res.data.supply, res.data.affectedProducts);
    setMessage({ tone: "ok", text: affectedText(`Restored ${supply.name}.`, res.data.affectedProducts) });
  };

  return (
    <div className="aiew-stack" data-aiew-supplies="">
      <p className="aiew-muted">What things cost you. Products use these to build their prices; customers never see them.</p>
      {costsHidden ? <Notice tone="info">You can see what&apos;s used, not what it costs.</Notice> : null}
      {message ? (
        <Notice tone={message.tone === "ok" ? "ok" : "error"} data="supply-message">
          {message.text}
        </Notice>
      ) : null}
      {canManage ? (
        <SupplyForm
          title="Add a supply"
          initial={draftOf(null)}
          submitLabel="Add supply"
          onSubmit={async (draft) => {
            const cost = parseMoneyInput(draft.cost);
            if (cost === null || Number.isNaN(cost)) return "Enter what it costs you, like 95.00.";
            const res = await transport.createSupply({
              name: draft.name.trim(),
              unitType: draft.unitType,
              unitCost: cost,
              supplier: draft.supplier.trim() || null,
              sku: draft.sku.trim() || null,
              note: draft.note.trim() || null,
            });
            if (!res.ok) return adminErrorText(res.error);
            onChanged(res.data.supply, []);
            setMessage({ tone: "ok", text: `Added ${res.data.supply.name}.` });
            return null;
          }}
          resetOnSave
        />
      ) : null}
      {/* Below 600 px each row is a card (the admin stylesheet): name and cost
          on one line, the rest under it, Edit and Retire in reach. Every cell
          carries its column's name for that layout (review EST-R08). */}
      <div className="aiew-table-wrap aiew-supply-wrap">
        <table className="aiew-table aiew-supply-table">
          <caption className="aiew-sr">Your supplies</caption>
          <thead>
            <tr>
              <th scope="col">Supply</th>
              <th scope="col">Unit</th>
              <th scope="col" className="aiew-num">
                Cost
              </th>
              <th scope="col">Supplier</th>
              <th scope="col">Used by</th>
              {canManage ? (
                <th scope="col">
                  <span className="aiew-sr">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {active.map((supply) =>
              editing === supply.id ? (
                <tr key={supply.id} data-aiew-supply={supply.id}>
                  <td colSpan={6} data-cell="form">
                    <SupplyForm
                      title={`Edit ${supply.name}`}
                      initial={draftOf(supply)}
                      submitLabel="Save"
                      costHidden={supply.unitCost === null}
                      managed={supply.managedExternally}
                      onCancel={() => setEditing(null)}
                      onSubmit={async (draft) => {
                        const cost = parseMoneyInput(draft.cost);
                        const patch: Parameters<typeof transport.updateSupply>[1] = {
                          name: draft.name.trim(),
                          supplier: draft.supplier.trim() || null,
                          sku: draft.sku.trim() || null,
                          note: draft.note.trim() || null,
                        };
                        // A synced supply's cost and unit come from the host's own price
                        // list; the server refuses a change to either (review RL-02).
                        if (!supply.managedExternally) patch.unitType = draft.unitType;
                        if (supply.unitCost !== null && !supply.managedExternally) {
                          if (cost === null || Number.isNaN(cost)) return "Enter what it costs you, like 95.00.";
                          if (cost !== supply.unitCost) patch.unitCost = cost;
                        }
                        const res = await transport.updateSupply(supply.id, patch);
                        if (!res.ok) return adminErrorText(res.error);
                        onChanged(res.data.supply, res.data.affectedProducts);
                        setEditing(null);
                        setMessage({ tone: "ok", text: affectedText("Updated.", res.data.affectedProducts) });
                        return null;
                      }}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={supply.id} data-aiew-supply={supply.id}>
                  <td data-label="Supply" data-cell="name">
                    <strong>{supply.name}</strong>
                    {supply.managedExternally ? (
                      <span className="aiew-tag" style={{ display: "inline-block", marginInlineStart: 6 }} data-aiew-managed="">
                        Price from your list{supply.externalRef ? ` (${supply.externalRef})` : ""}
                      </span>
                    ) : null}
                    {supply.sku ? <span className="aiew-hint" style={{ display: "block" }}>SKU {supply.sku}</span> : null}
                    {supply.note ? <span className="aiew-hint" style={{ display: "block" }}>{supply.note}</span> : null}
                  </td>
                  <td data-label="Unit" data-cell="unit">{UNIT_LABEL[supply.unitType]}</td>
                  <td data-label="Cost" data-cell="cost" className="aiew-num">{supply.unitCost !== null ? formatMoney(supply.unitCost, currency, locale) : "—"}</td>
                  <td data-label="Supplier" data-cell="supplier">{supply.supplier ?? ""}</td>
                  <td data-label="Used by" data-cell="used">
                    {supply.usedBy.length === 0 ? "Not used" : `Used by ${supply.usedBy.length}`}
                    {supply.usedBy.length > 0 ? <span className="aiew-hint" style={{ display: "block" }}>{supply.usedBy.map((p) => p.name).join(", ")}</span> : null}
                  </td>
                  {canManage ? (
                    <td data-label="Actions" data-cell="actions">
                      <span className="aiew-row">
                        <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => setEditing(supply.id)}>
                          Edit
                        </button>
                        <button type="button" className="aiew-btn aiew-btn-danger-outline aiew-btn-sm" onClick={() => setRetiring(supply)}>
                          Retire
                        </button>
                      </span>
                    </td>
                  ) : null}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {retired.length > 0 ? (
        <details>
          <summary>Retired supplies ({retired.length})</summary>
          <ul className="aiew-plist">
            {retired.map((supply) => (
              <li key={supply.id} className="aiew-pitem">
                <span className="aiew-pitem-main">{supply.name}</span>
                {canManage ? (
                  <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => void restore(supply)}>
                    Restore
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {retiring ? (
        <Dialog title={`Retire ${retiring.name}?`} onClose={() => setRetiring(null)} data={{ "aiew-retire": retiring.id }}>
          <p>
            {retiring.usedBy.length > 0
              ? `Retiring this takes it out of ${retiring.usedBy.length} product${retiring.usedBy.length === 1 ? "'s price" : "s' prices"}: ${retiring.usedBy.map((p) => p.name).join(", ")}.`
              : "No product uses it, so no price changes."}{" "}
            You can restore it later.
          </p>
          <div className="aiew-actions">
            <button type="button" className="aiew-btn aiew-btn-danger" data-autofocus="" onClick={() => void retire(retiring)}>
              Retire it
            </button>
            <button type="button" className="aiew-btn aiew-btn-secondary" onClick={() => setRetiring(null)}>
              Keep it
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function SupplyForm({
  title,
  initial,
  submitLabel,
  costHidden,
  managed,
  onSubmit,
  onCancel,
  resetOnSave,
}: {
  title: string;
  initial: SupplyDraft;
  submitLabel: string;
  costHidden?: boolean;
  /** Its cost comes from the host's own price list: shown, not editable. */
  managed?: boolean;
  onSubmit: (draft: SupplyDraft) => Promise<string | null>;
  onCancel?: () => void;
  resetOnSave?: boolean;
}) {
  const ids = useId();
  const [draft, setDraft] = useState<SupplyDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof SupplyDraft>(key: K, value: SupplyDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) return setProblem("Name the supply.");
    setBusy(true);
    setProblem(null);
    const outcome = await onSubmit(draft);
    setBusy(false);
    if (outcome) return setProblem(outcome);
    if (resetOnSave) setDraft(initial);
  };
  return (
    <form className="aiew-sub-box" onSubmit={(event) => void submit(event)} noValidate data-aiew-supply-form={title}>
      <strong>{title}</strong>
      <div className="aiew-grid3">
        <Field id={`${ids}-name`} label="Name">
          <input id={`${ids}-name`} className="aiew-input" value={draft.name} maxLength={200} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field id={`${ids}-unit`} label="You buy it">
          <select id={`${ids}-unit`} className="aiew-input" value={draft.unitType} disabled={managed} onChange={(e) => set("unitType", e.target.value as UnitType)}>
            {UNIT_TYPES.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABEL[u]}
              </option>
            ))}
          </select>
        </Field>
        {costHidden ? null : managed ? (
          <Field id={`${ids}-cost`} label="It costs you ($)" hint="From your own price list. Change it in your own price list; the next sync brings it here.">
            <input id={`${ids}-cost`} className="aiew-input" value={draft.cost} readOnly aria-describedby={`${ids}-cost-hint`} />
          </Field>
        ) : (
          <Field id={`${ids}-cost`} label="It costs you ($)">
            <input id={`${ids}-cost`} className="aiew-input" inputMode="decimal" value={draft.cost} onChange={(e) => set("cost", e.target.value)} />
          </Field>
        )}
        <Field id={`${ids}-supplier`} label="Supplier" optional>
          <input id={`${ids}-supplier`} className="aiew-input" value={draft.supplier} maxLength={120} onChange={(e) => set("supplier", e.target.value)} />
        </Field>
        <Field id={`${ids}-sku`} label="SKU" optional>
          <input id={`${ids}-sku`} className="aiew-input" value={draft.sku} maxLength={80} onChange={(e) => set("sku", e.target.value)} />
        </Field>
        <Field id={`${ids}-note`} label="Note" optional hint='e.g. "Price as of Oct 2026"'>
          <input id={`${ids}-note`} className="aiew-input" value={draft.note} maxLength={500} aria-describedby={describedBy(`${ids}-note`, true, null)} onChange={(e) => set("note", e.target.value)} />
        </Field>
      </div>
      <div className="aiew-row">
        <button type="submit" className="aiew-btn aiew-btn-primary aiew-btn-sm" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <Outcome error={problem} />
      </div>
    </form>
  );
}

