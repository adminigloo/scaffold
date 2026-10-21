import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { products, productVariants } from "@adminigloo/catalog/schema";
import { formatOrderNumber } from "./order-number.js";
import { checkoutSessionKey } from "./orders.js";
import { orderItems, orders, storeAlerts, storeCheckouts, storeSettings, type OrderAddress, type StoreCheckoutLine } from "./schema.js";
import type {
  StoreSaleMethod,
  StoreAlertWire,
  StoreCheckoutStatusResponse,
  StoreOrderWire,
  StoreProductWire,
  StorePublicProductWire,
  StoreSettingsWire,
} from "./store-wire.js";

/**
 * A STORE OF ITS OWN (commerce 0.2, getting paid part 2): a business sells
 * its own products to its own customers, paid on its own Stripe account.
 *
 * THE PRODUCTS are catalog rows (`products` + one default `product_variants`
 * row) under the business's own tenant id. The site's own plans and products
 * are the catalog rows under "*", which every query here excludes by naming
 * the business.
 *
 * STOCK IS TWO NUMBERS on the variant (catalog 0.3): `inventory`, what is ON
 * THE SHELF (the only number the owner types), and `held`, what open checkout
 * pages hold. Available is shelf − held.
 *
 *   Check out          held + q         (refused if available < q)
 *   paid               shelf − q, held − q
 *   page closes unpaid held − q only
 *
 * so an owner's count is never overwritten by carts, and carts never by an
 * owner's count. Every take and give-back locks the variants it touches in
 * id order, so two of them can never wait on each other.
 *
 * THE MONEY RULES, copied from invoicing 0.5's "Pay now":
 *
 *   - Every price is the SERVER's, read from the product rows when "Check
 *     out" is pressed; the cart names products and quantities only. Shipping
 *     (when the business ships) is a flat price the server adds.
 *   - Every press writes a `store_checkouts` row with the priced lines, the
 *     amount and the currency; the same cart, unchanged, pressed again gets
 *     the same page — asked BEFORE stock, and a cart's own hold counts as its
 *     own, so a customer can never lock themselves out of the last one.
 *   - The hold is reserved and the row written in one transaction, which
 *     commits BEFORE Stripe is called; no lock is held across the network. A
 *     Stripe failure gives the hold back in a transaction of its own.
 *   - Pages close after 30 minutes (Stripe's shortest), and an owner's change
 *     to a product's price, currency or availability closes every open page
 *     with it in. One visitor may hold at most 3 open pages and open 5 an
 *     hour; one order at most `maxPerOrder` (default 5) of a product.
 *   - The webhook acts for the business the CALLER resolved from the Stripe
 *     account. An order is written only for a checkout of that business, in
 *     exactly its amount and currency, once (keyed on the Checkout Session).
 *   - Refunds (all or part, in the order's currency) and disputes come back
 *     onto the order; the emails after it go once each, retried if they fail.
 *
 * Stripe-free: the Stripe calls are a seam (`StoreCardPayments`).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StoreDb = PgDatabase<any, any, any>;

// --- Refusals -----------------------------------------------------------------

export type StoreRefusalCode = "not_found" | "invalid" | "unavailable" | "sold_out" | "limit" | "changed" | "busy";

/** A refusal the customer or owner reads as is (plain words). */
export class StoreRefusal extends Error {
  readonly name = "StoreRefusal";
  constructor(
    readonly code: StoreRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

// --- Money ----------------------------------------------------------------------

/**
 * COPIED FROM @adminigloo/invoicing's online.ts (CARD_MINIMUMS): the smallest
 * amount Stripe charges, per currency, in minor units. Change both or neither.
 */
export const STORE_CARD_MINIMUMS: Readonly<Record<string, number>> = Object.freeze({
  usd: 50, eur: 50, gbp: 30, cad: 50, aud: 50, nzd: 50, chf: 50, sgd: 50, jpy: 50,
  hkd: 400, mxn: 1000, sek: 300, nok: 300, dkk: 250, pln: 200, brl: 50, inr: 50, czk: 1500, huf: 17500,
});

/** The currencies a product can be priced in (the ones Stripe's minimum is known for). */
export const STORE_CURRENCIES: readonly string[] = Object.freeze(Object.keys(STORE_CARD_MINIMUMS));

export function storeCardMinimum(currency: string): number {
  return STORE_CARD_MINIMUMS[currency.toLowerCase()] ?? 50;
}

/** The most one checkout may come to: Stripe's ceiling for a card payment ($999,999.99). */
export const STORE_MAX_AMOUNT = 99_999_999;

/** Minor units → "$12.50" (a zero-decimal currency like yen has no minor unit). */
export function formatStoreMoney(minor: number | null, currency: string | null, locale = "en-US"): string {
  if (minor === null) return "an unknown amount";
  const code = (currency ?? "usd").toUpperCase();
  try {
    const format = new Intl.NumberFormat(locale, { style: "currency", currency: code });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  } catch {
    return `${minor} (${code})`;
  }
}

/** The payment in the business's own Stripe dashboard. */
export function storeStripePaymentUrl(paymentIntentId: string | null): string | null {
  return paymentIntentId ? `https://dashboard.stripe.com/payments/${encodeURIComponent(paymentIntentId)}` : null;
}

// --- The seam -------------------------------------------------------------------

export type StoreCardPaymentsReady = { readonly ready: true; readonly accountId: string | null } | { readonly ready: false };

export interface StoreSessionInput {
  readonly tenantId: string;
  /** The business's connected account; null for one business on its own Stripe keys. */
  readonly accountId: string | null;
  /** The `store_checkouts` row: the idempotency key and the metadata (`storeCheckoutId`). */
  readonly checkoutId: string;
  /** What Stripe's page lists, each priced by the server — shipping included as its own line. Their sum is `amount`. */
  readonly lines: readonly { readonly name: string; readonly unitAmountMinor: number; readonly quantity: number }[];
  readonly amount: number;
  readonly currency: string;
  /** "Order from Green Acres". */
  readonly description: string;
  /** Where Stripe may collect a shipping address (the business ships), or null (pickup or digital). */
  readonly shippingCountries: readonly string[] | null;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Seconds since the epoch: Stripe closes the page then. */
  readonly expiresAt: number;
}

export interface StoreCardPayments {
  /** Can this business take card payments right now (Stripe connected, charges on)? */
  ready(tenantId: string): Promise<StoreCardPaymentsReady>;
  /** Open a Checkout Session for exactly these lines, with `storeCheckoutId` and the business in its metadata. */
  createSession(input: StoreSessionInput): Promise<{ readonly id: string; readonly url: string }>;
  /** Close an open page (a product in it changed, a newer one replaced it, or the business disconnected). */
  expireSession(input: { readonly tenantId: string; readonly accountId: string | null; readonly sessionId: string }): Promise<void>;
}

/** The metadata keys a store Session and its PaymentIntent carry. Distinct from invoicing's `checkoutId`/`invoiceId`. */
export const STORE_METADATA = { checkout: "storeCheckoutId", tenant: "tenantId" } as const;

/** How long a page holds stock: 30 minutes, Stripe's shortest `expires_at`. */
export const STORE_CHECKOUT_LIFETIME_MS = 30 * 60 * 1000;
/** Sent to Stripe a little past the half hour, so its "at least 30 minutes" check never trips on the clock. */
const EXPIRES_AT_GRACE_MS = 30 * 1000;
/** A page past its time is given back this long after (31 minutes from opening): a payment finished in its last second may still be on its way. */
const LAPSE_MARGIN_MS = 30 * 1000;
/** A page closer than this to closing is not handed to a second press. */
const REUSE_MARGIN_MS = 5 * 60 * 1000;
/** A press waits this long for the same cart's page that is still being opened. */
const OPENING_MS = 2 * 60 * 1000;
/** Products in one cart, and of one product. */
export const STORE_MAX_LINES = 25;
export const STORE_MAX_QUANTITY = 99;
/** The most of one product in one order unless the owner says otherwise. */
export const STORE_DEFAULT_MAX_PER_ORDER = 5;
/** Per visitor (one network address; an IPv6 /64): open pages at once, and pages opened an hour. */
export const STORE_VISITOR_OPEN_LIMIT = 3;
export const STORE_VISITOR_HOURLY_LIMIT = 5;
/** Every request with no network address shares this one visitor — never unlimited. */
export const STORE_UNKNOWN_VISITOR = "unknown";

const CART_ID = /^[A-Za-z0-9_-]{8,64}$/;
const COUNTRY = /^[A-Z]{2}$/;

/** A visitor's key as stored: a hash, so no address is kept. */
export function storeVisitorHash(visitor: string | null | undefined): string {
  return createHash("sha256").update(visitor && visitor.length > 0 ? visitor : STORE_UNKNOWN_VISITOR).digest("hex");
}

/**
 * The caller as the NEAREST proxy saw it (the last X-Forwarded-For entry —
 * on Vercel, the address its edge saw), an IPv6 address by its /64 (one
 * machine holds a whole /64 to rotate through). Null with no proxy in front:
 * the caller then shares the one "unknown" visitor, never goes unlimited.
 */
export function storeVisitorKey(req: Request): string | null {
  const entries = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const last = entries.at(-1);
  if (!last) return null;
  if (!last.includes(":")) return last;
  const groups = last.split("::")[0]!.split(":").slice(0, 4);
  while (groups.length < 4) groups.push("0");
  return `${groups.map((g) => g.toLowerCase() || "0").join(":")}::/64`;
}

// --- Settings -------------------------------------------------------------------

export const DEFAULT_STORE_SETTINGS: StoreSettingsWire = Object.freeze({
  fulfilment: "pickup",
  shipCountries: Object.freeze(["US"]),
  shippingMinor: 0,
  currency: "usd",
  pricesIncludeTax: true,
}) as StoreSettingsWire;

export async function getStoreSettings(db: StoreDb, tenantId: string): Promise<StoreSettingsWire> {
  const [row] = (await db.select().from(storeSettings).where(eq(storeSettings.tenantId, tenantId)).limit(1)) as Array<typeof storeSettings.$inferSelect>;
  if (!row) return DEFAULT_STORE_SETTINGS;
  return {
    fulfilment: row.fulfilment === "ship" ? "ship" : "pickup",
    shipCountries: row.shipCountries,
    shippingMinor: row.shippingMinor,
    currency: row.currency,
    pricesIncludeTax: row.pricesIncludeTax,
  };
}

/** Save the owner's store settings (each field optional; the rest stay). */
export async function saveStoreSettings(db: StoreDb, tenantId: string, input: Readonly<Record<string, unknown>>): Promise<StoreSettingsWire> {
  const current = await getStoreSettings(db, tenantId);
  let fulfilment = current.fulfilment;
  let shipCountries = [...current.shipCountries];
  let shippingMinor = current.shippingMinor;
  let currency = current.currency;
  let pricesIncludeTax = current.pricesIncludeTax;
  if (input.fulfilment !== undefined) {
    if (input.fulfilment !== "ship" && input.fulfilment !== "pickup") throw new StoreRefusal("invalid", "Choose how customers get their order: you ship it, or pickup or digital only.");
    fulfilment = input.fulfilment;
  }
  if (input.shipCountries !== undefined) {
    const list = Array.isArray(input.shipCountries) ? input.shipCountries.map((c) => (typeof c === "string" ? c.trim().toUpperCase() : "")) : [];
    if (list.length === 0 || list.length > 50 || list.some((c) => !COUNTRY.test(c))) throw new StoreRefusal("invalid", "List the countries you ship to as two-letter codes, like US or CA.");
    shipCountries = [...new Set(list)];
  }
  if (input.shippingMinor !== undefined) {
    const v = input.shippingMinor;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > STORE_MAX_AMOUNT) throw new StoreRefusal("invalid", "Set the shipping price as a whole number of cents (0 for free shipping).");
    shippingMinor = v;
  }
  if (input.currency !== undefined) {
    const c = typeof input.currency === "string" ? input.currency.trim().toLowerCase() : "";
    if (!STORE_CURRENCIES.includes(c)) throw new StoreRefusal("invalid", "Choose a currency the store can charge in.");
    currency = c;
  }
  if (input.pricesIncludeTax !== undefined) {
    if (typeof input.pricesIncludeTax !== "boolean") throw new StoreRefusal("invalid", "Say whether your prices include sales tax.");
    pricesIncludeTax = input.pricesIncludeTax;
  }
  const values = { fulfilment, shipCountries, shippingMinor, currency, pricesIncludeTax, updatedAt: new Date() };
  await db.insert(storeSettings).values({ tenantId, ...values }).onConflictDoUpdate({ target: storeSettings.tenantId, set: values });
  return { fulfilment, shipCountries, shippingMinor, currency, pricesIncludeTax };
}

// --- Products -------------------------------------------------------------------

type ProductRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  images: readonly { url: string }[];
  metadata: Readonly<Record<string, string>>;
  variantId: string;
  priceMinor: bigint;
  currency: string;
  inventory: number | null;
  held: number;
};

