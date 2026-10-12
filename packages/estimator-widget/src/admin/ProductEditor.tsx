import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CustomerFields } from "../fields.js";
import { formatMoney, formatPercent } from "../format.js";
import type { ClientError } from "../http.js";
import { ChevronIcon, describedBy, Field, Notice, useMounted } from "../parts.js";
import { PriceCard, type PriceState } from "../price.js";
import type { CustomerInputs, PricingBasis, RangeMode, RecipeKey, UnitType } from "../types.js";
import type { EstimatorAdminTransport } from "./client.js";
import {
  adminErrorText,
  bpToInput,
  centsToInput,
  configFor,
  milliToInput,
  parseMilliInput,
  parseMoneyInput,
  parseNumberInput,
  parsePercentInput,
  perPrimaryLabel,
  RECIPE_CATALOG,
  recipeInfoFor,
  UNIT_LABEL,
} from "./helpers.js";
import type {
  AdminOption,
  AdminProduct,
  EstimatorSettingsWire,
  PreviewResponse,
  ProductDraft,
  ProductInput,
  RecipeConfig,
  SupplyWire,
} from "./types.js";
import { Check, errorSummary, Outcome, Panel, Switch } from "./ui.js";

/**
 * The product editor (contract 9.7): how a price is BUILT from the owner's
 * own costs, and exactly what the customer is asked — previewed live, before
 * saving.
 *
 *   Basics              name, category, description, on the website, priced instantly
 *   How it's measured   the recipe and its settings, in plain labels
 *   Supplies            what goes into one (from the supplies library), how
 *                       many, and per what ("per ft of ramp", "once per job")
 *   Labor               hours per unit, setup hours, the hourly rate
 *   Price               waste, markup OR target margin, the minimum
 *   Range               from the measurement (+ contingency), or the older band
 *   Options             what the customer can choose, at a price they see
 *   Test a quote        what the customer is asked, what they see, and — for
 *                       those who may see costs — the cost breakdown and margin
 *
 * Basics through Range save together with one Save. Supplies and options save
 * as you go (each answers with the product). The preview asks the server: the
 * widget works nothing out.
 *
 * CONTRACT: 9.7 lists "What your customer sees" (3) and "Test a quote" (9) as
 * two sections built from the same `preview` call and the same
 * <CustomerFields>. They are ONE panel here, beside the editor: the questions
 * the customer is asked are also the test measurement, so the owner answers
 * once and sees the customer's price card and the cost breakdown together.
 */

export interface ProductEditorProps {
  product: AdminProduct | null;
  /** The supplies library; null when it couldn't be read (no access to costs). */
  supplies: SupplyWire[] | null;
  suppliesError: ClientError | null;
  settings: EstimatorSettingsWire | null;
  transport: EstimatorAdminTransport;
  locale: string;
  currency: string;
  onSaved: (product: AdminProduct) => void;
  onSupplyCreated: (supply: SupplyWire) => void;
  onClose: () => void;
}

/** The editor's own fields: numbers as numbers (null = empty, NaN = not a number yet). */
export interface ProductForm {
  name: string;
  category: string;
  description: string;
  showInEstimator: boolean;
  isEstimatable: boolean;
  recipe: RecipeKey;
  recipeConfig: RecipeConfig;
  allowMultiple: boolean;
  multipleLabel: string;
  maxQuantity: number | null;
  laborHoursPerUnitMilli: number | null;
  laborSetupHoursMilli: number | null;
  laborRateCents: number | null;
  wasteBp: number | null;
  pricingBasis: PricingBasis;
  markupBp: number | null;
  marginBp: number | null;
  minimumCharge: number | null;
  rangeMode: RangeMode;
  contingencyBp: number | null;
  estimateLowBp: number | null;
  estimateHighBp: number | null;
  basePrice: number | null;
  pricePerSqFt: number | null;
  pricePerLinearFt: number | null;
  laborCost: number | null;
}

export function formFromProduct(product: AdminProduct | null): ProductForm {
  const recipe: RecipeKey = product?.recipe ?? "ramp_over_steps";
  return {
    name: product?.name ?? "",
    category: product?.category ?? "",
    description: product?.description ?? "",
    // A new product starts OFF the website: "Create the product" comes before
    // its supplies can be added, and a product with none prices at $0. The
    // owner turns it on once it is priced (review EST-R01).
    showInEstimator: product?.showInEstimator ?? false,
    isEstimatable: product?.isEstimatable ?? true,
    recipe,
    recipeConfig: configFor(recipe, product?.recipeConfig),
    allowMultiple: product?.allowMultiple ?? false,
    multipleLabel: product?.multipleLabel ?? "",
    maxQuantity: product?.maxQuantity ?? 10,
    laborHoursPerUnitMilli: product?.labor.hoursPerUnitMilli ?? 0,
    laborSetupHoursMilli: product?.labor.setupHoursMilli ?? 0,
    laborRateCents: product?.labor.rateCents ?? null,
    // Null for someone without access to costs (the server strips them): the
    // fields are hidden then, and an update never sends them (review ADV-3).
    wasteBp: product ? product.wasteBp : 0,
    pricingBasis: product?.pricingBasis ?? "markup",
    markupBp: product ? product.markupBp : 0,
    marginBp: product ? product.marginBp : 0,
    minimumCharge: product?.minimumCharge ?? 0,
    rangeMode: product?.rangeMode ?? "measured",
    contingencyBp: product?.contingencyBp ?? null,
    estimateLowBp: product?.estimateLowBp ?? 9000,
    estimateHighBp: product?.estimateHighBp ?? 11500,
    basePrice: product?.lumpCosts?.basePrice ?? 0,
    pricePerSqFt: product?.lumpCosts?.pricePerSqFt ?? null,
    pricePerLinearFt: product?.lumpCosts?.pricePerLinearFt ?? null,
    laborCost: product?.lumpCosts?.laborCost ?? 0,
  };
}

/** A number the owner typed that isn't one yet. */
const bad = (n: number | null) => typeof n === "number" && Number.isNaN(n);

/** What stops a save, in one sentence, or null. Mirrors the server's limits; the server checks again. */
export function formProblem(form: ProductForm): string | null {
  if (!form.name.trim()) return "Give the product a name.";
  const numbers = [
    form.maxQuantity,
    form.laborHoursPerUnitMilli,
    form.laborSetupHoursMilli,
    form.laborRateCents,
    form.wasteBp,
    form.markupBp,
    form.marginBp,
    form.minimumCharge,
    form.contingencyBp,
    form.estimateLowBp,
    form.estimateHighBp,
    form.basePrice,
    form.pricePerSqFt,
    form.pricePerLinearFt,
    form.laborCost,
  ];
  if (numbers.some(bad) || Object.values(form.recipeConfig as unknown as Record<string, unknown>).some((v) => typeof v === "number" && Number.isNaN(v))) {
    return "Some numbers aren't numbers yet. Check the fields marked.";
  }
  if (form.pricingBasis === "margin" && (form.marginBp ?? 0) > 9500) return "A target margin can be at most 95%.";
  if (form.rangeMode === "percent" && (form.estimateLowBp ?? 0) > (form.estimateHighBp ?? 0)) return "The low end of the band can't be above the high end.";
  return null;
}

/**
 * Only what changed, for an update: a field the screen never showed (a labor
 * rate hidden from someone without access to costs reads as empty) is never
 * sent back as a change. A recipe change carries its settings with it.
 */
