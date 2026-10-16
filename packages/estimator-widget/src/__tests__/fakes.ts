import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EstimatorAdminTransport } from "../admin/client.js";
import type {
  AdminProduct,
  AdminStatus,
  EstimateDetail,
  EstimateLineWire,
  EstimatorSettingsWire,
  KeyWire,
  PreviewResponse,
  SupplyWire,
} from "../admin/types.js";
import type { EstimatorPublicTransport } from "../client.js";
import type { ClientError, Result } from "../http.js";
import type { CustomerField, PublicConfig, PublicPrice, PublicProduct, PublicQuote, TakeoffReading, WireErrorCode } from "../types.js";

/**
 * Fake transports for the component tests: every call is recorded, every
 * answer is scripted per test, and nothing touches the network. They stand
 * exactly where a host's own transport (tRPC, a server action) would.
 * (The shape of scheduling-widget's fakes, copied.)
 *
 * The fixtures are the contract's Summit Ramps (section 0 / 4.5): the sample
 * ramp's three questions word for word, and the prices 4.5's table gives.
 */

export const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
export const fail = (code: WireErrorCode | "network" | "bad_response", message: string = code, extra: Partial<ClientError> = {}): Result<never> => ({
  ok: false,
  error: { code, message, status: code === "network" ? 0 : code === "forbidden" ? 403 : code === "not_found" ? 404 : 409, ...extra },
});

export interface Call {
  method: string;
  args: unknown[];
}

/** A transport whose every method records its call and answers from `handlers` (or "no fake"). */
function recording<T extends object>(handlers: Partial<Record<keyof T, (...args: never[]) => unknown>>) {
  const calls: Call[] = [];
  const transport = new Proxy({} as T, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      const handler = handlers[prop as keyof T] as ((...args: unknown[]) => unknown) | undefined;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return Promise.resolve(handler ? handler(...args) : fail("internal", `no fake for ${String(prop)}`));
      };
    },
  });
  return { transport, calls, of: (method: string) => calls.filter((c) => c.method === method) };
}

export type PublicHandlers = Partial<{ [K in keyof EstimatorPublicTransport]: (...args: Parameters<EstimatorPublicTransport[K]>) => unknown }>;
export type AdminHandlers = Partial<{ [K in keyof EstimatorAdminTransport]: (...args: Parameters<EstimatorAdminTransport[K]>) => unknown }>;

export function fakePublic(handlers: PublicHandlers) {
  return recording<EstimatorPublicTransport>(handlers as never);
}

export function fakeAdmin(handlers: AdminHandlers) {
  return recording<EstimatorAdminTransport>({ status: () => ok(STATUS), getSettings: () => ok({ settings: settingsWire() }), ...handlers } as never);
}

// ---------------------------------------------------------------------------
// Summit Ramps: the public side
// ---------------------------------------------------------------------------

/** Contract 3.3's ramp fields, exactly as the server sends them. */
export const RAMP_FIELDS: CustomerField[] = [
  {
    key: "steps",
    kind: "stepper",
    label: "How many steps go up to the door?",
    help: "Count every step up, including the last one onto the porch or landing: 2 steps and the porch is 3.",
    required: true,
    min: 1,
    max: 20,
    presentation: "primary",
  },
  {
    key: "stepHeightIn",
    kind: "number",
    label: "Height of one step (optional)",
    help: "Measure from the top of one step to the top of the next.",
    required: false,
    min: 3,
    max: 12,
    step: 0.25,
    unit: "in",
    placeholder: "e.g. 7.5",
    presentation: "primary",
  },
  {
    key: "totalRiseIn",
    kind: "number",
    label: "Or the total height, ground to door threshold (optional)",
    help: "If you measured the whole height instead, enter it here.",
    required: false,
    min: 3,
    max: 360,
    step: 0.25,
    unit: "in",
    placeholder: null,
    presentation: "secondary",
  },
];

export const RAMP: PublicProduct = {
  id: "p-ramp",
  name: "Modular aluminum ramp",
  category: "Ramps",
  description: "An ADA-sloped aluminum ramp with handrails both sides, a top landing, permit and delivery.",
  recipe: "ramp_over_steps",
  fields: RAMP_FIELDS,
  quantity: null,
  isEstimatable: true,
  photo: { reading: true, tip: "Stand to the side so every step shows." },
  options: [
    {
      id: "o-surface",
      name: "Surface",
      values: [
        { id: "v-std", label: "Standard grit", priceModifier: 0, isDefault: true },
        { id: "v-hd", label: "Heavy-duty grit", priceModifier: 12000, isDefault: false },
      ],
    },
  ],
  measurementMode: "linear",
};