const productColumns = {
  id: products.id,
  name: products.name,
  description: products.description,
  status: products.status,
  images: products.images,
  metadata: products.metadata,
  variantId: productVariants.id,
  priceMinor: productVariants.priceMinor,
  currency: productVariants.currency,
  inventory: productVariants.inventory,
  held: productVariants.held,
};

/** The business's own products (never "*", the site's): the company check every product query carries. */
function ownProducts(tenantId: string) {
  return and(eq(products.tenantId, tenantId), eq(products.kind, "one_time"), isNull(products.deletedAt));
}

function maxPerOrderOf(row: Pick<ProductRow, "metadata">): number {
  const n = Number(row.metadata["maxPerOrder"]);
  return Number.isInteger(n) && n >= 1 && n <= STORE_MAX_QUANTITY ? n : STORE_DEFAULT_MAX_PER_ORDER;
}

function productWire(row: ProductRow): StoreProductWire {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceMinor: Number(row.priceMinor),
    currency: row.currency,
    status: row.status === "active" ? "active" : "inactive",
    stock: row.inventory,
    held: row.inventory === null ? 0 : row.held,
    maxPerOrder: maxPerOrderOf(row),
    photoUrl: row.images[0]?.url ?? null,
  };
}

/** The business's products, for its owner (active and not), newest first. */
export async function listStoreProducts(db: StoreDb, tenantId: string): Promise<StoreProductWire[]> {
  const rows = (await db
    .select(productColumns)
    .from(products)
    .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isDefault, true)))
    .where(ownProducts(tenantId))
    .orderBy(desc(products.createdAt))
    .limit(500)) as ProductRow[];
  return rows.map(productWire);
}

/** The cart's key as stored (a hash of the browser's cart id). */
export function storeCartKey(cartId: string): string {
  return createHash("sha256").update(cartId).digest("hex");
}

/** What one cart's open pages hold, per variant: a customer's own hold is theirs to buy. */
async function heldByCart(db: StoreDb, tenantId: string, cartKey: string | null): Promise<Map<string, number>> {
  const mine = new Map<string, number>();
  if (!cartKey) return mine;
  const rows = (await db
    .select({ lines: storeCheckouts.lines })
    .from(storeCheckouts)
    .where(
      and(eq(storeCheckouts.tenantId, tenantId), eq(storeCheckouts.cartKey, cartKey), inArray(storeCheckouts.status, ["open", "creating"]), eq(storeCheckouts.stockHeld, true)),
    )) as Array<{ lines: readonly StoreCheckoutLine[] }>;
  for (const row of rows) for (const line of row.lines) if (line.held) mine.set(line.variantId, (mine.get(line.variantId) ?? 0) + line.quantity);
  return mine;
}

/**
 * The products on the store page: active ones, in the order the owner added
 * them. With the customer's cart id, what that cart already holds counts as
 * theirs — the last one in their own open checkout is not "sold out" to them.
 */
export async function listPublicStoreProducts(db: StoreDb, tenantId: string, options: { readonly cartId?: string | null } = {}): Promise<StorePublicProductWire[]> {
  const rows = (await db
    .select(productColumns)
    .from(products)
    .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isDefault, true)))
    .where(and(ownProducts(tenantId), eq(products.status, "active")))
    .orderBy(asc(products.createdAt))
    .limit(500)) as ProductRow[];
  const mine = await heldByCart(db, tenantId, options.cartId && CART_ID.test(options.cartId) ? storeCartKey(options.cartId) : null);
  return rows.map((row) => {
    const available = row.inventory === null ? null : Math.max(0, row.inventory - row.held) + (mine.get(row.variantId) ?? 0);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      priceMinor: Number(row.priceMinor),
      currency: row.currency,
      photoUrl: row.images[0]?.url ?? null,
      soldOut: available !== null && available <= 0,
      fewLeft: available !== null && available > 0 && available <= 5 ? available : null,
      maxPerOrder: maxPerOrderOf(row),
    };
  });
}

async function productOf(db: StoreDb, tenantId: string, productId: string, lock = false): Promise<ProductRow | null> {
  const query = db
    .select(productColumns)
    .from(products)
    .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isDefault, true)))
    .where(and(eq(products.id, productId), ownProducts(tenantId)))
    .limit(1);
  const [row] = (await (lock ? query.for("update") : query)) as ProductRow[];
  return row ?? null;
}

export interface StoreProductInput {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly priceMinor?: unknown;
  readonly currency?: unknown;
  readonly status?: unknown;
  /** How many are ON THE SHELF: null or "" turns the count off. Send it only when the owner changed it, with `stockWas`. */
  readonly stock?: unknown;
  /** The shelf count the owner's form started from: if sales moved it meanwhile, the save is refused in words. */
  readonly stockWas?: unknown;
  /** The most of this product in one order (1–99). */
  readonly maxPerOrder?: unknown;
}

interface CleanProduct {
  name?: string;
  description?: string | null;
  priceMinor?: number;
  currency?: string;
  status?: "active" | "inactive";
  stock?: number | null;
  stockWas?: number | null;
  maxPerOrder?: number;
}

const wholeOrNull = (value: unknown): number | null | undefined =>
  value === undefined
    ? undefined
    : value === null || value === ""
      ? null
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
        ? value
        : Number.NaN;

/** Validate what the owner typed. Every message names the field in plain words. */
export function cleanStoreProduct(input: StoreProductInput, partial: boolean): CleanProduct {
  const out: CleanProduct = {};
  if (input.name !== undefined || !partial) {
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
    if (name.length < 1 || name.length > 120) throw new StoreRefusal("invalid", "Give the product a name (up to 120 characters).");
    out.name = name;
  }
  if (input.description !== undefined) {
    if (input.description !== null && typeof input.description !== "string") throw new StoreRefusal("invalid", "The description should be text.");
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (description.length > 2000) throw new StoreRefusal("invalid", "Keep the description under 2,000 characters.");
    out.description = description === "" ? null : description;
  }
  if (input.priceMinor !== undefined || !partial) {
    const price = input.priceMinor;
    if (typeof price !== "number" || !Number.isSafeInteger(price) || price < 1 || price > STORE_MAX_AMOUNT) {
      throw new StoreRefusal("invalid", "Set a price above zero (in cents, a whole number).");
    }
    out.priceMinor = price;
  }
  if (input.currency !== undefined || !partial) {
    const currency = typeof input.currency === "string" ? input.currency.trim().toLowerCase() : "";
    if (!STORE_CURRENCIES.includes(currency)) throw new StoreRefusal("invalid", "Choose a currency the store can charge in.");
    out.currency = currency;
  }
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "inactive") throw new StoreRefusal("invalid", "A product is either for sale or not.");
    out.status = input.status;
  }
  const stock = wholeOrNull(input.stock);
  if (Number.isNaN(stock)) throw new StoreRefusal("invalid", "Stock is a whole number of 0 or more, or blank to stop counting.");
  if (stock !== undefined) out.stock = stock;
  const stockWas = wholeOrNull(input.stockWas);
  if (Number.isNaN(stockWas)) throw new StoreRefusal("invalid", "The stock you started from couldn't be read. Refresh the page and try again.");
  if (stockWas !== undefined) out.stockWas = stockWas;
  if (input.maxPerOrder !== undefined) {
    const m = input.maxPerOrder;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > STORE_MAX_QUANTITY) throw new StoreRefusal("invalid", `The most per order is a whole number from 1 to ${STORE_MAX_QUANTITY}.`);
    out.maxPerOrder = m;
  }
  return out;
}

