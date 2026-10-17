/**
 * What the store's routes answer, as plain JSON types (commerce 0.2). The
 * screens in `@adminigloo/commerce/widget` read exactly these; nothing here
 * imports a table, so a browser bundle can import them for free.
 */

/** One product as its owner edits it. Money in minor units (cents). */
export interface StoreProductWire {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly priceMinor: number;
  readonly currency: string;
  /** "active" is on the store; "inactive" is kept but not for sale. */
  readonly status: "active" | "inactive";
  /** How many are ON THE SHELF (what the owner counts). null: no count kept (always in stock). */
  readonly stock: number | null;
  /** How many of those open checkout pages hold right now (customers who haven't paid yet). */
  readonly held: number;
  /** The most of this product one order may have (default 5). */
  readonly maxPerOrder: number;
  readonly photoUrl: string | null;
}

/** How customers get their order, and what the store says about tax. */
export interface StoreSettingsWire {
  /** "ship": the customer gives an address and pays the flat shipping. "pickup": pickup or digital only. */
  readonly fulfilment: "ship" | "pickup";
  readonly shipCountries: readonly string[];
  readonly shippingMinor: number;
  readonly currency: string;
  readonly pricesIncludeTax: boolean;
}

/** One product as a customer sees it on the store page. */
export interface StorePublicProductWire {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly priceMinor: number;
  readonly currency: string;
  readonly photoUrl: string | null;
  /** Nothing left to buy — counting what THIS cart already holds as the customer's own. */
  readonly soldOut: boolean;
  /** How many are left when a count is kept and it is low (5 or fewer); otherwise null. */
  readonly fewLeft: number | null;
  /** The most of this product one order may have. */
  readonly maxPerOrder: number;
}

export interface StoreBusinessWire {
  readonly name: string;
  readonly logoUrl: string | null;
}

/** GET v1/store. */
export interface StorePublicResponse {
  readonly business: StoreBusinessWire;
  /** False: the business can't take card payments online right now, so there is no Check out. */
  readonly takingOrders: boolean;
  readonly takingOrdersNote: string | null;
  readonly products: readonly StorePublicProductWire[];
  readonly locale: string;
  /** The flat shipping added at checkout, or null for pickup or digital only. */
  readonly shipping: { readonly minor: number; readonly currency: string } | null;
  readonly pricesIncludeTax: boolean;
}

/** POST v1/store/checkout. */
export interface StoreCheckoutResponse {
  readonly url: string;
  readonly checkoutId: string;
}

/** GET v1/store/checkouts/{id}: the thank-you page's "is my order in?". */
export interface StoreCheckoutStatusResponse {
  /** "paid": the order is in. "pending": not heard from Stripe yet. "processing": a bank payment on its way. "closed": no order (it expired or failed). */
  readonly state: "paid" | "pending" | "processing" | "closed";
  readonly orderNumber: string | null;
  readonly totalMinor: number;
  readonly shippingMinor: number;
  readonly currency: string;
  readonly lines: readonly { readonly name: string; readonly quantity: number; readonly unitPriceMinor: number }[];
}

export interface StoreOrderLineWire {
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly totalMinor: number;
}

/** One order on the owner's orders list. */
export interface StoreOrderWire {
  readonly id: string;
  readonly orderNumber: string;
  readonly email: string;
  /** "paid", "sent" (the owner marked it sent), "refunded". */
  readonly status: "paid" | "sent" | "refunded" | "pending";
  readonly totalMinor: number;
  readonly refundedMinor: number;
  readonly currency: string;
  readonly placedAt: string | null;
  /** A dispute on it, if any. */
  readonly flag: "disputed" | "dispute_lost" | null;
  /** Paid for after its stock had run out: refund it or get more in. */
  readonly oversold: boolean;
  readonly shippingMinor: number;
  /** Where to send it (when the store ships). */
  readonly shipTo: StoreAddressWire | null;
  readonly lines: readonly StoreOrderLineWire[];
  /** The payment in the business's Stripe dashboard (refund it there). */
  readonly stripeUrl: string | null;
}

export interface StoreAddressWire {
  readonly name?: string;
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly region?: string;
  readonly postalCode?: string;
  readonly country?: string;
  readonly phone?: string;
}

export interface StoreOrdersResponse {
  readonly orders: readonly StoreOrderWire[];
}

export interface StoreProductsResponse {
  readonly products: readonly StoreProductWire[];
  /** The plan's product limit; null: none. */
  readonly limit: number | null;
}

export interface StoreStatusResponse {
  readonly takingOrders: boolean;
  /** Why not, in plain words; null when taking orders. */
  readonly takingOrdersNote: string | null;
  /** Can a photo be uploaded here (file storage is set up)? */
  readonly photosEnabled: boolean;
  /** The currency new products start in. */
  readonly currency: string;
  readonly openAttention: number;
  readonly settings: StoreSettingsWire;
}

export interface StoreAlertWire {
  readonly id: string;
  readonly kind: string;
  readonly message: string;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly orderId: string | null;
  readonly stripeUrl: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface StoreAlertsResponse {
  readonly open: readonly StoreAlertWire[];
  readonly handled: readonly StoreAlertWire[];
}

export interface StoreErrorWire {
  readonly error: { readonly code: string; readonly message: string };
}