export const PAD: PublicProduct = {
  id: "p-pad",
  name: "Concrete landing pad",
  category: "Concrete",
  description: "A poured pad at the bottom of a ramp or by a door.",
  recipe: "area",
  fields: [
    {
      key: "preset",
      kind: "choice",
      label: "Pick a common size",
      help: null,
      required: false,
      presentation: "primary",
      choices: [
        { value: "0", label: "4 × 4 ft", sets: { width: 4, length: 4 } },
        { value: "1", label: "5 × 5 ft", sets: { width: 5, length: 5 } },
      ],
    },
    { key: "width", kind: "number", label: "Width", help: null, required: true, min: 0.5, max: 1000, step: 0.5, unit: "ft", placeholder: null, presentation: "primary" },
    { key: "length", kind: "number", label: "Length", help: null, required: true, min: 0.5, max: 1000, step: 0.5, unit: "ft", placeholder: null, presentation: "primary" },
  ],
  quantity: { label: "How many pads?", max: 5 },
  isEstimatable: true,
  photo: { reading: false, tip: null },
  options: [],
  measurementMode: "area",
};

export const SOMETHING_ELSE: PublicProduct = {
  id: "p-else",
  name: "Something else",
  category: "Ramps",
  description: "Platform lifts, multi-level access or anything unusual: we'll call to talk it through.",
  recipe: "count",
  fields: [],
  quantity: null,
  isEstimatable: false,
  photo: { reading: false, tip: null },
  options: [],
  measurementMode: "unit",
};

export const CONFIG: PublicConfig = {
  businessName: "Summit Ramps",
  contactEmail: "office@summit.test",
  contactPhone: "(801) 555-0143",
  currency: "USD",
  locale: "en-US",
  timeZone: "America/Denver",
  brandColor: null,
  instantEstimatesEnabled: true,
  photos: { attach: true, reading: true, maxEdgePx: 768, maxBytes: 600_000, jpegQuality: 0.8 },
  emailsEnabled: true,
  minFillMs: 0,
  products: [RAMP, PAD, SOMETHING_ELSE],
  logoUrl: null,
};

/** "3 steps, height unknown": contract 3.3 / 4.5, word for word and to the cent. */
export const PRICE_ASSUMED: PublicPrice = {
  low: 644_396,
  high: 716_352,
  single: false,
  currency: "USD",
  explanation: ["3 steps × 7–8 in each (estimated) = 21–24 in rise", "ADA 1:12 slope (1 ft of ramp per inch of rise) → 21–24 ft of ramp"],
  assumption: "Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.",
  resultPhrase: "That's about a 21–24 ft ramp.",
  reasons: ["Step height 7–8 in (estimated)"],
  taxNote: "Plus 7.25% sales tax.",
};

/** "3 steps × 7.5 in": one number. */
export const PRICE_MEASURED: PublicPrice = {
  low: 692_367,
  high: 692_367,
  single: true,
  currency: "USD",
  explanation: ["3 steps × 7.5 in = 22.5 in rise", "ADA 1:12 slope (1 ft of ramp per inch of rise) → 23 ft of ramp (rounded up to whole feet)"],
  assumption: null,
  resultPhrase: "That's about a 23-ft ramp.",
  reasons: [],
  taxNote: "Plus 7.25% sales tax.",
};

export const READING: TakeoffReading = {
  takeoffId: "tk_porch",
  recipe: "ramp_over_steps",
  status: "read",
  confidence: "medium",
  seen: true,
  suggested: { steps: 3 },
  heightRangeIn: { low: 7.5, high: 8.5 },
  lowConfidence: false,
  usable: true,
  lines: ["We counted 3 steps up, including the last one onto the porch or landing.", "Each step looks about 7.5–8.5 in tall.", "You can change the count if it's wrong."],
  fewerCheck: "Did you count the step up onto the porch or landing? 2 steps and the porch is 3.",
};