function slugFor(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "product"}-${randomBytes(4).toString("hex")}`;
}

/** Serialize work on one key (a business's product count, its order numbers, a cart) inside a transaction. */
async function lockKey(tx: StoreDb, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * Add a product. `limit` is the plan's number of products (null: none): the
 * count is taken under the business's lock, so two tabs can't both add the 21st.
 */
export async function createStoreProduct(db: StoreDb, tenantId: string, input: StoreProductInput, options: { readonly limit?: number | null } = {}): Promise<StoreProductWire> {
  const clean = cleanStoreProduct(input, false);
  return db.transaction(async (tx) => {
    if (options.limit !== undefined && options.limit !== null) {
      await lockKey(tx, `commerce-products:${tenantId}`);
      const [row] = (await tx.select({ n: count() }).from(products).where(ownProducts(tenantId))) as Array<{ n: number }>;
      if (Number(row?.n ?? 0) >= options.limit) {
        throw new StoreRefusal(
          "limit",
          `Your plan includes ${options.limit} product${options.limit === 1 ? "" : "s"}. Remove one, or choose a bigger plan in Billing to add more.`,
        );
      }
    }
    const [product] = (await tx
      .insert(products)
      .values({
        tenantId,
        slug: slugFor(clean.name!),
        name: clean.name!,
        description: clean.description ?? null,
        kind: "one_time",
        status: clean.status === "inactive" ? "draft" : "active",
        metadata: clean.maxPerOrder !== undefined ? { maxPerOrder: String(clean.maxPerOrder) } : {},
      })
      .returning({ id: products.id })) as Array<{ id: string }>;
    await tx.insert(productVariants).values({
      productId: product!.id,
      name: clean.name!,
      priceMinor: BigInt(clean.priceMinor!),
      currency: clean.currency!,
      isDefault: true,
      inventory: clean.stock ?? null,
      held: 0,
    });
    return productWire((await productOf(tx, tenantId, product!.id))!);
  });
}

export interface StoreEditOptions {
  /** The Stripe seam: an edit closes the open pages with this product in (the price they show is no longer the price). */
  readonly payments?: StoreCardPayments;
  readonly report?: (error: unknown) => void;
}

/**
 * Change a product. Null: not this business's product. A change to its
 * price, currency or availability closes every open checkout page with it in
 * (THE EDIT RULE), and their holds come back.
 *
 * THE SHELF COUNT is changed only when `stock` is sent, and only from the
 * number the owner's form started from (`stockWas`): if sales moved it in the
 * meantime the save is refused in words, so a sale is never typed over.
 */
export async function updateStoreProduct(
  db: StoreDb,
  tenantId: string,
  productId: string,
  input: StoreProductInput,
  options: StoreEditOptions = {},
): Promise<StoreProductWire | null> {
  const clean = cleanStoreProduct(input, true);
  const result = await db.transaction(async (tx) => {
    // The product's row lock (and its variant's): a checkout taking stock waits for us, or we for it.
    const row = await productOf(tx, tenantId, productId, true);
    if (!row) return null;
    const now = new Date();
    const stockChanged = clean.stock !== undefined && clean.stock !== row.inventory;
    if (stockChanged && row.inventory !== null && clean.stockWas !== row.inventory) {
      const was = clean.stockWas;
      const sold = typeof was === "number" && was > row.inventory ? was - row.inventory : 0;
      const shelf = `${row.inventory} ${row.inventory === 1 ? "is" : "are"} on the shelf now. Check the number and save again.`;
      throw new StoreRefusal("changed", sold > 0 ? `${sold} sold while you were editing — ${shelf}` : `The stock changed while you were editing — ${shelf}`);
    }
    if (clean.name !== undefined || clean.description !== undefined || clean.status !== undefined || clean.maxPerOrder !== undefined) {
      await tx
        .update(products)
        .set({
          ...(clean.name !== undefined ? { name: clean.name } : {}),
          ...(clean.description !== undefined ? { description: clean.description } : {}),
          ...(clean.status !== undefined ? { status: clean.status === "active" ? "active" : "draft" } : {}),
          ...(clean.maxPerOrder !== undefined ? { metadata: { ...row.metadata, maxPerOrder: String(clean.maxPerOrder) } } : {}),
          updatedAt: now,
        })
        .where(and(eq(products.id, row.id), eq(products.tenantId, tenantId)));
    }
    if (clean.priceMinor !== undefined || clean.currency !== undefined || stockChanged || clean.name !== undefined) {
      await tx
        .update(productVariants)
        .set({
          ...(clean.name !== undefined ? { name: clean.name } : {}),
          ...(clean.priceMinor !== undefined ? { priceMinor: BigInt(clean.priceMinor) } : {}),
          ...(clean.currency !== undefined ? { currency: clean.currency } : {}),
          // Only the SHELF count: what carts hold stays theirs. Turning counting off clears it.
          ...(stockChanged ? { inventory: clean.stock ?? null, ...(clean.stock === null ? { held: 0 } : {}) } : {}),
          updatedAt: now,
        })
        .where(eq(productVariants.id, row.variantId));
    }
    const priced =
      (clean.priceMinor !== undefined && clean.priceMinor !== Number(row.priceMinor)) ||
      (clean.currency !== undefined && clean.currency !== row.currency) ||
      (clean.status === "inactive" && row.status === "active");
    return { product: productWire((await productOf(tx, tenantId, row.id))!), priced };
  });
  if (!result) return null;
  if (!result.priced) return result.product;
  await expireStoreCheckouts(db, options.payments ?? null, tenantId, { productId }, { report: options.report });
  return productWire((await productOf(db, tenantId, productId))!);
}

/**
 * "Release held items": close every open checkout page with this product in
 * (at Stripe first), so what they hold is back for sale. Null: not this
 * business's product.
 */
export async function releaseHeldStock(
  db: StoreDb,
  payments: StoreCardPayments | null,
  tenantId: string,
  productId: string,
  report?: (error: unknown) => void,
): Promise<{ released: number; product: StoreProductWire } | null> {
  if (!(await productOf(db, tenantId, productId))) return null;
  const released = await expireStoreCheckouts(db, payments, tenantId, { productId }, { report });
  return { released, product: productWire((await productOf(db, tenantId, productId))!) };
}

/** Take a product off the store for good (kept for its past orders). Null: not this business's. */
export async function removeStoreProduct(db: StoreDb, tenantId: string, productId: string, options: StoreEditOptions = {}): Promise<{ removed: true; photoKey: string | null } | null> {
  const removed = await db.transaction(async (tx) => {
    const row = await productOf(tx, tenantId, productId, true);
    if (!row) return null;
    await tx
      .update(products)
      .set({ deletedAt: new Date(), status: "archived", updatedAt: new Date() })
      .where(and(eq(products.id, row.id), eq(products.tenantId, tenantId)));
    return { removed: true as const, photoKey: row.metadata["photoKey"] ?? null };
  });
  if (!removed) return null;
  await expireStoreCheckouts(db, options.payments ?? null, tenantId, { productId }, { report: options.report });
  return removed;
}

/** A product's photo is now this stored file. Null: not this business's. Answers the file it replaced. */
export async function setStoreProductPhoto(
  db: StoreDb,
  tenantId: string,
  productId: string,
  photo: { readonly url: string; readonly key: string },
): Promise<{ product: StoreProductWire; replacedKey: string | null } | null> {
  return db.transaction(async (tx) => {
    const row = await productOf(tx, tenantId, productId, true);
    if (!row) return null;
    await tx
      .update(products)
      .set({ images: [{ url: photo.url, alt: row.name }], metadata: { ...row.metadata, photoKey: photo.key }, updatedAt: new Date() })
      .where(and(eq(products.id, row.id), eq(products.tenantId, tenantId)));
    return { product: productWire((await productOf(tx, tenantId, row.id))!), replacedKey: row.metadata["photoKey"] ?? null };
  });
}

/** Does this product belong to the business (and not removed)? */
export async function storeProductExists(db: StoreDb, tenantId: string, productId: string): Promise<boolean> {
  return (await productOf(db, tenantId, productId)) !== null;
}

// --- Stock ------------------------------------------------------------------------

type VariantStock = { id: string; inventory: number | null; held: number };

const byVariant = (a: StoreCheckoutLine, b: StoreCheckoutLine) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0);

/** THE ONE LOCK ORDER: the variants a take or give-back touches, locked by id. */
async function lockVariants(tx: StoreDb, variantIds: readonly string[]): Promise<Map<string, VariantStock>> {
  const ids = [...new Set(variantIds)].sort();
  if (ids.length === 0) return new Map();
  const rows = (await tx
    .select({ id: productVariants.id, inventory: productVariants.inventory, held: productVariants.held })
    .from(productVariants)
    .where(inArray(productVariants.id, ids))
    .orderBy(asc(productVariants.id))
    .for("update")) as VariantStock[];
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Give back what a checkout holds — at most once: `stock_held` is cleared in
 * the statement that reads the lines, so a repeated Stripe event or the sweep
 * finds nothing left to give. The shelf count is untouched.
 */
async function giveBackStock(tx: StoreDb, tenantId: string, checkoutId: string): Promise<void> {
  const [row] = (await tx
    .update(storeCheckouts)
    .set({ stockHeld: false, updatedAt: new Date() })
    .where(and(eq(storeCheckouts.id, checkoutId), eq(storeCheckouts.tenantId, tenantId), eq(storeCheckouts.stockHeld, true)))
    .returning({ lines: storeCheckouts.lines })) as Array<{ lines: readonly StoreCheckoutLine[] }>;
  if (!row) return;
  const held = row.lines.filter((line) => line.held).sort(byVariant);
  const locked = await lockVariants(tx, held.map((line) => line.variantId));
  for (const line of held) {
    const variant = locked.get(line.variantId);
    if (!variant) continue;
    variant.held = Math.max(0, variant.held - line.quantity);
    await tx.update(productVariants).set({ held: variant.held, updatedAt: new Date() }).where(eq(productVariants.id, variant.id));
  }
}

/** Move a checkout from one of `from` to `to` and give its hold back. Answers whether it moved. */
async function closeCheckout(db: StoreDb, tenantId: string, checkoutId: string, from: readonly string[], to: "expired" | "failed"): Promise<boolean> {
  return db.transaction(async (tx) => {
    const moved = (await tx
      .update(storeCheckouts)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(storeCheckouts.id, checkoutId), eq(storeCheckouts.tenantId, tenantId), inArray(storeCheckouts.status, [...from])))
      .returning({ id: storeCheckouts.id })) as Array<{ id: string }>;
    if (moved.length === 0) return false;
    await giveBackStock(tx, tenantId, checkoutId);
    return true;
  });
}

/**
 * Pages past their half hour that Stripe never told us about: closed here at
 * 31 minutes, their holds given back. Asked before every checkout and when
 * the store or the products list is read.
 */
export async function releaseLapsedStoreCheckouts(db: StoreDb, tenantId: string, now: Date = new Date()): Promise<number> {
  const lapsed = (await db
    .select({ id: storeCheckouts.id })
    .from(storeCheckouts)
    .where(
      and(
        eq(storeCheckouts.tenantId, tenantId),
        inArray(storeCheckouts.status, ["open", "creating"]),
        lt(storeCheckouts.expiresAt, new Date(now.getTime() - LAPSE_MARGIN_MS)),
      ),
    )
    .limit(200)) as Array<{ id: string }>;
  let released = 0;
  for (const row of lapsed) if (await closeCheckout(db, tenantId, row.id, ["open", "creating"], "expired")) released += 1;
  return released;
}

/**
 * Close a business's open checkout pages — those with `productId` in (THE
 * EDIT RULE, "Release held items"), those of one cart (a newer one replaced
 * it), or all of them (it disconnected Stripe) — at Stripe first, then here,
 * giving their holds back. Failures are reported, never thrown.
 */
export async function expireStoreCheckouts(
  db: StoreDb,
  payments: StoreCardPayments | null,
  tenantId: string,
  which: { readonly productId?: string; readonly cartKey?: string; readonly all?: true },
  options: { readonly except?: string; readonly report?: (error: unknown) => void } = {},
): Promise<number> {
  const open = (await db
    .select({ id: storeCheckouts.id, sessionId: storeCheckouts.sessionId, accountId: storeCheckouts.accountId })
    .from(storeCheckouts)
    .where(
      and(
        eq(storeCheckouts.tenantId, tenantId),
        inArray(storeCheckouts.status, ["open", "creating"]),
        which.productId ? sql`${storeCheckouts.lines} @> ${JSON.stringify([{ productId: which.productId }])}::jsonb` : undefined,
        which.cartKey ? eq(storeCheckouts.cartKey, which.cartKey) : undefined,
        options.except ? ne(storeCheckouts.id, options.except) : undefined,
      ),
    )) as Array<{ id: string; sessionId: string | null; accountId: string | null }>;
  let closed = 0;
  for (const row of open) {
    try {
      if (row.sessionId && payments) await payments.expireSession({ tenantId, accountId: row.accountId, sessionId: row.sessionId });
      if (await closeCheckout(db, tenantId, row.id, ["open", "creating"], "expired")) closed += 1;
    } catch (error) {
      options.report?.(error);
    }
  }
  return closed;
}

/** Every open page of a business (it disconnected Stripe). */
export function expireCompanyStoreCheckouts(db: StoreDb, payments: StoreCardPayments, tenantId: string, report?: (error: unknown) => void): Promise<number> {
  return expireStoreCheckouts(db, payments, tenantId, { all: true }, { report });
}

// --- Checking out -----------------------------------------------------------------

export interface StartStoreCheckoutInput {
  /** The business whose web address the customer is on. */
  readonly tenantId: string;
  /** A random id the customer's browser keeps for its cart. */
  readonly cartId: unknown;
  /** Products and quantities only: every price is read here. */
  readonly lines: unknown;
  /** The customer's network (storeVisitorKey), or null: every unknown caller shares one visitor. */
  readonly visitorKey?: string | null;
  readonly businessName: string;
  /** Where Stripe sends the customer after paying (the thank-you page), for this checkout. */
  readonly successUrl: (checkoutId: string) => string;
  readonly cancelUrl: string;
  readonly report?: (error: unknown) => void;
  readonly now?: Date;
}

function wantedLines(raw: unknown): Array<{ productId: string; quantity: number }> {
  if (!Array.isArray(raw) || raw.length === 0) throw new StoreRefusal("invalid", "Your cart is empty.");
  const merged = new Map<string, number>();
  for (const item of raw) {
    const productId = item && typeof item === "object" ? (item as { productId?: unknown }).productId : undefined;
    const quantity = item && typeof item === "object" ? (item as { quantity?: unknown }).quantity : undefined;
    if (typeof productId !== "string" || productId.length < 1 || productId.length > 64) throw new StoreRefusal("invalid", "Something in your cart isn't for sale any more. Refresh the page and try again.");
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > STORE_MAX_QUANTITY) {
      throw new StoreRefusal("invalid", `Choose a quantity from 1 to ${STORE_MAX_QUANTITY}.`);
    }
    merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  }
  if (merged.size > STORE_MAX_LINES) throw new StoreRefusal("invalid", `A cart holds up to ${STORE_MAX_LINES} different products.`);
  return [...merged].map(([productId, quantity]) => {
    if (quantity > STORE_MAX_QUANTITY) throw new StoreRefusal("invalid", `Choose a quantity from 1 to ${STORE_MAX_QUANTITY}.`);
    return { productId, quantity };
  });
}

function sameLines(a: readonly StoreCheckoutLine[], b: readonly StoreCheckoutLine[]): boolean {
  if (a.length !== b.length) return false;
  const key = (lines: readonly StoreCheckoutLine[]) =>
    lines
      .map((l) => `${l.productId}:${l.quantity}:${l.unitPriceMinor}`)
      .sort()
      .join("|");
  return key(a) === key(b);
}

type Reserved =
  | { kind: "reused"; url: string; checkoutId: string }
  | {
      kind: "reserved";
      checkoutId: string;
      accountId: string | null;
      priced: StoreCheckoutLine[];
      amount: number;
      currency: string;
      shipping: { minor: number; countries: readonly string[] } | null;
      expiresAt: Date;
    };

type CartRow = { id: string; url: string | null; lines: readonly StoreCheckoutLine[]; status: string; amount: number; currency: string; stockHeld: boolean; createdAt: Date; expiresAt: Date };

/**
 * The customer pressed "Check out". Answers Stripe's page for this cart,
 * priced here from the business's own product rows; throws StoreRefusal in
 * plain words (sold out, not for sale, not taking orders, too many open).
 */
export async function startStoreCheckout(
  db: StoreDb,
  payments: StoreCardPayments,
  input: StartStoreCheckoutInput,
): Promise<{ url: string; checkoutId: string; reused: boolean }> {
  const now = input.now ?? new Date();
  const name = input.businessName || "This business";
  if (typeof input.cartId !== "string" || !CART_ID.test(input.cartId)) throw new StoreRefusal("invalid", "Your cart couldn't be read. Refresh the page and try again.");
  const wanted = wantedLines(input.lines);
  const cartKey = storeCartKey(input.cartId);
  const visitor = storeVisitorHash(input.visitorKey);
  await releaseLapsedStoreCheckouts(db, input.tenantId, now);
  const ready = await payments.ready(input.tenantId);
  if (!ready.ready) throw new StoreRefusal("unavailable", `${name} isn't taking orders online right now.`);
  const settings = await getStoreSettings(db, input.tenantId);

  // ONE SHORT TRANSACTION: price, reserve the stock, write the row — and
  // commit BEFORE Stripe is called, so no lock waits on the network.
  const reserved: Reserved = await db.transaction(async (tx): Promise<Reserved> => {
    // THE CART'S LOCK: a double click (or a second tab) on the same cart waits here.
    await lockKey(tx, `commerce-cart:${input.tenantId}:${cartKey}`);
    const rows = (await tx
      .select(productColumns)
      .from(products)
      .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isDefault, true)))
      .where(and(ownProducts(input.tenantId), eq(products.status, "active"), inArray(products.id, wanted.map((w) => w.productId))))) as ProductRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    // The variants' row locks, in id order — the price and the stock are read under them.
    const stock = await lockVariants(tx, rows.map((row) => row.variantId));
    const priced: StoreCheckoutLine[] = [];
    for (const want of wanted) {
      const row = byId.get(want.productId);
      // Another business's product — or a removed or hidden one — is simply not for sale here.
      if (!row) throw new StoreRefusal("not_found", "Something in your cart isn't for sale any more. Refresh the page and try again.");
      const cap = maxPerOrderOf(row);
      if (want.quantity > cap) throw new StoreRefusal("limit", `You can buy up to ${cap} of ${row.name} in one order.`);
      priced.push({
        productId: row.id,
        variantId: row.variantId,
        name: row.name,
        quantity: want.quantity,
        unitPriceMinor: Number(row.priceMinor),
        held: (stock.get(row.variantId)?.inventory ?? null) !== null,
      });
    }
    const currency = byId.get(priced[0]!.productId)!.currency.toLowerCase();
    if (rows.some((row) => row.currency.toLowerCase() !== currency)) throw new StoreRefusal("invalid", "These products are priced in different currencies, so they can't be bought together.");
    let subtotal = 0;
    for (const line of priced) subtotal += line.unitPriceMinor * line.quantity;
    let shipping: { minor: number; countries: readonly string[] } | null = null;
    if (settings.fulfilment === "ship") {
      if (settings.shippingMinor > 0 && settings.currency.toLowerCase() !== currency) {
        throw new StoreRefusal("invalid", `Shipping is priced in ${settings.currency.toUpperCase()}, so an order in ${currency.toUpperCase()} can't be shipped. Please contact ${name}.`);
      }
      shipping = { minor: settings.shippingMinor, countries: settings.shipCountries };
    }
    const amount = subtotal + (shipping?.minor ?? 0);
    if (!Number.isSafeInteger(amount) || amount > STORE_MAX_AMOUNT) throw new StoreRefusal("invalid", "That's more than can be paid at once. Split it into smaller orders.");
    if (amount < storeCardMinimum(currency)) throw new StoreRefusal("invalid", `The smallest order that can be paid by card is ${formatStoreMoney(storeCardMinimum(currency), currency)}.`);

    // THE SAME CART, UNCHANGED, still open for a while: the SAME page — asked
    // before any stock check, so a customer's own hold can't lock them out.
    const mine = (await tx
      .select({
        id: storeCheckouts.id,
        url: storeCheckouts.sessionUrl,
        lines: storeCheckouts.lines,
        status: storeCheckouts.status,
        amount: storeCheckouts.amount,
        currency: storeCheckouts.currency,
        stockHeld: storeCheckouts.stockHeld,
        createdAt: storeCheckouts.createdAt,
        expiresAt: storeCheckouts.expiresAt,
      })
      .from(storeCheckouts)
      .where(and(eq(storeCheckouts.tenantId, input.tenantId), eq(storeCheckouts.cartKey, cartKey), inArray(storeCheckouts.status, ["open", "creating"])))) as CartRow[];
    const same = mine.find(
      (row) =>
        row.status === "open" && row.url && row.amount === amount && row.currency === currency && row.expiresAt.getTime() > now.getTime() + REUSE_MARGIN_MS && sameLines(row.lines, priced),
    );
    if (same) return { kind: "reused", url: same.url!, checkoutId: same.id };
    if (mine.some((row) => row.status === "creating" && now.getTime() - row.createdAt.getTime() < OPENING_MS)) {
      throw new StoreRefusal("busy", "Your checkout is already opening. Please wait a moment.");
    }

    // ONE VISITOR: at most 3 open pages (this cart's own don't count — they
    // are replaced) and 5 opened an hour. Unknown callers share one visitor.
    const [openCount] = (await tx
      .select({ n: count() })
      .from(storeCheckouts)
      .where(
        and(
          eq(storeCheckouts.tenantId, input.tenantId),
          eq(storeCheckouts.visitorKey, visitor),
          inArray(storeCheckouts.status, ["open", "creating"]),
          gt(storeCheckouts.expiresAt, now),
          ne(storeCheckouts.cartKey, cartKey),
        ),
      )) as Array<{ n: number }>;
    if (Number(openCount?.n ?? 0) >= STORE_VISITOR_OPEN_LIMIT) {
      throw new StoreRefusal("limit", `You have ${STORE_VISITOR_OPEN_LIMIT} checkouts open already. Finish or close one, then try again.`);
    }
    const [hourCount] = (await tx
      .select({ n: count() })
      .from(storeCheckouts)
      .where(and(eq(storeCheckouts.tenantId, input.tenantId), eq(storeCheckouts.visitorKey, visitor), gte(storeCheckouts.createdAt, new Date(now.getTime() - 60 * 60 * 1000))))) as Array<{
      n: number;
    }>;
    if (Number(hourCount?.n ?? 0) >= STORE_VISITOR_HOURLY_LIMIT) {
      throw new StoreRefusal("limit", "That's a lot of checkouts in an hour. Please try again a little later.");
    }

    // THE STOCK: available is shelf − held, plus what this cart already holds (its own).
    const own = new Map<string, number>();
    for (const row of mine) if (row.stockHeld) for (const line of row.lines) if (line.held) own.set(line.variantId, (own.get(line.variantId) ?? 0) + line.quantity);
    for (const line of [...priced].sort(byVariant)) {
      const variant = stock.get(line.variantId);
      if (!line.held || !variant || variant.inventory === null) continue;
      const available = Math.max(0, variant.inventory - variant.held) + (own.get(line.variantId) ?? 0);
      if (available < line.quantity) {
        throw new StoreRefusal("sold_out", available <= 0 ? `${line.name} is sold out.` : `Only ${available} of ${line.name} ${available === 1 ? "is" : "are"} left.`);
      }
      variant.held += line.quantity;
      await tx.update(productVariants).set({ held: variant.held, updatedAt: new Date() }).where(eq(productVariants.id, variant.id));
    }
    const expiresAt = new Date(now.getTime() + STORE_CHECKOUT_LIFETIME_MS + EXPIRES_AT_GRACE_MS);
    const [row] = (await tx
      .insert(storeCheckouts)
      .values({
        tenantId: input.tenantId,
        accountId: ready.accountId,
        cartKey,
        visitorKey: visitor,
        amount,
        currency,
        lines: priced,
        shippingMinor: shipping?.minor ?? 0,
        status: "creating",
        stockHeld: priced.some((line) => line.held),
        expiresAt,
        createdAt: now,
      })
      .returning({ id: storeCheckouts.id })) as Array<{ id: string }>;
    return { kind: "reserved", checkoutId: row!.id, accountId: ready.accountId, priced, amount, currency, shipping, expiresAt };
  });
  if (reserved.kind === "reused") return { url: reserved.url, checkoutId: reserved.checkoutId, reused: true };

  // Stripe, OUTSIDE any transaction.
  let session: { id: string; url: string };
  try {
    session = await payments.createSession({
      tenantId: input.tenantId,
      accountId: reserved.accountId,
      checkoutId: reserved.checkoutId,
      lines: [
        ...reserved.priced.map((line) => ({ name: line.name, unitAmountMinor: line.unitPriceMinor, quantity: line.quantity })),
        ...(reserved.shipping && reserved.shipping.minor > 0 ? [{ name: "Shipping", unitAmountMinor: reserved.shipping.minor, quantity: 1 }] : []),
      ],
      amount: reserved.amount,
      currency: reserved.currency,
      description: `Order from ${name}`,
      shippingCountries: reserved.shipping ? reserved.shipping.countries : null,
      successUrl: input.successUrl(reserved.checkoutId),
      cancelUrl: input.cancelUrl,
      expiresAt: Math.floor(reserved.expiresAt.getTime() / 1000),
    });
  } catch (error) {
    // Its hold comes back in a transaction of its own; nothing half-made stays open.
    await closeCheckout(db, input.tenantId, reserved.checkoutId, ["creating"], "failed");
    throw error;
  }
  const opened = (await db
    .update(storeCheckouts)
    .set({ sessionId: session.id, sessionUrl: session.url, status: "open", updatedAt: new Date() })
    .where(and(eq(storeCheckouts.id, reserved.checkoutId), eq(storeCheckouts.status, "creating")))
    .returning({ id: storeCheckouts.id })) as Array<{ id: string }>;
  if (opened.length === 0) {
    // Closed while Stripe was opening it (the owner changed a product in it): close Stripe's page too.
    try {
      await payments.expireSession({ tenantId: input.tenantId, accountId: reserved.accountId, sessionId: session.id });
    } catch (error) {
      input.report?.(error);
    }
    throw new StoreRefusal("changed", "Something in your cart just changed. Refresh the page and try again.");
  }
  // One open page per cart: an older one (other contents) closes, and its hold comes back.
  await expireStoreCheckouts(db, payments, input.tenantId, { cartKey }, { except: reserved.checkoutId, report: input.report });
  return { url: session.url, checkoutId: reserved.checkoutId, reused: false };
}