export function productPatch(base: ProductForm, form: ProductForm): Partial<ProductInput> {
  const before = productInputFromForm(base) as unknown as Record<string, unknown>;
  const after = productInputFromForm(form) as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(value) !== JSON.stringify(before[key])) patch[key] = value;
  }
  if ("recipe" in patch) patch.recipeConfig = after.recipeConfig;
  return patch as Partial<ProductInput>;
}

/** The form as the server's product input (create) or patch (update). */
export function productInputFromForm(form: ProductForm): ProductInput {
  return {
    name: form.name.trim(),
    category: form.category.trim() || null,
    description: form.description.trim() || null,
    showInEstimator: form.showInEstimator,
    isEstimatable: form.isEstimatable,
    recipe: form.recipe,
    recipeConfig: form.recipeConfig,
    allowMultiple: form.recipe === "count" ? false : form.allowMultiple,
    multipleLabel: form.multipleLabel.trim() || null,
    maxQuantity: form.maxQuantity ?? 10,
    laborHoursPerUnitMilli: form.laborHoursPerUnitMilli ?? 0,
    laborSetupHoursMilli: form.laborSetupHoursMilli ?? 0,
    laborRateCents: form.laborRateCents,
    wasteBp: form.wasteBp ?? 0,
    pricingBasis: form.pricingBasis,
    markupBp: form.markupBp ?? 0,
    marginBp: form.marginBp ?? 0,
    minimumCharge: form.minimumCharge ?? 0,
    rangeMode: form.rangeMode,
    contingencyBp: form.contingencyBp,
    estimateLowBp: form.estimateLowBp ?? 9000,
    estimateHighBp: form.estimateHighBp ?? 11500,
    basePrice: form.basePrice ?? 0,
    pricePerSqFt: form.pricePerSqFt,
    pricePerLinearFt: form.pricePerLinearFt,
    laborCost: form.laborCost ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Number fields the way an owner types them
// ---------------------------------------------------------------------------

type Kind = "money" | "percent" | "milli" | "plain";
const TO_TEXT: Record<Kind, (n: number | null) => string> = {
  money: (n) => centsToInput(n),
  percent: (n) => bpToInput(n),
  milli: (n) => milliToInput(n),
  plain: (n) => (n === null || Number.isNaN(n) ? "" : String(n)),
};
const PARSE: Record<Kind, (text: string) => number | null> = {
  money: parseMoneyInput,
  percent: parsePercentInput,
  milli: parseMilliInput,
  plain: parseNumberInput,
};

/** A number input that keeps what is typed and reports a number (null empty, NaN not yet a number). */
export function NumText({
  id,
  kind,
  value,
  onValue,
  hint,
  error,
  placeholder,
  disabled,
  label,
}: {
  id: string;
  kind: Kind;
  value: number | null;
  onValue: (value: number | null) => void;
  hint?: boolean;
  error?: string | null;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
}) {
  const [text, setText] = useState(TO_TEXT[kind](value));
  useEffect(() => {
    const parsed = PARSE[kind](text);
    const same = parsed === value || (parsed !== null && value !== null && Number.isNaN(parsed) && Number.isNaN(value));
    if (!same) setText(TO_TEXT[kind](value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const invalid = Boolean(error) || (text.trim() !== "" && Number.isNaN(PARSE[kind](text) as number));
  return (
    <input
      id={id}
      className="aiew-input aiew-number"
      inputMode="decimal"
      autoComplete="off"
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy(id, Boolean(hint), error)}
      onChange={(event) => {
        setText(event.target.value);
        onValue(PARSE[kind](event.target.value));
      }}
    />
  );
}

/** A labelled number field. */
function NumField({
  id,
  label,
  kind,
  value,
  onValue,
  hint,
  placeholder,
  optional,
}: {
  id: string;
  label: string;
  kind: Kind;
  value: number | null;
  onValue: (value: number | null) => void;
  hint?: string;
  placeholder?: string;
  optional?: boolean;
}) {
  const error = bad(value) ? "Enter a number." : null;
  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional}>
      <NumText id={id} kind={kind} value={value} onValue={onValue} hint={Boolean(hint)} error={error} placeholder={placeholder} />
    </Field>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  optional,
  maxLength = 300,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  optional?: boolean;
  maxLength?: number;
}) {
  return (
    <Field id={id} label={label} hint={hint} optional={optional}>
      <input id={id} className="aiew-input" value={value} maxLength={maxLength} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

export function ProductEditor(props: ProductEditorProps) {
  const { product, transport, currency, locale, settings } = props;
  const ids = useId();
  const mounted = useMounted();
  const [form, setForm] = useState<ProductForm>(() => formFromProduct(product));
  const [base, setBase] = useState<ProductForm>(() => formFromProduct(product));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedText, setSavedText] = useState("Saved");
  const [error, setError] = useState<ClientError | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const problem = formProblem(form);
  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const setConfig = (patch: Record<string, unknown>) => {
    setForm((current) => ({ ...current, recipeConfig: { ...(current.recipeConfig as unknown as Record<string, unknown>), ...patch } as unknown as RecipeConfig }));
    setSaved(false);
  };
  const changeRecipe = (recipe: RecipeKey) => {
    setForm((current) => ({
      ...current,
      recipe,
      // Back to the saved recipe: its saved settings. A new one: its defaults.
      recipeConfig: product && product.recipe === recipe ? configFor(recipe, product.recipeConfig) : configFor(recipe, null),
    }));
    setSaved(false);
  };

  const info = recipeInfoFor(form.recipe, product?.recipeInfo);
  const savedInfo = product ? recipeInfoFor(product.recipe, product.recipeInfo) : info;

  // ---- the live preview (400 ms after the last change) ----------------------
  const [testValues, setTestValues] = useState<CustomerInputs>({});
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<ClientError | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewId = useRef(0);
  // An existing product's preview gets only the unsaved edits, layered over
  // what's saved (contract 6.4); a new product's is the whole form.
  const draft: ProductDraft = useMemo(() => {
    if (product) return productPatch(base, form);
    const input = productInputFromForm(form);
    return { ...input, name: input.name || "New product" };
  }, [product, base, form]);
  const previewKey = JSON.stringify([product?.id ?? null, draft, testValues, product?.supplies, product?.options]);
  useEffect(() => {
    if (problem && problem !== "Give the product a name.") return;
    const id = ++previewId.current;
    setPreviewing(true);
    const timer = setTimeout(() => {
      const inputs: CustomerInputs = {};
      for (const [k, v] of Object.entries(testValues)) if (typeof v === "number") inputs[k] = v;
      void transport.preview({ productId: product?.id ?? null, draft, inputs }).then((res) => {
        if (id !== previewId.current || !mounted.current) return;
        setPreviewing(false);
        if (res.ok) {
          setPreview(res.data);
          setPreviewError(null);
        } else setPreviewError(res.error);
      });
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!dirty || busy || problem) return;
    setBusy(true);
    setError(null);
    const res = product ? await transport.updateProduct(product.id, productPatch(base, form)) : await transport.createProduct(productInputFromForm(form));
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setBase(form);
    setSaved(true);
    // The editor stays open on the new product (PriceBook keeps it mounted), so
    // the owner sees it worked and keeps the test answers (review EST-R14).
    setSavedText(product ? "Saved" : "Created");
    props.onSaved(res.data.product);
  };

  const fields = preview?.fields ?? product?.fields ?? [];
  const priceState: PriceState = !preview
    ? { status: "idle" }
    : preview.status === "priced" && preview.customerView
      ? { status: "priced", price: preview.customerView }
      : preview.status === "quote_only"
        ? { status: "quote_only" }
        : { status: "needs_inputs" };
  const supplyAmounts = new Map<string, number>();
  for (const line of preview?.breakdown?.lines ?? []) if (line.kind === "supply" && !supplyAmounts.has(line.label)) supplyAmounts.set(line.label, line.amount);
  const money = (cents: number) => formatMoney(cents, currency, locale);
  // Someone without access to costs gets the product with its waste, markup,
  // margin and labor rate stripped (null), and the settings without the
  // default labor rate: those fields are hidden, never shown as 0 (review ADV-3).
  const costsHidden = product ? product.markupBp === null || product.wasteBp === null : settings !== null && settings.defaultLaborRateCents === null;
  const defaultRate = settings?.defaultLaborRateCents ?? null;
  const rateHint =
    defaultRate !== null
      ? `Leave empty to use your default rate, ${money(defaultRate)} an hour, from Settings.`
      : "Leave empty to use your default rate from Settings.";
  // Hours with no rate anywhere price labor at $0, silently: a bigger error than
  // any range (review EST-R06). Said where the hours are typed.
  const laborHours = (form.laborHoursPerUnitMilli ?? 0) + (form.laborSetupHoursMilli ?? 0);
  const effectiveRate = form.laborRateCents ?? defaultRate;
  const laborFree = !costsHidden && !bad(form.laborRateCents) && laborHours > 0 && effectiveRate === 0;
  const testRef = useRef<HTMLElement | null>(null);
  const lumps = product?.lumpCosts;
  const showLumps = Boolean(lumps && (lumps.basePrice || lumps.pricePerSqFt || lumps.pricePerLinearFt || lumps.laborCost));

  return (
    <div className="aiew-stack" data-aiew-product-editor={product?.id ?? "new"}>
      <div className="aiew-admin-head">
        <button type="button" className="aiew-btn aiew-btn-link" onClick={props.onClose}>
          <ChevronIcon direction="left" />
          Back to products
        </button>
        {dirty ? <span className="aiew-dirty">Unsaved changes</span> : null}
      </div>
      <h3 className="aiew-admin-title">{product ? product.name : "New product"}</h3>
      <div className="aiew-editor">
        {/* Not a <form>: the supplies and options inside save as you go, and
            Enter in one of their fields must not save the rest. */}
        <div className="aiew-editor-main" data-aiew-product-form="">
          <Panel id="basics" title="Basics">
            <Field id={`${ids}-name`} label="Name" error={!form.name.trim() && dirty ? "Give the product a name." : null}>
              <input id={`${ids}-name`} className="aiew-input" value={form.name} maxLength={200} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <div className="aiew-grid2">
              <TextField id={`${ids}-cat`} label="Category" optional value={form.category} onChange={(v) => set("category", v)} maxLength={100} />
            </div>
            <Field id={`${ids}-desc`} label="Description" optional hint="One or two sentences the customer sees under the name.">
              <textarea id={`${ids}-desc`} className="aiew-input" rows={2} maxLength={2000} value={form.description} aria-describedby={`${ids}-desc-hint`} onChange={(e) => set("description", e.target.value)} />
            </Field>
            <Switch checked={form.showInEstimator} onChange={(v) => set("showInEstimator", v)} label="Show on your website" hint="Off: staff can still put it on an estimate." />
            <Switch
              checked={form.isEstimatable}
              onChange={(v) => set("isEstimatable", v)}
              label="Give an instant price"
              hint="Off: price by quote. The customer leaves their details and you call."
            />
          </Panel>

          <Panel id="measure" title="How it's measured" hint="What the customer is asked. They answer what they can count or measure; your settings do the rest.">
            <Field id={`${ids}-recipe`} label="Measured as" hint={info.description}>
              <select id={`${ids}-recipe`} className="aiew-input" value={form.recipe} aria-describedby={`${ids}-recipe-hint`} onChange={(e) => changeRecipe(e.target.value as RecipeKey)}>
                {(Object.keys(RECIPE_CATALOG) as RecipeKey[]).map((key) => (
                  <option key={key} value={key}>
                    {recipeInfoFor(key, product?.recipeInfo).label}
                  </option>
                ))}
              </select>
            </Field>
            {product && form.recipe !== product.recipe && product.supplies.length > 0 ? (
              <Notice tone="warn">
                A supply counted per something this way of measuring doesn&apos;t have (like &ldquo;per ft of ramp&rdquo;) has to come off the product first. If one does, saving will say which.
              </Notice>
            ) : null}
            <RecipeSettings ids={ids} recipe={form.recipe} config={form.recipeConfig} onChange={setConfig} />
            {form.recipe !== "count" ? (
              <div className="aiew-sub-box">
                <Switch
                  checked={form.allowMultiple}
                  onChange={(v) => set("allowMultiple", v)}
                  label="Customers can ask for more than one"
                  hint="Off for most jobs: one ramp per house. On for things people buy several of."
                />
                {form.allowMultiple ? (
                  <div className="aiew-grid2">
                    <TextField id={`${ids}-mlabel`} label="The question" optional hint={`Empty: "How many ${String((form.recipeConfig as { resultNoun?: { many?: string } }).resultNoun?.many ?? "items")}?"`} value={form.multipleLabel} onChange={(v) => set("multipleLabel", v)} maxLength={120} />
                    <NumField id={`${ids}-maxq`} label="Most they can ask for" kind="plain" value={form.maxQuantity} onValue={(v) => set("maxQuantity", v)} />
                  </div>
                ) : null}
              </div>
            ) : null}
          </Panel>

          {product ? (
            <SuppliesSection
              product={product}
              savedInfo={savedInfo}
              library={props.supplies}
              libraryError={props.suppliesError}
              amounts={supplyAmounts}
              money={money}
              transport={transport}
              onSaved={props.onSaved}
              onSupplyCreated={props.onSupplyCreated}
            />
          ) : (
            <Panel id="supplies" title="Supplies">
              <p className="aiew-muted">Save the product first, then add what goes into it from your supplies.</p>
            </Panel>
          )}

          <Panel id="labor" title="Labor">
            <div className="aiew-grid3">
              <NumField id={`${ids}-hours`} label={`Hours per ${perPrimaryLabel(info)}`} kind="milli" value={form.laborHoursPerUnitMilli} onValue={(v) => set("laborHoursPerUnitMilli", v)} />
              <NumField id={`${ids}-setup`} label="Setup hours (once per job)" kind="milli" hint="Loading, travel, setting up." value={form.laborSetupHoursMilli} onValue={(v) => set("laborSetupHoursMilli", v)} />
              {costsHidden ? null : (
                <NumField id={`${ids}-rate`} label="Hourly rate ($)" kind="money" optional hint={rateHint} value={form.laborRateCents} onValue={(v) => set("laborRateCents", v)} />
              )}
            </div>
            {laborFree ? (
              <Notice tone="warn" data="labor-zero">
                Your labor rate is $0, so this product&apos;s labor hours add nothing to its price. Set an hourly rate here, or a default rate in Settings.
              </Notice>
            ) : null}
          </Panel>

          <Panel id="price" title="Price">
            <div className="aiew-grid3">
              {costsHidden ? null : (
                <NumField id={`${ids}-waste`} label="Waste (%)" kind="percent" hint="Cut-offs and spares on what's bought by the foot or square foot." value={form.wasteBp} onValue={(v) => set("wasteBp", v)} />
              )}
              <NumField id={`${ids}-min`} label="Minimum charge ($)" kind="money" hint="No job is quoted for less." value={form.minimumCharge} onValue={(v) => set("minimumCharge", v)} />
            </div>
            {costsHidden ? (
              <p className="aiew-hint" data-aiew-costs-hidden="">
                Waste, markup and margin are hidden: you can see prices, not costs.
              </p>
            ) : (
              <>
                <fieldset className="aiew-stack-sm">
                  <legend className="aiew-label">Price by</legend>
                  <label className="aiew-check">
                    <input type="radio" name={`${ids}-basis`} checked={form.pricingBasis === "markup"} onChange={() => set("pricingBasis", "markup")} />
                    <span>Markup on cost</span>
                  </label>
                  <label className="aiew-check">
                    <input type="radio" name={`${ids}-basis`} checked={form.pricingBasis === "margin"} onChange={() => set("pricingBasis", "margin")} />
                    <span>Target margin</span>
                  </label>
                </fieldset>
                {form.pricingBasis === "markup" ? (
                  <NumField id={`${ids}-markup`} label="Markup (%)" kind="percent" hint="40% on a $100 cost prices it at $140." value={form.markupBp} onValue={(v) => set("markupBp", v)} />
                ) : (
                  <NumField id={`${ids}-margin`} label="Target margin (%)" kind="percent" hint="35% means 35 cents of every dollar charged is profit. Up to 95%." value={form.marginBp} onValue={(v) => set("marginBp", v)} />
                )}
              </>
            )}
            {showLumps ? (
              <div className="aiew-sub-box" data-aiew-lumps="">
                <strong>Other costs (from an older setup)</strong>
                <p className="aiew-hint">Flat amounts from before supplies. Set them to 0 once the supplies above cover them.</p>
                <div className="aiew-grid2">
                  <NumField id={`${ids}-base`} label="Base cost ($)" kind="money" value={form.basePrice} onValue={(v) => set("basePrice", v)} />
                  <NumField id={`${ids}-psf`} label="Cost per sq ft ($)" kind="money" optional value={form.pricePerSqFt} onValue={(v) => set("pricePerSqFt", v)} />
                  <NumField id={`${ids}-plf`} label="Cost per ft ($)" kind="money" optional value={form.pricePerLinearFt} onValue={(v) => set("pricePerLinearFt", v)} />
                  <NumField id={`${ids}-lc`} label="Labor, flat ($)" kind="money" value={form.laborCost} onValue={(v) => set("laborCost", v)} />
                </div>
              </div>
            ) : null}
          </Panel>

          <Panel id="range" title="Range" hint="Why a customer sees one price or a range.">
            <fieldset className="aiew-stack-sm">
              <legend className="aiew-sr">How the range is worked out</legend>
              <label className="aiew-check">
                <input type="radio" name={`${ids}-range`} checked={form.rangeMode === "measured"} onChange={() => set("rangeMode", "measured")} />
                <span>
                  <strong>From the measurement</strong>
                  <span className="aiew-hint" style={{ display: "block" }}>
                    We price the low and high ends of what the customer told us. An exact measurement gives one price.
                  </span>
                </span>
              </label>
              <label className="aiew-check">
                <input type="radio" name={`${ids}-range`} checked={form.rangeMode === "percent"} onChange={() => set("rangeMode", "percent")} />
                <span>
                  <strong>Percentage band (older)</strong>
                  <span className="aiew-hint" style={{ display: "block" }}>
                    A fixed band around the price, whatever the customer measured.
                  </span>
                </span>
              </label>
            </fieldset>
            {form.rangeMode === "measured" ? (
              <NumField
                id={`${ids}-cont`}
                label="Contingency (%)"
                kind="percent"
                optional
                hint={`Widens the range both ways. Empty uses your default${settings ? ` (${formatPercent(settings.contingencyBp)})` : ""} from Settings.`}
                value={form.contingencyBp}
                onValue={(v) => set("contingencyBp", v)}
              />
            ) : (
              <div className="aiew-grid2">
                <NumField id={`${ids}-low`} label="Low end (% of the price)" kind="percent" value={form.estimateLowBp} onValue={(v) => set("estimateLowBp", v)} />
                <NumField id={`${ids}-high`} label="High end (% of the price)" kind="percent" value={form.estimateHighBp} onValue={(v) => set("estimateHighBp", v)} />
              </div>
            )}
          </Panel>

          <div className="aiew-panel">
            <div className="aiew-panel-body">
              <div className="aiew-row">
                <button type="button" className="aiew-btn aiew-btn-primary" disabled={!dirty || busy || Boolean(problem)} aria-busy={busy || undefined} onClick={() => void save()} data-aiew-save-product="">
                  {busy ? "Saving…" : product ? "Save changes" : "Create the product"}
                </button>
                {dirty ? <span className="aiew-dirty">Unsaved changes</span> : null}
                <Outcome ok={saved && !dirty ? savedText : null} error={dirty && problem ? problem : error ? errorSummaryFull(error) : null} />
              </div>
            </div>
          </div>

          {product ? <OptionsSection product={product} money={money} transport={transport} onSaved={props.onSaved} /> : null}

          {/* On a phone the editor is one long column with Test a quote at the
              very bottom: this bar keeps the price (and, with access to costs,
              the margin) in sight while the owner edits (review EST-R08).
              Sticky to the bottom of the screen; hidden where the test panel
              sits beside the editor. */}
          <div className="aiew-sticky-price" data-aiew-sticky-price="">
            <span className="aiew-grow">{stickyText(preview, previewing, money)}</span>
            <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => testRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" })}>
              Test a quote
            </button>
          </div>
        </div>

        <aside className="aiew-editor-side" aria-label="Test a quote" ref={testRef}>
          <Panel id="test" title="Test a quote" hint="Answer as a customer would. This is exactly what they're asked, and what they see.">
            {fields.length > 0 ? <CustomerFields fields={fields} values={testValues} onChange={(next) => setTestValues(next)} /> : <p className="aiew-muted">No questions: priced per job.</p>}
            <PriceCard state={priceState} loading={previewing} locale={locale} label="What the customer sees" />
            {previewError ? <p className="aiew-danger-text" role="alert">{adminErrorText(previewError)}</p> : null}
            <Breakdown preview={preview} money={money} />
          </Panel>
        </aside>
      </div>
    </div>
  );
}

/** Every issue's message, so a refused save names what to fix. */
function errorSummaryFull(error: ClientError): string {
  if (error.code === "invalid" && error.issues && error.issues.length > 0) return error.issues.map((i) => i.message).join(" ");
  return errorSummary(error);
}

// ---------------------------------------------------------------------------
// The cost breakdown (staff with costs.view only)
// ---------------------------------------------------------------------------

/** The sticky bar's one line: the price and margin, what the customer sees, or what to do. */
function stickyText(preview: PreviewResponse | null, previewing: boolean, money: (cents: number) => string): string {
  if (!preview) return previewing ? "Working out the price…" : "Answer Test a quote to see the price.";
  if (preview.status === "quote_only") return "Priced by quote: customers leave their details.";
  if (preview.status !== "priced") return "Answer Test a quote to see the price.";
  if (preview.breakdown) return `Price ${money(preview.breakdown.point)} · Margin ${formatPercent(preview.breakdown.marginBp)}`;
  const view = preview.customerView;
  if (!view) return "Answer Test a quote to see the price.";
  return view.single ? `Customer sees ${money(view.low)}` : `Customer sees ${money(view.low)} – ${money(view.high)}`;
}

function Breakdown({ preview, money }: { preview: PreviewResponse | null; money: (cents: number) => string }) {
  if (!preview || preview.status !== "priced") return null;
  const breakdown = preview.breakdown;
  if (!breakdown) return <p className="aiew-hint" data-aiew-no-costs="">You can see prices here, not costs.</p>;
  return (
    <div className="aiew-stack-sm" data-aiew-breakdown="">
      <strong>Your cost and margin</strong>
      <div className="aiew-table-wrap">
        <table className="aiew-table">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col" className="aiew-num">
                How much
              </th>
              <th scope="col" className="aiew-num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {breakdown.lines.map((line, i) => (
              <tr key={`${i}:${line.label}`} data-kind={line.kind}>
                <td>{line.label}</td>
                <td className="aiew-num">
                  {line.quantity !== null ? `${line.quantity}${line.unit ? ` ${line.unit}` : ""}` : ""}
                  {line.unitCost !== null ? ` × ${money(line.unitCost)}` : ""}
                </td>
                <td className="aiew-num">{money(line.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Cost</td>
              <td />
              <td className="aiew-num" data-aiew-cost="">
                {money(breakdown.cost)}
              </td>
            </tr>
            <tr>
              <td>Price</td>
              <td />
              <td className="aiew-num" data-aiew-point="">
                {money(breakdown.point)}
              </td>
            </tr>
            <tr>
              <td>Margin</td>
              <td />
              <td className="aiew-num" data-aiew-margin="">
                {formatPercent(breakdown.marginBp)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {breakdown.minimumApplied ? <p className="aiew-tag aiew-tag-warn">Minimum charge applied</p> : null}
      {breakdown.lines.some((line) => (line.kind === "labor" || line.kind === "setup") && (line.quantity ?? 0) > 0 && line.unitCost === 0) ? (
        <Notice tone="warn" data="breakdown-labor-zero">
          Labor is priced at $0: set an hourly rate on the product or a default rate in Settings.
        </Notice>
      ) : null}
      <p className="aiew-hint">Lines are rounded to the cent; the price comes from the exact figures.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The recipe's settings, in plain labels
// ---------------------------------------------------------------------------

function RecipeSettings({ ids, recipe, config, onChange }: { ids: string; recipe: RecipeKey; config: RecipeConfig; onChange: (patch: Record<string, unknown>) => void }) {
  const c = config as unknown as Record<string, unknown>;
  const text = (key: string) => (typeof c[key] === "string" ? (c[key] as string) : "");
  const num = (key: string) => (typeof c[key] === "number" ? (c[key] as number) : null);
  const noun = (key: string) => (c[key] && typeof c[key] === "object" ? (c[key] as { one: string; many: string }) : { one: "", many: "" });
  const nullable = (v: string) => (v.trim() ? v : null);
  const nounFields = (key: string, label: string) => (
    <div className="aiew-grid2">
      <TextField id={`${ids}-${key}-one`} label={`${label} (one)`} value={noun(key).one} maxLength={40} onChange={(v) => onChange({ [key]: { ...noun(key), one: v } })} />
      <TextField id={`${ids}-${key}-many`} label={`${label} (more than one)`} value={noun(key).many} maxLength={40} onChange={(v) => onChange({ [key]: { ...noun(key), many: v } })} />
    </div>
  );

  if (recipe === "ramp_over_steps") {
    const h = (c.stepHeightIn as { typical: number; low: number; high: number } | undefined) ?? { typical: 7.5, low: 7, high: 8 };
    return (
      <div className="aiew-stack" data-aiew-recipe-settings={recipe}>
        <div className="aiew-sub-box">
          <strong>The questions</strong>
          <TextField id={`${ids}-sl`} label="Steps question" value={text("stepsLabel")} maxLength={120} onChange={(v) => onChange({ stepsLabel: v })} />
          <TextField id={`${ids}-sh`} label="Its help" optional value={text("stepsHelp")} onChange={(v) => onChange({ stepsHelp: nullable(v) })} />
          <TextField id={`${ids}-hl`} label="Step height question" value={text("stepHeightLabel")} maxLength={120} onChange={(v) => onChange({ stepHeightLabel: v })} />
          <TextField id={`${ids}-hh`} label="Its help" optional value={text("stepHeightHelp")} onChange={(v) => onChange({ stepHeightHelp: nullable(v) })} />
          <Check checked={c.allowTotalRise === true} onChange={(v) => onChange({ allowTotalRise: v })} label="Also let them give the total height instead" />
          {c.allowTotalRise === true ? (
            <>
              <TextField id={`${ids}-tl`} label="Total height question" value={text("totalRiseLabel")} maxLength={120} onChange={(v) => onChange({ totalRiseLabel: v })} />
              <TextField id={`${ids}-th`} label="Its help" optional value={text("totalRiseHelp")} onChange={(v) => onChange({ totalRiseHelp: nullable(v) })} />
            </>
          ) : null}
        </div>
        <div className="aiew-sub-box">
          <strong>When they don&apos;t give a height</strong>
          <p className="aiew-hint">We price at your typical step height and show the range from your low to your high, with a note asking them to measure one step.</p>
          <div className="aiew-grid3">
            <NumField id={`${ids}-ht`} label="Typical step height (in)" kind="plain" value={h.typical} onValue={(v) => onChange({ stepHeightIn: { ...h, typical: v } })} />
            <NumField id={`${ids}-hlo`} label="From (in)" kind="plain" value={h.low} onValue={(v) => onChange({ stepHeightIn: { ...h, low: v } })} />
            <NumField id={`${ids}-hhi`} label="To (in)" kind="plain" value={h.high} onValue={(v) => onChange({ stepHeightIn: { ...h, high: v } })} />
          </div>
          {/* A step height judged from a photo with no scale is a guess: the
              owner decides whether it moves the price, and it is always kept
              inside their own From–To (review EST-R10). */}
          <Check
            checked={c.usePhotoStepHeight !== false}
            onChange={(v) => onChange({ usePhotoStepHeight: v })}
            label="Use the step height from the photo, kept between your From and To. Off: a photo fills in the count only."
          />
        </div>
        <div className="aiew-grid3">
          <NumField id={`${ids}-slope`} label="Slope 1:" kind="plain" hint="12 is the ADA slope: 1 ft of ramp for every inch of rise." value={num("slopeRatio")} onValue={(v) => onChange({ slopeRatio: v })} />
          <NumField id={`${ids}-round`} label="Round the ramp up to whole … ft" kind="plain" hint="1 = whole feet; 0 = don't round." value={num("roundUpToFt")} onValue={(v) => onChange({ roundUpToFt: v })} />
          <NumField id={`${ids}-landing`} label="Resting landing every … in of rise" kind="plain" hint="ADA: 30." value={num("landingEveryRiseIn")} onValue={(v) => onChange({ landingEveryRiseIn: v })} />
          <NumField id={`${ids}-maxsteps`} label="Most steps" kind="plain" value={num("maxSteps")} onValue={(v) => onChange({ maxSteps: v })} />
        </div>
        <div className="aiew-grid2">
          <TextField id={`${ids}-ps`} label="What the photo should show" hint="The AI is told to look for this." value={text("photoSubject")} maxLength={80} onChange={(v) => onChange({ photoSubject: v })} />
          <TextField id={`${ids}-pt`} label="Photo tip" optional value={text("photoTip")} maxLength={120} onChange={(v) => onChange({ photoTip: nullable(v) })} />
        </div>
        {nounFields("resultNoun", "Call it a")}
      </div>
    );
  }

  if (recipe === "area") {
    const presets = (Array.isArray(c.presets) ? c.presets : []) as Array<{ label: string; width: number; length: number }>;
    const setPreset = (i: number, patch: Partial<{ label: string; width: number; length: number }>) =>
      onChange({ presets: presets.map((p, n) => (n === i ? { ...p, ...patch } : p)) });
    return (
      <div className="aiew-stack" data-aiew-recipe-settings={recipe}>
        <Field id={`${ids}-unit`} label="Measured in">
          <select id={`${ids}-unit`} className="aiew-input" value={text("unit") || "ft"} onChange={(e) => onChange({ unit: e.target.value })}>
            <option value="ft">Feet</option>
            <option value="in">Inches</option>
          </select>
        </Field>
        <div className="aiew-grid2">
          <TextField id={`${ids}-wl`} label="Width question" value={text("widthLabel")} maxLength={120} onChange={(v) => onChange({ widthLabel: v })} />
          <TextField id={`${ids}-ll`} label="Length question" value={text("lengthLabel")} maxLength={120} onChange={(v) => onChange({ lengthLabel: v })} />
        </div>
        <TextField id={`${ids}-ah`} label="Help" optional value={text("help")} onChange={(v) => onChange({ help: nullable(v) })} />
        <div className="aiew-sub-box" data-aiew-presets="">
          <strong>Common sizes</strong>
          <p className="aiew-hint">Customers can pick one instead of measuring. Up to 12.</p>
          {presets.map((preset, i) => (
            <div key={i} className="aiew-inline">
              <input className="aiew-input" aria-label={`Size ${i + 1} name`} value={preset.label} maxLength={60} onChange={(e) => setPreset(i, { label: e.target.value })} />
              <NumText id={`${ids}-pw-${i}`} kind="plain" label={`Size ${i + 1} width`} value={preset.width} onValue={(v) => setPreset(i, { width: v ?? 0 })} />
              <span aria-hidden="true">×</span>
              <NumText id={`${ids}-pl-${i}`} kind="plain" label={`Size ${i + 1} length`} value={preset.length} onValue={(v) => setPreset(i, { length: v ?? 0 })} />
              <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => onChange({ presets: presets.filter((_, n) => n !== i) })}>
                Remove
              </button>
            </div>
          ))}
          {presets.length < 12 ? (
            <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" style={{ justifySelf: "start" }} onClick={() => onChange({ presets: [...presets, { label: "", width: 0, length: 0 }] })}>
              Add a size
            </button>
          ) : null}
        </div>
        <div className="aiew-grid2">
          <NumField id={`${ids}-mw`} label="Widest they can enter" kind="plain" value={num("maxWidth")} onValue={(v) => onChange({ maxWidth: v })} />
          <NumField id={`${ids}-ml`} label="Longest they can enter" kind="plain" value={num("maxLength")} onValue={(v) => onChange({ maxLength: v })} />
        </div>
        {nounFields("resultNoun", "Call it a")}
      </div>
    );
  }

  if (recipe === "linear") {
    return (
      <div className="aiew-stack" data-aiew-recipe-settings={recipe}>
        <Field id={`${ids}-unit`} label="Measured in">
          <select id={`${ids}-unit`} className="aiew-input" value={text("unit") || "ft"} onChange={(e) => onChange({ unit: e.target.value })}>
            <option value="ft">Feet</option>
            <option value="in">Inches</option>
          </select>
        </Field>
        <TextField id={`${ids}-ll`} label="The question" value={text("lengthLabel")} maxLength={120} onChange={(v) => onChange({ lengthLabel: v })} />
        <TextField id={`${ids}-lh`} label="Help" optional value={text("help")} onChange={(v) => onChange({ help: nullable(v) })} />
        <NumField id={`${ids}-lm`} label="Longest they can enter" kind="plain" value={num("maxLength")} onValue={(v) => onChange({ maxLength: v })} />
        {nounFields("resultNoun", "Call it a")}
      </div>
    );
  }

  return (
    <div className="aiew-stack" data-aiew-recipe-settings={recipe}>
      <TextField id={`${ids}-cl`} label="The question" value={text("countLabel")} maxLength={120} onChange={(v) => onChange({ countLabel: v })} />
      <TextField id={`${ids}-ch`} label="Help" optional value={text("help")} onChange={(v) => onChange({ help: nullable(v) })} />
      {nounFields("noun", "What's counted")}
      <NumField id={`${ids}-cm`} label="Most they can enter" kind="plain" value={num("maxCount")} onValue={(v) => onChange({ maxCount: v })} />
      <div className="aiew-grid2">
        <TextField
          id={`${ids}-cps`}
          label="What the photo should show"
          optional
          hint="Leave empty and photos aren't read for this product."
          value={text("photoSubject")}
          maxLength={80}
          onChange={(v) => onChange({ photoSubject: nullable(v) })}
        />
        <TextField id={`${ids}-cpt`} label="Photo tip" optional value={text("photoTip")} maxLength={120} onChange={(v) => onChange({ photoTip: nullable(v) })} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplies on the product (save as you go)
// ---------------------------------------------------------------------------

function SuppliesSection({
  product,
  savedInfo,
  library,
  libraryError,
  amounts,
  money,
  transport,
  onSaved,
  onSupplyCreated,
}: {
  product: AdminProduct;
  savedInfo: ReturnType<typeof recipeInfoFor>;
  library: SupplyWire[] | null;
  libraryError: ClientError | null;
  amounts: Map<string, number>;
  money: (cents: number) => string;
  transport: EstimatorAdminTransport;
  onSaved: (product: AdminProduct) => void;
  onSupplyCreated: (supply: SupplyWire) => void;
}) {
  const ids = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (call: () => ReturnType<EstimatorAdminTransport["attachSupply"]>) => {
    setBusy(true);
    setError(null);
    const res = await call();
    setBusy(false);
    if (!res.ok) return setError(adminErrorText(res.error)), false;
    onSaved(res.data.product);
    return true;
  };
  const bases = savedInfo.bases;
  return (
    <Panel id="supplies" title="Supplies" hint={`What goes into one ${product.name.toLowerCase()}, from your supplies. Amounts are at the test measurement.`}>
      {product.supplies.length === 0 ? <p className="aiew-muted">No supplies yet.</p> : null}
      {product.supplies.map((s) => (
        <div key={s.assignmentId} className="aiew-supply-row" data-aiew-attachment={s.assignmentId}>
          <div className="aiew-field">
            <span className="aiew-label">{s.name}</span>
            <span className="aiew-hint">
              {s.unitCost !== null ? `${money(s.unitCost)} ${UNIT_LABEL[s.unitType]}` : UNIT_LABEL[s.unitType]}
            </span>
            {/* Posts and brackets are bought whole: 5.25 posts are 6 (review EST-R09). */}
            <Check checked={s.roundUp} disabled={busy} label="Bought whole (round up)" onChange={(v) => void run(() => transport.updateAttachment(product.id, s.assignmentId, { roundUp: v }))} />
          </div>
          <Field id={`${ids}-q-${s.assignmentId}`} label="How many">
            <QuantityInput
              id={`${ids}-q-${s.assignmentId}`}
              milli={s.quantityMilli}
              onCommit={(milli) => void run(() => transport.updateAttachment(product.id, s.assignmentId, { quantityMilli: milli }))}
            />
          </Field>
          <Field id={`${ids}-per-${s.assignmentId}`} label="Per">
            <select
              id={`${ids}-per-${s.assignmentId}`}
              className="aiew-input"
              value={s.per ?? ""}
              onChange={(e) => e.target.value && void run(() => transport.updateAttachment(product.id, s.assignmentId, { per: e.target.value }))}
            >
              {s.per === null ? <option value="">{s.perLabel || "As before (by its unit)"}</option> : null}
              {bases.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.label}
                </option>
              ))}
            </select>
          </Field>
          <span className="aiew-supply-amount" data-aiew-supply-amount={s.assignmentId}>
            {amounts.has(s.name) ? money(amounts.get(s.name)!) : "—"}
          </span>
          <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" disabled={busy} onClick={() => void run(() => transport.removeAttachment(product.id, s.assignmentId))} aria-label={`Remove ${s.name}`}>
            Remove
          </button>
        </div>
      ))}
      {libraryError ? (
        <Notice tone="info" data="no-library">
          {adminErrorText(libraryError)}
        </Notice>
      ) : (
        <AddSupply
          ids={ids}
          library={library ?? []}
          bases={bases}
          busy={busy}
          transport={transport}
          onSupplyCreated={onSupplyCreated}
          onAttach={(body) => run(() => transport.attachSupply(product.id, body))}
          setError={setError}
        />
      )}
      {error ? (
        <p className="aiew-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}

function QuantityInput({ id, milli, onCommit }: { id: string; milli: number; onCommit: (milli: number) => void }) {
  const [text, setText] = useState(milliToInput(milli));
  useEffect(() => setText(milliToInput(milli)), [milli]);
  return (
    <input
      id={id}
      className="aiew-input"
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const next = parseMilliInput(text);
        if (next !== null && !Number.isNaN(next) && next > 0 && next !== milli) onCommit(next);
        else setText(milliToInput(milli));
      }}
    />
  );
}

const UNIT_TYPES: UnitType[] = ["per_linear_ft", "per_sqft", "per_unit", "flat"];

function AddSupply({
  ids,
  library,
  bases,
  busy,
  transport,
  onSupplyCreated,
  onAttach,
  setError,
}: {
  ids: string;
  library: SupplyWire[];
  bases: Array<{ key: string; label: string }>;
  busy: boolean;
  transport: EstimatorAdminTransport;
  onSupplyCreated: (supply: SupplyWire) => void;
  onAttach: (body: { supplyId: string; quantityMilli: number; per: string; roundUp: boolean }) => Promise<boolean>;
  setError: (message: string | null) => void;
}) {
  const [supplyId, setSupplyId] = useState("");
  const [qty, setQty] = useState("1");
  const [per, setPer] = useState(bases[0]?.key ?? "job");
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState<UnitType>("per_unit");
  const [newCost, setNewCost] = useState("");
  const active = library.filter((s) => s.isActive);
  const creating = supplyId === "__new";
  // "Bought whole" follows how the supply is sold: on for one sold each, off
  // for one sold by the foot. The owner can change it either way.
  const pickedUnit = creating ? newUnit : active.find((s) => s.id === supplyId)?.unitType ?? null;
  const [roundUp, setRoundUp] = useState(false);
  useEffect(() => {
    setRoundUp(pickedUnit === "per_unit");
  }, [pickedUnit]);
  useEffect(() => {
    if (!bases.some((b) => b.key === per)) setPer(bases[0]?.key ?? "job");
  }, [bases, per]);

  const add = async () => {
    const quantityMilli = parseMilliInput(qty);
    if (quantityMilli === null || Number.isNaN(quantityMilli) || quantityMilli <= 0) return setError("Enter how many, like 1 or 0.25.");
    let id = supplyId;
    if (creating) {
      const cost = parseMoneyInput(newCost);
      if (!newName.trim()) return setError("Name the new supply.");
      if (cost === null || Number.isNaN(cost) || cost < 0) return setError("Enter what the supply costs you, like 95.00.");
      const res = await transport.createSupply({ name: newName.trim(), unitType: newUnit, unitCost: cost });
      if (!res.ok) return setError(adminErrorText(res.error));
      onSupplyCreated(res.data.supply);
      id = res.data.supply.id;
    }
    if (!id) return setError("Pick a supply.");
    const ok = await onAttach({ supplyId: id, quantityMilli, per, roundUp });
    if (ok) {
      setSupplyId("");
      setQty("1");
      setNewName("");
      setNewCost("");
    }
  };

  return (
    <div className="aiew-sub-box" data-aiew-add-supply="">
      <strong>Add a supply</strong>
      <div className="aiew-grid3">
        <Field id={`${ids}-pick`} label="Supply">
          <select id={`${ids}-pick`} className="aiew-input" value={supplyId} onChange={(e) => setSupplyId(e.target.value)}>
            <option value="">Pick one…</option>
            {active.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="__new">+ New supply</option>
          </select>
        </Field>
        <Field id={`${ids}-aq`} label="How many">
          <input id={`${ids}-aq`} className="aiew-input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field id={`${ids}-aper`} label="Per">
          <select id={`${ids}-aper`} className="aiew-input" value={per} onChange={(e) => setPer(e.target.value)}>
            {bases.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {creating ? (
        <div className="aiew-grid3" data-aiew-new-supply="">
          <Field id={`${ids}-nn`} label="New supply's name">
            <input id={`${ids}-nn`} className="aiew-input" value={newName} maxLength={200} onChange={(e) => setNewName(e.target.value)} />
          </Field>
          <Field id={`${ids}-nu`} label="You buy it">
            <select id={`${ids}-nu`} className="aiew-input" value={newUnit} onChange={(e) => setNewUnit(e.target.value as UnitType)}>
              {UNIT_TYPES.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABEL[u]}
                </option>
              ))}
            </select>
          </Field>
          <Field id={`${ids}-nc`} label="It costs you ($)">
            <input id={`${ids}-nc`} className="aiew-input" inputMode="decimal" value={newCost} onChange={(e) => setNewCost(e.target.value)} />
          </Field>
        </div>
      ) : null}
      <Check checked={roundUp} onChange={setRoundUp} label="Bought whole (round up)" />
      <button type="button" className="aiew-btn aiew-btn-secondary" style={{ justifySelf: "start" }} disabled={busy} onClick={() => void add()}>
        Add supply
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Options (save as you go)
// ---------------------------------------------------------------------------

function OptionsSection({
  product,
  money,
  transport,
  onSaved,
}: {
  product: AdminProduct;
  money: (cents: number) => string;
  transport: EstimatorAdminTransport;
  onSaved: (product: AdminProduct) => void;
}) {
  const ids = useId();
  const [error, setError] = useState<string | null>(null);
  const [newOption, setNewOption] = useState("");
  const run = async (call: () => ReturnType<EstimatorAdminTransport["createOption"]>) => {
    setError(null);
    const res = await call();
    if (!res.ok) return setError(adminErrorText(res.error)), false;
    onSaved(res.data.product);
    return true;
  };
  return (
    <Panel id="options" title="Options" hint={'Choices the customer makes, like "Surface" or "Layout". A value\'s price is added as shown: "+$120" is $120 more.'}>
      {product.options.length === 0 ? <p className="aiew-muted">No options.</p> : null}
      {product.options.map((option) => (
        <OptionEditor key={option.id} option={option} money={money} run={run} transport={transport} />
      ))}
      <div className="aiew-inline">
        <label className="aiew-sr" htmlFor={`${ids}-new`}>
          New option name
        </label>
        <input id={`${ids}-new`} className="aiew-input aiew-grow" placeholder="New option, e.g. Surface" value={newOption} maxLength={120} onChange={(e) => setNewOption(e.target.value)} />
        <button
          type="button"
          className="aiew-btn aiew-btn-secondary"
          onClick={() => {
            if (!newOption.trim()) return setError("Name the option.");
            void run(() => transport.createOption(product.id, { name: newOption.trim() })).then((ok) => ok && setNewOption(""));
          }}
        >
          Add an option
        </button>
      </div>
      {error ? (
        <p className="aiew-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}

type Run = (call: () => ReturnType<EstimatorAdminTransport["createOption"]>) => Promise<boolean>;

function OptionEditor({ option, money, run, transport }: { option: AdminOption; money: (cents: number) => string; run: Run; transport: EstimatorAdminTransport }) {
  const ids = useId();
  const [name, setName] = useState(option.name);
  useEffect(() => setName(option.name), [option.name]);
  const [label, setLabel] = useState("");
  const [modifier, setModifier] = useState("");
  const values = option.values;
  const move = (i: number, delta: number) => {
    const a = values[i];
    const b = values[i + delta];
    if (!a || !b) return;
    void run(() => transport.updateOptionValue(a.id, { sortOrder: b.sortOrder === a.sortOrder ? (i + delta) * 10 : b.sortOrder })).then(
      (ok) => ok && void run(() => transport.updateOptionValue(b.id, { sortOrder: b.sortOrder === a.sortOrder ? i * 10 : a.sortOrder })),
    );
  };
  return (
    <div className="aiew-option" data-aiew-option={option.id}>
      <div className="aiew-inline">
        <label className="aiew-label" htmlFor={`${ids}-name`}>
          Option
        </label>
        <input
          id={`${ids}-name`}
          className="aiew-input aiew-grow"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== option.name && void run(() => transport.updateOption(option.id, { name: name.trim() }))}
        />
        <Check checked={!option.showInEstimator} onChange={(staffOnly) => void run(() => transport.updateOption(option.id, { showInEstimator: !staffOnly }))} label="Staff only" />
        <button type="button" className="aiew-btn aiew-btn-danger-outline aiew-btn-sm" onClick={() => void run(() => transport.removeOption(option.id))}>
          Remove option
        </button>
      </div>
      <fieldset className="aiew-stack-sm">
        <legend className="aiew-hint">Values (the one picked by default is marked)</legend>
        {values.map((value, i) => (
          <ValueRow key={value.id} groupName={`${ids}-default`} value={value} index={i} count={values.length} money={money} run={run} transport={transport} onMove={move} />
        ))}
      </fieldset>
      <div className="aiew-inline">
        <label className="aiew-sr" htmlFor={`${ids}-vl`}>
          New value
        </label>
        <input id={`${ids}-vl`} className="aiew-input aiew-grow" placeholder="New value, e.g. Heavy-duty grit" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
        <label className="aiew-sr" htmlFor={`${ids}-vm`}>
          Its price ($)
        </label>
        <input id={`${ids}-vm`} className="aiew-input aiew-number" placeholder="+$" inputMode="decimal" value={modifier} onChange={(e) => setModifier(e.target.value)} />
        <button
          type="button"
          className="aiew-btn aiew-btn-secondary aiew-btn-sm"
          onClick={() => {
            const cents = parseMoneyInput(modifier) ?? 0;
            if (!label.trim() || Number.isNaN(cents)) return;
            void run(() => transport.createOptionValue(option.id, { label: label.trim(), priceModifier: cents, isDefault: values.length === 0 })).then((ok) => {
              if (ok) {
                setLabel("");
                setModifier("");
              }
            });
          }}
        >
          Add value
        </button>
      </div>
    </div>
  );
}

function ValueRow({
  groupName,
  value,
  index,
  count,
  money,
  run,
  transport,
  onMove,
}: {
  groupName: string;
  value: AdminOption["values"][number];
  index: number;
  count: number;
  money: (cents: number) => string;
  run: Run;
  transport: EstimatorAdminTransport;
  onMove: (i: number, delta: number) => void;
}) {
  const ids = useId();
  const [label, setLabel] = useState(value.label);
  const [price, setPrice] = useState(centsToInput(value.priceModifier));
  useEffect(() => setLabel(value.label), [value.label]);
  useEffect(() => setPrice(centsToInput(value.priceModifier)), [value.priceModifier]);
  return (
    <div className="aiew-value-row" data-aiew-value={value.id}>
      <label className="aiew-radio" title="Picked by default">
        <input type="radio" name={groupName} checked={value.isDefault} aria-label={`${value.label}: picked by default`} onChange={() => void run(() => transport.setDefaultOptionValue(value.id))} />
      </label>
      <input
        className="aiew-input"
        aria-label="Value"
        value={label}
        maxLength={120}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label.trim() && label.trim() !== value.label && void run(() => transport.updateOptionValue(value.id, { label: label.trim() }))}
      />
      <span className="aiew-inline">
        <label className="aiew-sr" htmlFor={`${ids}-p`}>
          Price for {value.label} ($)
        </label>
        <input
          id={`${ids}-p`}
          className="aiew-input aiew-number"
          inputMode="decimal"
          value={price}
          title={`+${money(value.priceModifier)}`}
          onChange={(e) => setPrice(e.target.value)}
          onBlur={() => {
            const cents = parseMoneyInput(price) ?? 0;
            if (!Number.isNaN(cents) && cents !== value.priceModifier) void run(() => transport.updateOptionValue(value.id, { priceModifier: cents }));
          }}
        />
      </span>
      <button type="button" className="aiew-btn aiew-btn-secondary aiew-icon-btn" aria-label={`Move ${value.label} up`} disabled={index === 0} onClick={() => onMove(index, -1)}>
        <ChevronIcon direction="up" />
      </button>
      <button type="button" className="aiew-btn aiew-btn-secondary aiew-icon-btn" aria-label={`Move ${value.label} down`} disabled={index === count - 1} onClick={() => onMove(index, 1)}>
        <ChevronIcon direction="down" />
      </button>
      <button type="button" className="aiew-btn aiew-btn-danger-outline aiew-btn-sm" aria-label={`Remove ${value.label}`} onClick={() => void run(() => transport.removeOptionValue(value.id))}>
        Remove
      </button>
    </div>
  );
}

/** Used by the section header: a short reminder of the saved recipe. */
export function recipeLabel(recipe: RecipeKey, info?: AdminProduct["recipeInfo"]): ReactNode {
  return recipeInfoFor(recipe, info).label;
}