export function quote(extra: Partial<PublicQuote> = {}): PublicQuote {
  return {
    status: "open",
    estimateId: "est_1",
    number: "EST-0001",
    businessName: "Summit Ramps",
    contactEmail: "office@summit.test",
    contactPhone: "(801) 555-0143",
    brandColor: null,
    currency: "USD",
    locale: "en-US",
    timeZone: "America/Denver",
    customerName: "Pat Lee",
    jobAddress: "12 Elm St, Salt Lake City",
    message: "Thanks for having us out.",
    footer: "Price includes installation and haul-away.",
    sentAt: "2026-11-02T15:00:00.000Z",
    validUntil: "2026-12-02T15:00:00.000Z",
    respondedAt: null,
    responseName: null,
    lines: [
      { description: "Modular aluminum ramp", details: ["4 steps, 7.25 in each", "Surface: Standard grit"], quantity: 1, total: 836_280 },
      { description: "Remove old wooden steps", details: [], quantity: 1, total: 15_000 },
    ],
    subtotal: 851_280,
    discount: 0,
    taxRateBp: 725,
    taxAmount: 61_718,
    total: 912_998,
    canRespond: true,
    version: 1,
    logoUrl: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Summit Ramps: the staff side
// ---------------------------------------------------------------------------

export const STATUS: AdminStatus = {
  settingsSaved: true,
  products: { active: 5, public: 4 },
  keys: { active: 1, withoutOrigins: 0 },
  delivery: { emails: true, followUps: true, note: null },
  photos: { attach: true, reading: true },
  spend: { readingsToday: 12, costTodayMicros: 12_000, readingsMonth: 214, costMonthMicros: 240_000, dailyBudgetCents: 100 },
  embedBaseUrl: "https://summitramps.test/api/estimator",
  notices: [],
  aiBudgetCeilingCents: null,
};

export function settingsWire(extra: Partial<EstimatorSettingsWire> = {}): EstimatorSettingsWire {
  return {
    businessName: "Summit Ramps",
    contactEmail: "office@summit.test",
    contactPhone: "(801) 555-0143",
    leadNotifyEmails: ["office@summit.test"],
    currency: "USD",
    locale: "en-US",
    timeZone: "America/Denver",
    taxRateBp: 725,
    quoteValidDays: 30,
    followUpDays: 3,
    quoteFooter: null,
    defaultLaborRateCents: 6500,
    contingencyBp: 0,
    instantEstimatesEnabled: true,
    photosEnabled: true,
    aiDailyBudgetCents: 100,
    aiPerRequesterDaily: 5,
    brandColor: null,
    sampleLoadedAt: null,
    saved: true,
    updatedAt: "2026-11-02T15:00:00.000Z",
    managedByCompany: null,
    aiBudgetCeilingCents: null,
    alertRecipients: null,
    ...extra,
  };
}

export function supply(extra: Partial<SupplyWire> = {}): SupplyWire {
  return {
    id: "s-handrail",
    name: "Handrail",
    unitType: "per_linear_ft",
    unitCost: 1800,
    supplier: "Your supplier",
    sku: null,
    note: "Sample price: change it to yours.",
    isActive: true,
    usedBy: [
      { id: "p-ramp", name: "Modular aluminum ramp" },
      { id: "p-rail", name: "Handrail only" },
    ],
    externalRef: null,
    managedExternally: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

export function adminRamp(extra: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: "p-ramp",
    name: "Modular aluminum ramp",
    category: "Ramps",
    description: "An ADA-sloped aluminum ramp.",
    recipe: "ramp_over_steps",
    recipeInfo: {
      key: "ramp_over_steps",
      label: "Steps up to a door (ramp)",
      description: "Customers count the steps up to their door.",
      primaryKey: "rampFt",
      bases: [
        { key: "rampFt", label: "per ft of ramp" },
        { key: "landings", label: "per resting landing" },
        { key: "item", label: "per item" },
        { key: "job", label: "once per job" },
      ],
      photoReading: true,
    },
    recipeConfig: {
      stepsLabel: "How many steps go up to the door?",
      stepsHelp: "Count every step up, including the last one onto the porch or landing: 2 steps and the porch is 3.",
      stepHeightLabel: "Height of one step (optional)",
      stepHeightHelp: "Measure from the top of one step to the top of the next.",
      allowTotalRise: true,
      totalRiseLabel: "Or the total height, ground to door threshold (optional)",
      totalRiseHelp: "If you measured the whole height instead, enter it here.",
      stepHeightIn: { typical: 7.5, low: 7, high: 8 },
      usePhotoStepHeight: true,
      slopeRatio: 12,
      roundUpToFt: 1,
      landingEveryRiseIn: 30,
      maxSteps: 20,
      photoSubject: "the steps up to the door",
      photoTip: "Stand to the side so every step shows.",
      resultNoun: { one: "ramp", many: "ramps" },
    },
    fields: RAMP_FIELDS,
    allowMultiple: false,
    multipleLabel: null,
    maxQuantity: 10,
    supplies: [
      { assignmentId: "a-section", supplyId: "s-section", name: "Aluminum ramp section", unitType: "per_linear_ft", unitCost: 9500, quantityMilli: 1000, per: "rampFt", perLabel: "per ft of ramp", sortOrder: 0, roundUp: false },
      { assignmentId: "a-rail", supplyId: "s-handrail", name: "Handrail", unitType: "per_linear_ft", unitCost: 1800, quantityMilli: 2000, per: "rampFt", perLabel: "per ft of ramp", sortOrder: 10, roundUp: false },
    ],
    labor: { hoursPerUnitMilli: 350, setupHoursMilli: 2000, rateCents: 6500, effectiveRateCents: 6500 },
    wasteBp: 500,
    pricingBasis: "markup",
    markupBp: 4000,
    marginBp: 0,
    minimumCharge: 150_000,
    rangeMode: "measured",
    contingencyBp: null,
    estimateLowBp: 9000,
    estimateHighBp: 11500,
    example: { label: "3 steps", price: 692_146, marginBp: 2857 },
    lumpCosts: { basePrice: 0, pricePerSqFt: null, pricePerLinearFt: null, laborCost: 0 },
    showInEstimator: true,
    isEstimatable: true,
    sortOrder: 0,
    isActive: true,
    options: [
      {
        id: "o-surface",
        name: "Surface",
        optionType: "select",
        showInEstimator: true,
        sortOrder: 0,
        values: [
          { id: "v-std", label: "Standard grit", priceModifier: 0, isDefault: true, sortOrder: 0 },
          { id: "v-hd", label: "Heavy-duty grit", priceModifier: 12000, isDefault: false, sortOrder: 10 },
        ],
      },
    ],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

export function previewResponse(extra: Partial<PreviewResponse> = {}): PreviewResponse {
  return {
    fields: RAMP_FIELDS,
    status: "priced",
    missing: [],
    customerView: PRICE_ASSUMED,
    breakdown: {
      low: 644_396,
      point: 644_396,
      high: 716_352,
      cost: 460_283,
      marginBp: 2857,
      minimumApplied: false,
      lines: [
        { kind: "supply", label: "Aluminum ramp section", quantity: 21, unit: "ft", unitCost: 9500, amount: 199_500 },
        { kind: "supply", label: "Handrail", quantity: 42, unit: "ft", unitCost: 1800, amount: 75_600 },
        { kind: "labor", label: "Labor 7.35 h × $65.00", quantity: 7.35, unit: "h", unitCost: 6500, amount: 47_775 },
      ],
    },
    ...extra,
  };
}

export function line(extra: Partial<EstimateLineWire> = {}): EstimateLineWire {
  return {
    id: "li_1",
    productId: "p-ramp",
    description: "Modular aluminum ramp",
    recipe: "ramp_over_steps",
    inputs: { steps: 4, stepHeightIn: null, totalRiseIn: null },
    inputsSummary: "4 steps",
    explanation: ["4 steps × 7.5–8.5 in each (from your photo) = 30–34 in rise", "ADA 1:12 slope (1 ft of ramp per inch of rise) → 30–34 ft of ramp"],
    assumption: "Based on a step height of about 7.5–8.5 in, from your photo. Measure one step and enter it for a tighter estimate.",
    reasons: ["Step height 7.5–8.5 in (from the photo)", "A resting landing may be needed (over 30 in of rise)"],
    quantity: 1,
    unitPrice: 997_836,
    laborPrice: 0,
    total: 997_836,
    lowTotal: 860_265,
    highTotal: 1_045_807,
    priceOverridden: false,
    options: [{ optionId: "o-surface", optionName: "Surface", valueId: "v-std", valueLabel: "Standard grit", priceModifier: 0 }],
    reading: {
      takeoffId: "tk_porch",
      status: "read",
      confidence: "medium",
      lines: READING.lines,
      suggested: { steps: 3 },
      heightRangeIn: { low: 7.5, high: 8.5 },
      model: "claude-haiku-4-5",
      costMicros: 4250,
      createdAt: "2026-11-02T15:00:00.000Z",
    },
    corrections: [{ field: "steps", label: "Steps", from: 3, to: 4 }],
    cost: 712_740,
    notes: null,
    sortOrder: 0,
    ...extra,
  };
}

export function estimate(extra: Partial<EstimateDetail> = {}): EstimateDetail {
  return {
    id: "est_1",
    number: "EST-0001",
    status: "draft",
    source: "photo",
    customerName: "Pat Lee",
    customerEmail: "pat@example.com",
    customerPhone: "(801) 555-0100",
    jobAddress: "12 Elm St, Salt Lake City",
    notes: "Back door, please.",
    currency: "USD",
    subtotal: 997_836,
    discount: 0,
    taxRateBp: 725,
    taxAmount: 72_343,
    total: 1_070_179,
    rangeLow: 860_265,
    rangeHigh: 1_045_807,
    rangeReasons: ["Step height 7.5–8.5 in (from the photo)"],
    validUntil: null,
    sentAt: null,
    viewedAt: null,
    respondedAt: null,
    approvedAt: null,
    rejectedAt: null,
    expiredAt: null,
    convertedAt: null,
    archivedAt: null,
    responseName: null,
    responseNote: null,
    quoteMessage: null,
    quoteSequence: 0,
    photoCount: 1,
    createdAt: "2026-11-02T15:00:00.000Z",
    updatedAt: "2026-11-02T15:00:00.000Z",
    internalNotes: null,
    cost: 712_740,
    marginBp: 2857,
    lines: [line()],
    photos: [{ id: "ph_1", url: "https://files.test/porch.jpg", width: 768, height: 576, source: "public", takeoffId: "tk_porch", createdAt: "2026-11-02T15:00:00.000Z" }],
    actions: ["edit", "send", "duplicate", "archive"],
    links: { bookVisitUrl: null, visits: [], invoice: null },
    timeline: [{ at: "2026-11-02T15:00:00.000Z", label: "Lead received" }],
    sendWarnings: [],
    ...extra,
  };
}

export function keyWire(extra: Partial<KeyWire> = {}): KeyWire {
  return {
    id: "k_1",
    label: "Main website",
    keyPrefix: "esk_abc",
    allowedOrigins: ["https://summitramps.com"],
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Mounting and driving
// ---------------------------------------------------------------------------

export async function mount(element: ReactElement): Promise<{ container: HTMLElement; root: Root; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await settle();
  return {
    container,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Let every resolved promise and the renders it causes run. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Wait real time (debounces), then settle. */
export async function pass(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await settle();
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("click: no element");
  await act(async () => {
    (element as HTMLElement).click();
  });
  await settle();
}

/** Set a controlled input's value the way a person typing does. */
export async function type(element: Element | null | undefined, value: string): Promise<void> {
  if (!element) throw new Error("type: no element");
  const input = element as HTMLInputElement;
  const proto = Object.getPrototypeOf(input) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter ? setter.call(input, value) : (input.value = value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export async function choose(element: Element | null | undefined, value: string): Promise<void> {
  if (!element) throw new Error("choose: no element");
  const select = element as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

export async function blur(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("blur: no element");
  await act(async () => {
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    element.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
  });
  await settle();
}

export async function submit(form: Element | null | undefined): Promise<void> {
  if (!form) throw new Error("submit: no form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

export async function key(element: Element | null | undefined, keyName: string, init: KeyboardEventInit = {}): Promise<void> {
  if (!element) throw new Error("key: no element");
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

/** The first button whose text (or aria-label) includes `text`. */
export function button(container: ParentNode, text: string): HTMLButtonElement | null {
  const all = [...container.querySelectorAll<HTMLButtonElement>("button")];
  return (
    all.find((b) => (b.textContent ?? "").trim() === text) ??
    all.find((b) => (b.textContent ?? "").includes(text) || (b.getAttribute("aria-label") ?? "").includes(text)) ??
    null
  );
}

/** The text a person reads, whitespace collapsed (Intl's narrow spaces too). */
export function text(element: Element | null | undefined): string {
  return (element?.textContent ?? "").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
}

/** The input a <label> starting with `label` points at. */
export function labelled(container: ParentNode, label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  const labels = [...container.querySelectorAll("label")];
  const match = labels.find((l) => text(l).startsWith(label));
  const id = match?.getAttribute("for");
  return id ? (container.querySelector(`[id="${id}"]`) as HTMLInputElement | null) : null;
}

/** The checkbox (or radio) inside the <label> whose text starts with `label`. */
export function checkbox(container: ParentNode, label: string): HTMLInputElement | null {
  const match = [...container.querySelectorAll("label")].find((l) => text(l).startsWith(label));
  return match?.querySelector<HTMLInputElement>("input") ?? null;
}

/** A File the way the browser's picker hands one over. */
export function photoFile(name = "porch.jpg", type = "image/jpeg"): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], name, { type });
}

/** Pick `file` in the file input inside `container`. */
export async function pickFile(container: ParentNode, file: File): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("pickFile: no file input");
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle(10);
}