/** The thank-you page's question. Null: not a checkout of this business. */
export async function storeCheckoutStatus(db: StoreDb, tenantId: string, checkoutId: string): Promise<StoreCheckoutStatusResponse | null> {
  const [row] = (await db
    .select()
    .from(storeCheckouts)
    .where(and(eq(storeCheckouts.id, checkoutId), eq(storeCheckouts.tenantId, tenantId)))
    .limit(1)) as Array<typeof storeCheckouts.$inferSelect>;
  if (!row) return null;
  let orderNumber: string | null = null;
  if (row.orderId) {
    const [order] = (await db
      .select({ n: orders.orderNumber })
      .from(orders)
      .where(and(eq(orders.id, row.orderId), eq(orders.tenantId, tenantId)))
      .limit(1)) as Array<{ n: string }>;
    orderNumber = order?.n ?? null;
  }
  const state = row.status === "paid" ? "paid" : row.status === "processing" ? "processing" : row.status === "open" || row.status === "creating" ? "pending" : "closed";
  return {
    state,
    orderNumber,
    totalMinor: row.amount,
    shippingMinor: row.shippingMinor,
    currency: row.currency,
    lines: row.lines.map((line) => ({ name: line.name, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor })),
  };
}

// --- The webhook --------------------------------------------------------------------

/** The account events the store records — all already on invoicing's list, so the endpoint needs none added. */
export const STORE_CARD_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const;

export type StoreAlertKind =
  | "unknown_checkout"
  | "metadata_mismatch"
  | "amount_mismatch"
  | "currency_mismatch"
  | "oversold"
  | "refunded"
  | "dispute_opened"
  | "dispute_lost"
  | "bank_payment_failed";

export interface StoreAlert {
  readonly tenantId: string;
  readonly kind: StoreAlertKind;
  /** Plain words for the owner: what happened, the amount, and what to do. */
  readonly message: string;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly orderId: string | null;
  readonly orderNumber: string | null;
  readonly paymentIntentId: string | null;
  readonly stripeUrl: string | null;
  readonly dedupeKey: string;
}

/** A new order, for the emails (the customer's receipt, the owner's "new order"). */
export interface StoreOrderPlaced {
  readonly tenantId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly email: string;
  readonly totalMinor: number;
  readonly shippingMinor: number;
  readonly currency: string;
  readonly lines: readonly { readonly name: string; readonly quantity: number; readonly unitPriceMinor: number }[];
  readonly shipTo: OrderAddress | null;
  readonly placedAt: Date;
  /** commerce 0.4: a sale recorded by hand — the buyer's name and phone when staff knew. Never where to send it. */
  readonly buyer?: { readonly name: string | null; readonly phone: string | null } | null;
}

/** Which of an order's emails are still owed. */
export interface StoreEmailsOwed {
  readonly receipt: boolean;
  readonly notice: boolean;
}

export type StoreEventOutcome =
  | { readonly outcome: "recorded"; readonly orderId: string; readonly orderNumber: string }
  | { readonly outcome: "duplicate"; readonly orderId: string | null }
  | { readonly outcome: "refunded"; readonly orderId: string; readonly amount: number; readonly whole: boolean }
  | { readonly outcome: "flagged"; readonly orderId: string; readonly flag: "disputed" | "dispute_lost" | null }
  | { readonly outcome: "expired" }
  | { readonly outcome: "pending" }
  | { readonly outcome: "released" }
  | { readonly outcome: "ignored"; readonly why: string }
  | { readonly outcome: "refused"; readonly reason: StoreAlertKind; readonly message: string };

/** An order email that didn't go: thrown so the webhook answers 500 and Stripe retries; the retry sends only what is still owed. */
export class StoreEmailPendingError extends Error {
  readonly name = "StoreEmailPendingError";
  constructor(readonly orderId: string) {
    super(`An email for store order ${orderId} didn't go; the webhook will retry and send only what is still owed.`);
  }
}

export interface StoreEventOptions {
  /** A store payment that needs the owner: the bell and email (the app's alerts) and the log. Only NEW ones. */
  readonly onAlert?: (alert: StoreAlert) => void | Promise<void>;
  /**
   * An order's emails, for what is still OWED (`owed`). Answer which went (or
   * were deliberately skipped): those are marked and never sent again. One
   * answered `false` stays owed and the event is retried. Answering nothing
   * marks both sent.
   */
  readonly onOrder?: (order: StoreOrderPlaced, owed: StoreEmailsOwed) => void | Partial<StoreEmailsOwed> | Promise<void | Partial<StoreEmailsOwed>>;
  /** The order number's prefix (1–8 letters or digits). Default "ORD". */
  readonly orderPrefix?: string;
  readonly report?: (error: unknown) => void;
  readonly now?: Date;
}

/** A Stripe event as this module reads it: structural, so commerce never needs Stripe's types. */
export interface StoreEventLike {
  readonly id?: string;
  readonly type: string;
  readonly data: { readonly object: unknown };
}

type Meta = Readonly<Record<string, string | undefined>>;
const idOf = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : null;
const metaOf = (object: Record<string, unknown>): Meta => (object.metadata && typeof object.metadata === "object" ? (object.metadata as Meta) : {});
const num = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const objectOf = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" ? (value as Record<string, unknown>) : null);

/** The shipping address Stripe collected (newer API versions keep it under `collected_information`). */
function shippingAddressOf(session: Record<string, unknown>): OrderAddress | null {
  const details = objectOf(objectOf(session.collected_information)?.shipping_details) ?? objectOf(session.shipping_details);
  const address = objectOf(details?.address);
  if (!details || !address) return null;
  const pick = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 200) : undefined);
  const out: Record<string, string | undefined> = {
    name: pick(details.name),
    line1: pick(address.line1),
    line2: pick(address.line2),
    city: pick(address.city),
    region: pick(address.state),
    postalCode: pick(address.postal_code),
    country: pick(address.country)?.toUpperCase(),
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out as OrderAddress;
}

/**
 * One event, for the business `tenantId` — WHICH THE CALLER RESOLVED FROM THE
 * STRIPE ACCOUNT the event was signed for (stripe's `companyForConnectEvent`),
 * never from the event's metadata. Throws only for a failure worth a retry
 * (the database, an email still owed); a refusal is an outcome, alerted, and
 * answered 200.
 */
export async function handleStoreEvent(db: StoreDb, tenantId: string, event: StoreEventLike, options: StoreEventOptions = {}): Promise<StoreEventOutcome> {
  const object = (event.data.object ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const details = objectOf(object.customer_details) ?? {};
      return recordStorePayment(
        db,
        tenantId,
        {
          sessionId: idOf(object.id),
          paymentIntentId: idOf(object.payment_intent),
          amount: num(object.amount_total),
          currency: text(object.currency),
          paid: object.payment_status === "paid",
          email: text(details.email) ?? text(object.customer_email),
          shipTo: shippingAddressOf(object),
          metadata: metaOf(object),
        },
        options,
      );
    }
    case "checkout.session.async_payment_failed":
      return storeBankPaymentFailed(db, tenantId, object, options);
    case "checkout.session.expired": {
      const checkoutId = metaOf(object)[STORE_METADATA.checkout];
      const sessionId = idOf(object.id);
      if (!checkoutId || !sessionId) return { outcome: "ignored", why: "not a store checkout" };
      const [row] = (await db
        .select({ id: storeCheckouts.id })
        .from(storeCheckouts)
        .where(and(eq(storeCheckouts.id, checkoutId), eq(storeCheckouts.tenantId, tenantId), eq(storeCheckouts.sessionId, sessionId)))
        .limit(1)) as Array<{ id: string }>;
      if (!row) return { outcome: "ignored", why: "not this business's checkout" };
      await closeCheckout(db, tenantId, row.id, ["open", "creating"], "expired");
      return { outcome: "expired" };
    }
    case "charge.refunded":
      return recordStoreRefund(db, tenantId, { paymentIntentId: idOf(object.payment_intent), amountRefunded: num(object.amount_refunded) ?? 0, currency: text(object.currency) }, options);
    case "charge.dispute.created":
      return storeDispute(db, tenantId, { paymentIntentId: idOf(object.payment_intent), amount: num(object.amount), currency: text(object.currency), status: null }, options);
    case "charge.dispute.closed":
      return storeDispute(db, tenantId, { paymentIntentId: idOf(object.payment_intent), amount: num(object.amount), currency: text(object.currency), status: text(object.status) ?? "closed" }, options);
    default:
      return { outcome: "ignored", why: `not a store event (${event.type})` };
  }
}

/**
 * Every store problem is STORED for the business (`store_alerts`, its
 * owner's "Needs your attention" list) and only a NEW one is handed to
 * `onAlert`, so a repeated event never alerts twice.
 */
async function alert(db: StoreDb, options: StoreEventOptions, value: Omit<StoreAlert, "stripeUrl">): Promise<void> {
  const inserted = (await db
    .insert(storeAlerts)
    .values({
      tenantId: value.tenantId,
      kind: value.kind,
      message: value.message,
      amount: value.amount,
      currency: value.currency,
      orderId: value.orderId,
      paymentIntentId: value.paymentIntentId,
      dedupeKey: value.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: storeAlerts.id })) as Array<{ id: string }>;
  if (inserted.length === 0) return;
  try {
    await options.onAlert?.({ ...value, stripeUrl: storeStripePaymentUrl(value.paymentIntentId) });
  } catch (error) {
    options.report?.(error);
  }
}

export interface StorePaymentReport {
  readonly sessionId: string | null;
  readonly paymentIntentId: string | null;
  readonly amount: number | null;
  readonly currency: string | null;
  /** The money has cleared (a card), as opposed to a bank payment still on its way. */
  readonly paid: boolean;
  readonly email: string | null;
  readonly shipTo?: OrderAddress | null;
  readonly metadata: Meta;
}

type Recorded =
  | { kind: "refuse"; reason: StoreAlertKind; message: string }
  | { kind: "pending" }
  | { kind: "duplicate"; orderId: string | null }
  | { kind: "recorded"; orderId: string; orderNumber: string; oversold: string[]; amount: number; currency: string };

/**
 * Send what is still owed of an order's emails, once each: the marks are set
 * for what went, and an email that failed throws StoreEmailPendingError so
 * the event is retried — and the retry sends only that one.
 */
export async function deliverStoreOrderEmails(db: StoreDb, tenantId: string, orderId: string, options: Pick<StoreEventOptions, "onOrder">): Promise<void> {
  if (!options.onOrder) return;
  const [row] = (await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .limit(1)) as Array<typeof orders.$inferSelect>;
  if (!row) return;
  const owed: StoreEmailsOwed = { receipt: row.receiptSentAt === null && row.email !== "", notice: row.noticeSentAt === null };
  if (!owed.receipt && !owed.notice) return;
  const items = (await db.select().from(orderItems).where(eq(orderItems.orderId, row.id)).orderBy(asc(orderItems.id))) as Array<typeof orderItems.$inferSelect>;
  const placed: StoreOrderPlaced = {
    tenantId,
    orderId: row.id,
    orderNumber: row.orderNumber,
    email: row.email,
    totalMinor: Number(row.totalMinor),
    shippingMinor: Number(row.shippingMinor),
    currency: row.currency,
    lines: items.map((item) => ({ name: item.name, quantity: item.quantity, unitPriceMinor: Number(item.unitPriceMinor) })),
    shipTo: row.shippingAddress ?? null,
    placedAt: row.placedAt ?? row.createdAt,
  };
  const went = (await options.onOrder(placed, owed)) ?? {};
  const receiptDone = owed.receipt && went.receipt !== false;
  const noticeDone = owed.notice && went.notice !== false;
  const now = new Date();
  if (receiptDone || noticeDone) {
    await db
      .update(orders)
      .set({ ...(receiptDone ? { receiptSentAt: now } : {}), ...(noticeDone ? { noticeSentAt: now } : {}) })
      .where(and(eq(orders.id, row.id), eq(orders.tenantId, tenantId)));
  }
  if ((owed.receipt && !receiptDone) || (owed.notice && !noticeDone)) throw new StoreEmailPendingError(row.id);
}

/**
 * Write the order a checkout's payment pays for, if — and only if — every
 * check below holds. `checkout.session.completed` (and, for a bank payment,
 * `async_payment_succeeded`) is the only writer, under the checkout's row lock.
 */
export async function recordStorePayment(db: StoreDb, tenantId: string, report: StorePaymentReport, options: StoreEventOptions = {}): Promise<StoreEventOutcome> {
  const checkoutId = report.metadata[STORE_METADATA.checkout];
  // Not a store checkout at all (an invoice's, the site's own): not ours to look at.
  if (!checkoutId) return { outcome: "ignored", why: "not a store checkout" };
  const taken = formatStoreMoney(report.amount, report.currency);
  const now = options.now ?? new Date();

  const result: Recorded = await db.transaction(async (tx): Promise<Recorded> => {
    // 1. The checkout, IN THIS BUSINESS. Metadata naming another business's
    //    checkout — or one that never existed — finds nothing here.
    const [row] = (await tx
      .select()
      .from(storeCheckouts)
      .where(and(eq(storeCheckouts.id, checkoutId), eq(storeCheckouts.tenantId, tenantId)))
      .limit(1)
      .for("update")) as Array<typeof storeCheckouts.$inferSelect>;
    if (!row) {
      return { kind: "refuse", reason: "unknown_checkout", message: `Stripe took ${taken} for an order your store never started. No order was made: check it in Stripe and refund it if it isn't yours.` };
    }
    // 2. Everything the event says must agree with the row.
    const claimedTenant = report.metadata[STORE_METADATA.tenant];
    if ((claimedTenant !== undefined && claimedTenant !== tenantId) || (report.sessionId !== null && row.sessionId !== null && report.sessionId !== row.sessionId)) {
      return { kind: "refuse", reason: "metadata_mismatch", message: `Stripe took ${taken} with details that don't match the order it names. No order was made: check it in Stripe.` };
    }
    if (report.amount === null || report.amount !== row.amount) {
      return { kind: "refuse", reason: "amount_mismatch", message: `Stripe took ${taken} where ${formatStoreMoney(row.amount, row.currency)} was asked. No order was made: check it in Stripe and refund it.` };
    }
    if (!report.currency || report.currency.toLowerCase() !== row.currency.toLowerCase()) {
      return { kind: "refuse", reason: "currency_mismatch", message: `Stripe took ${taken} where ${formatStoreMoney(row.amount, row.currency)} was asked. No order was made: check it in Stripe.` };
    }
    if (row.orderId) return { kind: "duplicate", orderId: row.orderId };
    // 3. A bank payment on its way: the hold stays until it clears or fails.
    if (!report.paid) {
      if (row.status === "open" || row.status === "creating" || row.status === "expired") {
        await tx
          .update(storeCheckouts)
          .set({ status: "processing", processingAt: now, paymentIntentId: report.paymentIntentId, updatedAt: new Date() })
          .where(eq(storeCheckouts.id, row.id));
      }
      return { kind: "pending" };
    }
    const pi = report.paymentIntentId;
    if (!pi || !row.sessionId) {
      return { kind: "refuse", reason: "metadata_mismatch", message: `Stripe took ${taken} with no payment reference. No order was made: check it in Stripe.` };
    }
    // 4. The stock, under the variants' locks in id order. Held since the page
    //    opened: the sale comes off the shelf AND off what is held. Given back
    //    meanwhile (its half hour, a change to a product) and paid anyway: it
    //    comes off the shelf, and is flagged when none was free — the money
    //    moved, the order stands, and no count goes below zero.
    const oversold: string[] = [];
    const heldLines = row.lines.filter((line) => line.held).sort(byVariant);
    const locked = await lockVariants(tx, heldLines.map((line) => line.variantId));
    for (const line of heldLines) {
      const variant = locked.get(line.variantId);
      if (!variant || variant.inventory === null) continue;
      const free = row.stockHeld ? variant.inventory : Math.max(0, variant.inventory - variant.held);
      if (free < line.quantity) oversold.push(line.name);
      variant.inventory = Math.max(0, variant.inventory - line.quantity);
      if (row.stockHeld) variant.held = Math.max(0, variant.held - line.quantity);
      await tx.update(productVariants).set({ inventory: variant.inventory, held: variant.held, updatedAt: new Date() }).where(eq(productVariants.id, variant.id));
    }
    // 5. The order, once: keyed on the Checkout Session (commerce's protocol),
    //    numbered per business under its lock.
    await lockKey(tx, `commerce-orders:${tenantId}`);
    const [counted] = (await tx.select({ n: count() }).from(orders).where(eq(orders.tenantId, tenantId))) as Array<{ n: number }>;
    const orderNumber = formatOrderNumber({ prefix: options.orderPrefix ?? "ORD", sequence: Number(counted?.n ?? 0) + 1, date: now });
    const total = BigInt(row.amount);
    const inserted = (await tx
      .insert(orders)
      .values({
        tenantId,
        idempotencyKey: checkoutSessionKey(row.sessionId),
        orderNumber,
        userId: null,
        email: report.email ?? "",
        status: "paid",
        subtotalMinor: total - BigInt(row.shippingMinor),
        shippingMinor: BigInt(row.shippingMinor),
        taxMinor: 0n,
        discountMinor: 0n,
        totalMinor: total,
        currency: row.currency,
        stripePaymentIntentId: pi,
        stripeCheckoutSessionId: row.sessionId,
        shippingAddress: report.shipTo ?? null,
        placedAt: now,
        ...(oversold.length > 0 ? { oversoldAt: now } : {}),
      })
      .onConflictDoNothing({ target: [orders.tenantId, orders.idempotencyKey] })
      .returning({ id: orders.id })) as Array<{ id: string }>;
    if (inserted.length === 0) {
      const [existing] = (await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.idempotencyKey, checkoutSessionKey(row.sessionId))))
        .limit(1)) as Array<{ id: string }>;
      return { kind: "duplicate", orderId: existing?.id ?? null };
    }
    const orderId = inserted[0]!.id;
    await tx.insert(orderItems).values(
      row.lines.map((line) => ({
        orderId,
        productRef: line.productId,
        variantRef: line.variantId,
        name: line.name,
        quantity: line.quantity,
        unitPriceMinor: BigInt(line.unitPriceMinor),
        totalMinor: BigInt(line.unitPriceMinor * line.quantity),
      })),
    );
    await tx
      .update(storeCheckouts)
      .set({ status: "paid", orderId, paymentIntentId: pi, stockHeld: false, updatedAt: new Date() })
      .where(eq(storeCheckouts.id, row.id));
    return { kind: "recorded", orderId, orderNumber, oversold, amount: row.amount, currency: row.currency };
  });

  const pi = report.paymentIntentId;
  if (result.kind === "refuse") {
    await alert(db, options, {
      tenantId,
      kind: result.reason,
      message: result.message,
      amount: report.amount,
      currency: report.currency,
      orderId: null,
      orderNumber: null,
      paymentIntentId: pi,
      dedupeKey: `${result.reason}:${pi ?? report.sessionId ?? checkoutId}`,
    });
    return { outcome: "refused", reason: result.reason, message: result.message };
  }
  if (result.kind === "pending") return { outcome: "pending" };
  if (result.kind === "duplicate") {
    // A retry after an email failed: send only what is still owed.
    if (result.orderId) await deliverStoreOrderEmails(db, tenantId, result.orderId, options);
    return { outcome: "duplicate", orderId: result.orderId };
  }
  if (result.oversold.length > 0) {
    await alert(db, options, {
      tenantId,
      kind: "oversold",
      message: `Order ${result.orderNumber} was paid for after ${result.oversold.join(", ")} ran out. Refund it in Stripe, or get more in and send it.`,
      amount: result.amount,
      currency: result.currency,
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      paymentIntentId: pi,
      dedupeKey: `oversold:${result.orderId}`,
    });
  }
  await deliverStoreOrderEmails(db, tenantId, result.orderId, options);
  return { outcome: "recorded", orderId: result.orderId, orderNumber: result.orderNumber };
}

/** A bank payment that failed: its hold comes back, the customer can order again, and the owner is told. */
async function storeBankPaymentFailed(db: StoreDb, tenantId: string, object: Record<string, unknown>, options: StoreEventOptions): Promise<StoreEventOutcome> {
  const checkoutId = metaOf(object)[STORE_METADATA.checkout];
  if (!checkoutId) return { outcome: "ignored", why: "not a store checkout" };
  const [row] = (await db
    .select({ amount: storeCheckouts.amount, currency: storeCheckouts.currency })
    .from(storeCheckouts)
    .where(and(eq(storeCheckouts.id, checkoutId), eq(storeCheckouts.tenantId, tenantId)))
    .limit(1)) as Array<{ amount: number; currency: string }>;
  if (!row) return { outcome: "ignored", why: "not this business's checkout" };
  if (!(await closeCheckout(db, tenantId, checkoutId, ["processing", "open", "creating", "expired"], "failed"))) return { outcome: "ignored", why: "already released" };
  await alert(db, options, {
    tenantId,
    kind: "bank_payment_failed",
    message: `A bank payment of ${formatStoreMoney(row.amount, row.currency)} for an order failed. No order was made, and what it held is back in stock.`,
    amount: row.amount,
    currency: row.currency,
    orderId: null,
    orderNumber: null,
    paymentIntentId: idOf(object.payment_intent),
    dedupeKey: `bank_payment_failed:${checkoutId}`,
  });
  return { outcome: "released" };
}

async function orderByPayment(db: StoreDb, tenantId: string, paymentIntentId: string) {
  const [row] = (await db
    .select({ id: orders.id, number: orders.orderNumber, total: orders.totalMinor, refunded: orders.refundedMinor, status: orders.status, flag: orders.flag, currency: orders.currency })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.stripePaymentIntentId, paymentIntentId)))
    .limit(1)) as Array<{ id: string; number: string; total: bigint; refunded: bigint; status: string; flag: string | null; currency: string }>;
  return row ? { ...row, total: Number(row.total), refunded: Number(row.refunded) } : null;
}

/**
 * A refund in Stripe (`amount_refunded` is the running total, in the order's
 * currency — another currency is not recorded): the order's refunded amount
 * follows it, and all of it makes the order "refunded".
 */
export async function recordStoreRefund(
  db: StoreDb,
  tenantId: string,
  refund: { readonly paymentIntentId: string | null; readonly amountRefunded: number; readonly currency?: string | null },
  options: StoreEventOptions = {},
): Promise<StoreEventOutcome> {
  if (!refund.paymentIntentId) return { outcome: "ignored", why: "no payment reference" };
  const order = await orderByPayment(db, tenantId, refund.paymentIntentId);
  if (!order) return { outcome: "ignored", why: "not an order of this business" };
  if (refund.currency && refund.currency.toLowerCase() !== order.currency.toLowerCase()) {
    const message = `Stripe reported a refund on order ${order.number} in ${refund.currency.toUpperCase()}, but the order was paid in ${order.currency.toUpperCase()}. It was not recorded: check it in Stripe.`;
    await alert(db, options, {
      tenantId,
      kind: "currency_mismatch",
      message,
      amount: refund.amountRefunded,
      currency: refund.currency,
      orderId: order.id,
      orderNumber: order.number,
      paymentIntentId: refund.paymentIntentId,
      dedupeKey: `refund_currency:${refund.paymentIntentId}:${refund.amountRefunded}`,
    });
    return { outcome: "refused", reason: "currency_mismatch", message };
  }
  const refunded = Math.min(Math.max(0, refund.amountRefunded), order.total);
  const delta = refunded - order.refunded;
  if (delta <= 0) return { outcome: "duplicate", orderId: order.id };
  const whole = refunded >= order.total;
  // Never backwards: only a larger running total moves it.
  await db
    .update(orders)
    .set({ refundedMinor: BigInt(refunded), ...(whole ? { status: "refunded" } : {}), updatedAt: new Date() })
    .where(and(eq(orders.id, order.id), eq(orders.tenantId, tenantId), lt(orders.refundedMinor, BigInt(refunded))));
  await alert(db, options, {
    tenantId,
    kind: "refunded",
    message: whole
      ? `Order ${order.number} was refunded in full (${formatStoreMoney(order.total, order.currency)}).`
      : `${formatStoreMoney(delta, order.currency)} of order ${order.number} was refunded in Stripe (${formatStoreMoney(refunded, order.currency)} of ${formatStoreMoney(order.total, order.currency)} so far).`,
    amount: delta,
    currency: order.currency,
    orderId: order.id,
    orderNumber: order.number,
    paymentIntentId: refund.paymentIntentId,
    dedupeKey: `refunded:${refund.paymentIntentId}:${refunded}`,
  });
  return { outcome: "refunded", orderId: order.id, amount: delta, whole };
}

/** A dispute opened (flag), closed and lost (flag, and the owner told), or closed and won (flag cleared). */
async function storeDispute(
  db: StoreDb,
  tenantId: string,
  dispute: { readonly paymentIntentId: string | null; readonly amount: number | null; readonly currency: string | null; readonly status: string | null },
  options: StoreEventOptions,
): Promise<StoreEventOutcome> {
  if (!dispute.paymentIntentId) return { outcome: "ignored", why: "no payment reference" };
  const order = await orderByPayment(db, tenantId, dispute.paymentIntentId);
  if (!order) return { outcome: "ignored", why: "not an order of this business" };
  const now = options.now ?? new Date();
  const setFlag = (flag: string | null) =>
    db.update(orders).set({ flag, flaggedAt: flag ? now : null, updatedAt: new Date() }).where(and(eq(orders.id, order.id), eq(orders.tenantId, tenantId)));
  if (dispute.status === null) {
    if (order.flag === "disputed" || order.flag === "dispute_lost") return { outcome: "duplicate", orderId: order.id };
    await setFlag("disputed");
    await alert(db, options, {
      tenantId,
      kind: "dispute_opened",
      message: `A customer's bank disputed order ${order.number} (${formatStoreMoney(dispute.amount, dispute.currency)}). Answer it in your Stripe dashboard before its deadline.`,
      amount: dispute.amount,
      currency: dispute.currency,
      orderId: order.id,
      orderNumber: order.number,
      paymentIntentId: dispute.paymentIntentId,
      dedupeKey: `dispute_opened:${dispute.paymentIntentId}`,
    });
    return { outcome: "flagged", orderId: order.id, flag: "disputed" };
  }
  if (dispute.status !== "lost") {
    if (order.flag !== "disputed") return { outcome: "duplicate", orderId: order.id };
    await setFlag(null);
    return { outcome: "flagged", orderId: order.id, flag: null };
  }
  if (order.flag === "dispute_lost") return { outcome: "duplicate", orderId: order.id };
  await setFlag("dispute_lost");
  await alert(db, options, {
    tenantId,
    kind: "dispute_lost",
    message: `You lost the dispute over order ${order.number}: ${formatStoreMoney(dispute.amount, dispute.currency)} was taken back by the customer's bank.`,
    amount: dispute.amount,
    currency: dispute.currency,
    orderId: order.id,
    orderNumber: order.number,
    paymentIntentId: dispute.paymentIntentId,
    dedupeKey: `dispute_lost:${dispute.paymentIntentId}`,
  });
  return { outcome: "flagged", orderId: order.id, flag: "dispute_lost" };
}

// --- The owner's lists ----------------------------------------------------------------

/** Store orders are the Checkout ones (the site's own admin-entered orders have other keys). */
function checkoutOrders(column: typeof orders.idempotencyKey) {
  // commerce 0.4: and the sales staff recorded by hand.
  return sql`(${column} like ${"checkout_session:%"} or ${column} like ${`${STORE_SALE_KEY_PREFIX}%`})`;
}

/** The business's orders from its store, newest first, with their lines. */
export async function listStoreOrders(db: StoreDb, tenantId: string, options: { readonly limit?: number; readonly orderId?: string } = {}): Promise<StoreOrderWire[]> {
  const rows = (await db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), checkoutOrders(orders.idempotencyKey), options.orderId ? eq(orders.id, options.orderId) : undefined))
    .orderBy(desc(orders.createdAt))
    .limit(Math.min(options.limit ?? 100, 500))) as Array<typeof orders.$inferSelect>;
  if (rows.length === 0) return [];
  const items = (await db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, rows.map((row) => row.id)))
    .orderBy(asc(orderItems.id))) as Array<typeof orderItems.$inferSelect>;
  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    email: row.email,
    status: row.status === "fulfilled" ? "sent" : row.status === "refunded" || row.status === "cancelled" ? "refunded" : row.status === "pending" ? "pending" : "paid",
    totalMinor: Number(row.totalMinor),
    refundedMinor: Number(row.refundedMinor),
    currency: row.currency,
    placedAt: row.placedAt ? row.placedAt.toISOString() : null,
    flag: row.flag === "disputed" || row.flag === "dispute_lost" ? row.flag : null,
    oversold: row.oversoldAt !== null,
    shippingMinor: Number(row.shippingMinor),
    shipTo: row.shippingAddress ?? null,
    lines: items
      .filter((item) => item.orderId === row.id)
      .map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unitPriceMinor: Number(item.unitPriceMinor),
        totalMinor: Number(item.totalMinor),
        priceChanged: priceChangeOf(item.metadata),
      })),
    stripeUrl: storeStripePaymentUrl(row.stripePaymentIntentId),
    paidBy: isSaleMethod(row.paymentMethod) ? row.paymentMethod : "card",
    paymentReference: row.paymentReference ?? null,
    inPerson: row.idempotencyKey.startsWith(STORE_SALE_KEY_PREFIX),
    buyer: row.idempotencyKey.startsWith(STORE_SALE_KEY_PREFIX) ? buyerOf(row.billingAddress) : null,
  }));
}

// --- A sale recorded by hand (commerce 0.4) ------------------------------------------

/** The idempotency key prefix of a sale recorded by hand: `store_sale:{request key}`. */
export const STORE_SALE_KEY_PREFIX = "store_sale:";
export const STORE_SALE_METHODS: readonly StoreSaleMethod[] = Object.freeze(["cash", "check", "card_terminal", "other"]);
/** The most of one product a sale by hand takes (a counter sale, not a cart). */
export const STORE_SALE_MAX_QUANTITY = 999;

/** A sale by hand's buyer, kept as who paid (`billing_address`), never as where to ship. */
function buyerOf(value: unknown): { name: string | null; phone: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const { name, phone } = value as { name?: unknown; phone?: unknown };
  const out = { name: typeof name === "string" && name ? name : null, phone: typeof phone === "string" && phone ? phone : null };
  return out.name || out.phone ? out : null;
}

function isSaleMethod(value: unknown): value is StoreSaleMethod {
  return typeof value === "string" && (STORE_SALE_METHODS as readonly string[]).includes(value);
}

/** A line whose price staff changed: the catalog price and the reason, kept in its metadata (strings). */
function priceChangeOf(metadata: unknown): { listPriceMinor: number; reason: string } | null {
  if (!metadata || typeof metadata !== "object") return null;
  const { listPriceMinor, priceReason } = metadata as { listPriceMinor?: unknown; priceReason?: unknown };
  const list = typeof listPriceMinor === "string" ? Number(listPriceMinor) : NaN;
  return Number.isSafeInteger(list) && typeof priceReason === "string" ? { listPriceMinor: list, reason: priceReason } : null;
}

export interface StoreSaleLineInput {
  /** One of the company's own products (its catalog). */
  readonly productId: string;
  readonly quantity: number;
  /** Staff charging something other than the catalog price: the price, in minor units… */
  readonly priceMinor?: number;
  /** …and why (3 to 200 characters). Kept on the order line with the catalog price. */
  readonly priceReason?: string;
}

export interface StoreSaleInput {
  readonly lines: readonly StoreSaleLineInput[];
  readonly method: StoreSaleMethod;
  /** A check number or the terminal's slip number. */
  readonly reference?: string | null;
  /** Who bought it, when staff know: an email puts the sale on their timeline and can take the receipt. */
  readonly customer?: { readonly name?: string | null; readonly email?: string | null; readonly phone?: string | null } | null;
  /** Email the customer their receipt (default false). Needs an email. */
  readonly sendReceipt?: boolean;
  /** One key per "Record sale" press (8–64 letters, digits, - or _): a double submit records ONE sale. */
  readonly requestKey: string;
}

export interface StoreSaleOptions {
  /** The staff member recording it. */
  readonly recordedBy: string | null;
  /** The store's `onOrder` (the customer's timeline, the receipt): told once, after the commit. */
  readonly onOrder?: StoreEventOptions["onOrder"];
  readonly orderPrefix?: string;
  readonly report?: (error: unknown) => void;
  readonly now?: Date;
}

export interface StoreSaleResult {
  readonly order: StoreOrderWire;
  /** True when this press had been recorded before (nothing new was taken). */
  readonly duplicate: boolean;
  /** "sent", "not asked", "no email" (none given), or "failed" (the sale stands; send it again from the order). */
  readonly receipt: "sent" | "not_asked" | "no_email" | "failed";
}

const SALE_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function oneLineText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

/**
 * RECORD A SALE BY HAND (commerce 0.4): a counter sale, a market stall, a
 * customer who paid cash at the door. Staff of the company only (the route is
 * `store.manage`).
 *
 * - Products and quantities from the company's own catalog; every price is
 *   the catalog's. Charging another price needs a reason (3–200 characters),
 *   and the line keeps the catalog price and the reason beside what was
 *   charged.
 * - How it was paid: cash, check, card terminal or other (no Stripe here —
 *   the money changed hands already), with a check or slip number.
 * - Stock comes off the shelf EXACTLY ONCE: the order is keyed on the press's
 *   `requestKey`, checked under the company's order lock BEFORE any stock is
 *   touched, so a double submit records one sale and takes one lot. Only free
 *   stock can be sold (what online checkouts hold stays theirs).
 * - Numbered like every order of the company (its prefix, its sequence).
 * - After the commit, the store's `onOrder` is told once (the customer's
 *   timeline; the receipt when asked and there is an email). The owner's "new
 *   order" email is not owed — staff made the sale.
 */
export async function recordStoreSale(db: StoreDb, tenantId: string, input: StoreSaleInput, options: StoreSaleOptions): Promise<StoreSaleResult> {
  const now = options.now ?? new Date();
  if (!input || typeof input.requestKey !== "string" || !SALE_KEY.test(input.requestKey)) {
    throw new StoreRefusal("invalid", "This sale couldn't be read. Refresh the page and try again.");
  }
  if (!isSaleMethod(input.method)) throw new StoreRefusal("invalid", "Choose how it was paid: cash, check, card terminal or other.");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new StoreRefusal("invalid", "Add at least one product.");
  if (input.lines.length > STORE_MAX_LINES) throw new StoreRefusal("invalid", `A sale holds up to ${STORE_MAX_LINES} different products.`);
  const wanted = new Map<string, { quantity: number; priceMinor?: number; priceReason?: string }>();
  for (const line of input.lines) {
    const productId = line?.productId;
    if (typeof productId !== "string" || productId.length < 1 || productId.length > 64) throw new StoreRefusal("not_found", "That product isn't in your store.");
    if (typeof line.quantity !== "number" || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > STORE_SALE_MAX_QUANTITY) {
      throw new StoreRefusal("invalid", `Choose a quantity from 1 to ${STORE_SALE_MAX_QUANTITY}.`);
    }
    if (wanted.has(productId)) throw new StoreRefusal("invalid", "Each product goes on one line. Change its quantity instead.");
    if (line.priceMinor !== undefined) {
      if (typeof line.priceMinor !== "number" || !Number.isSafeInteger(line.priceMinor) || line.priceMinor < 0 || line.priceMinor > STORE_MAX_AMOUNT) {
        throw new StoreRefusal("invalid", "Enter the price charged, in whole cents.");
      }
    }
    wanted.set(productId, {
      quantity: line.quantity,
      ...(line.priceMinor !== undefined ? { priceMinor: line.priceMinor } : {}),
      ...(line.priceReason !== undefined ? { priceReason: line.priceReason } : {}),
    });
  }
  const email = oneLineText(input.customer?.email, 320)?.toLowerCase() ?? null;
  if (email !== null && !EMAIL.test(email)) throw new StoreRefusal("invalid", "Enter the customer's email address, or leave it blank.");
  const reference = oneLineText(input.reference, 100);
  const idempotencyKey = `${STORE_SALE_KEY_PREFIX}${input.requestKey}`;

  type Done = { kind: "duplicate"; orderId: string } | { kind: "recorded"; orderId: string; orderNumber: string; lines: StoreOrderPlaced["lines"]; total: number; currency: string };
  const done: Done = await db.transaction(async (tx): Promise<Done> => {
    // The company's order lock first: the numbering, and "was this press recorded already?".
    await lockKey(tx, `commerce-orders:${tenantId}`);
    const [already] = (await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.idempotencyKey, idempotencyKey)))
      .limit(1)) as Array<{ id: string }>;
    if (already) return { kind: "duplicate", orderId: already.id };

    const rows = (await tx
      .select(productColumns)
      .from(products)
      .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isDefault, true)))
      .where(and(ownProducts(tenantId), inArray(products.id, [...wanted.keys()])))) as ProductRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const stock = await lockVariants(tx, rows.map((row) => row.variantId));
    const lines: Array<StoreCheckoutLine & { listPriceMinor: number; reason: string | null }> = [];
    for (const [productId, want] of wanted) {
      // Another company's product — or a removed one — is not in this store.
      const row = byId.get(productId);
      if (!row) throw new StoreRefusal("not_found", "That product isn't in your store.");
      const listPriceMinor = Number(row.priceMinor);
      const charged = want.priceMinor ?? listPriceMinor;
      let reason: string | null = null;
      if (charged !== listPriceMinor) {
        reason = oneLineText(want.priceReason, 200);
        if (!reason || reason.length < 3) throw new StoreRefusal("invalid", `Say why ${row.name} is ${formatStoreMoney(charged, row.currency)} instead of ${formatStoreMoney(listPriceMinor, row.currency)}.`);
      }
      lines.push({
        productId: row.id,
        variantId: row.variantId,
        name: row.name,
        quantity: want.quantity,
        unitPriceMinor: charged,
        held: (stock.get(row.variantId)?.inventory ?? null) !== null,
        listPriceMinor,
        reason,
      });
    }
    const currency = byId.get(lines[0]!.productId)!.currency.toLowerCase();
    if (rows.some((row) => row.currency.toLowerCase() !== currency)) throw new StoreRefusal("invalid", "These products are priced in different currencies, so they can't be sold together.");
    let total = 0;
    for (const line of lines) total += line.unitPriceMinor * line.quantity;
    if (!Number.isSafeInteger(total) || total > STORE_MAX_AMOUNT) throw new StoreRefusal("invalid", "That's more than one sale can record. Split it into smaller sales.");

    // The stock: free stock only (online checkouts keep what they hold), taken once, here.
    for (const line of [...lines].sort(byVariant)) {
      const variant = stock.get(line.variantId);
      if (!line.held || !variant || variant.inventory === null) continue;
      const free = Math.max(0, variant.inventory - variant.held);
      if (free < line.quantity) {
        throw new StoreRefusal("sold_out", free <= 0 ? `${line.name} is out of stock. Add stock first, then record the sale.` : `Only ${free} of ${line.name} ${free === 1 ? "is" : "are"} in stock.`);
      }
      variant.inventory -= line.quantity;
      await tx.update(productVariants).set({ inventory: variant.inventory, updatedAt: now }).where(eq(productVariants.id, variant.id));
    }

    const [counted] = (await tx.select({ n: count() }).from(orders).where(eq(orders.tenantId, tenantId))) as Array<{ n: number }>;
    const orderNumber = formatOrderNumber({ prefix: options.orderPrefix ?? "ORD", sequence: Number(counted?.n ?? 0) + 1, date: now });
    const name = oneLineText(input.customer?.name, 200);
    const phone = oneLineText(input.customer?.phone, 60);
    const wantsReceipt = input.sendReceipt === true && email !== null;
    const [order] = (await tx
      .insert(orders)
      .values({
        tenantId,
        idempotencyKey,
        orderNumber,
        userId: null,
        email: email ?? "",
        status: "paid",
        subtotalMinor: BigInt(total),
        shippingMinor: 0n,
        taxMinor: 0n,
        discountMinor: 0n,
        totalMinor: BigInt(total),
        currency,
        placedAt: now,
        // Who paid, never where to send it: a counter sale has nothing to ship,
        // and a name in shipping_address read as an order waiting to go out.
        ...(name || phone ? { billingAddress: { ...(name ? { name } : {}), ...(phone ? { phone } : {}) } as OrderAddress } : {}),
        // Staff made the sale: the owner's "new order" email isn't owed, and
        // a receipt nobody asked for is deliberately skipped.
        noticeSentAt: now,
        ...(wantsReceipt ? {} : { receiptSentAt: now }),
        paymentMethod: input.method,
        paymentReference: reference,
        recordedBy: options.recordedBy,
      })
      .returning({ id: orders.id })) as Array<{ id: string }>;
    const orderId = order!.id;
    await tx.insert(orderItems).values(
      lines.map((line) => ({
        orderId,
        productRef: line.productId,
        variantRef: line.variantId,
        name: line.name,
        quantity: line.quantity,
        unitPriceMinor: BigInt(line.unitPriceMinor),
        totalMinor: BigInt(line.unitPriceMinor * line.quantity),
        ...(line.reason
          ? { metadata: { listPriceMinor: String(line.listPriceMinor), priceReason: line.reason, ...(options.recordedBy ? { priceChangedBy: options.recordedBy } : {}) } }
          : {}),
      })),
    );
    return {
      kind: "recorded",
      orderId,
      orderNumber,
      lines: lines.map((line) => ({ name: line.name, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor })),
      total,
      currency,
    };
  });

  const [wire] = await listStoreOrders(db, tenantId, { orderId: done.orderId, limit: 1 });
  if (!wire) throw new StoreRefusal("not_found", "That sale isn't here any more.");
  if (done.kind === "duplicate") return { order: wire, duplicate: true, receipt: "not_asked" };

  const wantsReceipt = input.sendReceipt === true && email !== null;
  let receipt: StoreSaleResult["receipt"] = email === null ? (input.sendReceipt === true ? "no_email" : "not_asked") : wantsReceipt ? "failed" : "not_asked";
  if (options.onOrder) {
    const placed: StoreOrderPlaced = {
      tenantId,
      orderId: done.orderId,
      orderNumber: done.orderNumber,
      email: email ?? "",
      totalMinor: done.total,
      shippingMinor: 0,
      currency: done.currency,
      lines: done.lines,
      shipTo: wire.shipTo ?? null,
      placedAt: now,
      buyer: wire.buyer,
    };
    try {
      const went = (await options.onOrder(placed, { receipt: wantsReceipt, notice: false })) ?? {};
      if (wantsReceipt && went.receipt !== false) {
        await db.update(orders).set({ receiptSentAt: new Date() }).where(and(eq(orders.id, done.orderId), eq(orders.tenantId, tenantId)));
        receipt = "sent";
      }
    } catch (error) {
      // The sale stands: the money changed hands. The receipt can go again.
      options.report?.(error);
    }
  }
  return { order: wire, duplicate: false, receipt };
}

/** "Mark as sent": a paid order is now on its way. Null: not this business's order. */
export async function markStoreOrderSent(db: StoreDb, tenantId: string, orderId: string): Promise<StoreOrderWire | null> {
  const [row] = (await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string; status: string }>;
  if (!row) return null;
  if (row.status !== "paid" && row.status !== "fulfilled") throw new StoreRefusal("invalid", "Only a paid order can be marked as sent.");
  await db
    .update(orders)
    .set({ status: "fulfilled", updatedAt: new Date() })
    .where(and(eq(orders.id, row.id), eq(orders.tenantId, tenantId), eq(orders.status, "paid")));
  const [wire] = await listStoreOrders(db, tenantId, { orderId: row.id, limit: 1 });
  return wire ?? null;
}

export type StoreAlertRow = typeof storeAlerts.$inferSelect;

export function storeAlertWire(row: StoreAlertRow): StoreAlertWire {
  return {
    id: row.id,
    kind: row.kind,
    message: row.message,
    amount: row.amount,
    currency: row.currency,
    orderId: row.orderId,
    stripeUrl: storeStripePaymentUrl(row.paymentIntentId),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/** The business's store problems: the open ones first (newest first), then up to `handled` handled ones. */
export async function listStoreAlerts(db: StoreDb, tenantId: string, options: { readonly handled?: number } = {}): Promise<{ open: StoreAlertRow[]; handled: StoreAlertRow[] }> {
  const open = (await db
    .select()
    .from(storeAlerts)
    .where(and(eq(storeAlerts.tenantId, tenantId), isNull(storeAlerts.resolvedAt)))
    .orderBy(desc(storeAlerts.createdAt))
    .limit(200)) as StoreAlertRow[];
  const handled = (await db
    .select()
    .from(storeAlerts)
    .where(and(eq(storeAlerts.tenantId, tenantId), isNotNull(storeAlerts.resolvedAt)))
    .orderBy(desc(storeAlerts.resolvedAt))
    .limit(options.handled ?? 10)) as StoreAlertRow[];
  return { open, handled };
}

/** How many store problems the business hasn't handled yet (the nav's badge). */
export async function openStoreAlertCount(db: StoreDb, tenantId: string): Promise<number> {
  const [row] = (await db
    .select({ n: count() })
    .from(storeAlerts)
    .where(and(eq(storeAlerts.tenantId, tenantId), isNull(storeAlerts.resolvedAt)))) as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

/** "Mark as handled": null when it isn't this business's. */
export async function resolveStoreAlert(db: StoreDb, tenantId: string, id: string, userId: string | null, now: Date = new Date()): Promise<StoreAlertRow | null> {
  await db
    .update(storeAlerts)
    .set({ resolvedAt: now, resolvedBy: userId })
    .where(and(eq(storeAlerts.id, id), eq(storeAlerts.tenantId, tenantId), isNull(storeAlerts.resolvedAt)));
  const [row] = (await db
    .select()
    .from(storeAlerts)
    .where(and(eq(storeAlerts.id, id), eq(storeAlerts.tenantId, tenantId)))
    .limit(1)) as StoreAlertRow[];
  return row ?? null;
}

/**
 * The storage purpose a product photo is kept under (structurally
 * @adminigloo/storage's `StoragePurpose`): PUBLIC (it is on the store page),
 * COUNTED in the business's storage allowance like any file, and not
 * removable from the Files screen (that would break the store page; remove
 * the photo on the product instead).
 */
export const STORE_PHOTO_PURPOSE = {
  key: "store.photo",
  label: "Product photo",
  access: "public",
  types: ["jpeg", "png", "webp", "gif"],
  maxBytes: 4 * 1024 * 1024,
  removableFromFiles: false,
} as const satisfies {
  readonly key: string;
  readonly label: string;
  readonly access: "public";
  readonly types: readonly ("jpeg" | "png" | "webp" | "gif")[];
  readonly maxBytes: number;
  readonly removableFromFiles: boolean;
};
