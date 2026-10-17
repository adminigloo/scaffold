import { formatStoreMoney, type StoreOrderPlaced } from "./store.js";

/**
 * THE ORDER EMAILS (commerce 0.2), the way @adminigloo/booking's platform
 * emails are sent — many businesses, one sending address:
 *
 *   - From "{business} via {app}" (one business: its own name);
 *   - replies go to the owner's VERIFIED sign-in address (the app passes it),
 *     never an address a business typed into its settings;
 *   - the only words a business typed that reach a subject are its cleaned
 *     name, inside a fixed sentence; product names appear in the body only;
 *   - every email ends "Sent for {business} by {app}."
 *
 * Plain text; the app's sender adds nothing.
 */

/** COPIED FROM @adminigloo/booking's emails.ts (sanitizeEmailName); change both or neither. */
export function cleanEmailName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f<>"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim();
}

export interface StoreEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly replyTo: string | null;
}

export interface StoreOrderEmails {
  readonly fromName: string;
  /** The customer's receipt; null without a customer email. */
  readonly customer: StoreEmail | null;
  /** The owner's "new order"; null without an owner address. */
  readonly owner: StoreEmail | null;
}

export interface StoreOrderEmailOptions {
  readonly businessName: string;
  /** This site's name. With it, the From reads "{business} via {app}"; without (one business), just the business. */
  readonly appName?: string | null;
  /** Where the customer's replies go: the owner's verified sign-in address. */
  readonly replyTo: string | null;
  /** Where the owner's notice goes (the same address, usually). */
  readonly ownerEmail: string | null;
  /** The owner's orders screen, absolute. */
  readonly ordersUrl: string;
  readonly locale?: string;
}

export function storeOrderEmails(order: StoreOrderPlaced, options: StoreOrderEmailOptions): StoreOrderEmails {
  const business = cleanEmailName(options.businessName) || "the business";
  const app = options.appName ? cleanEmailName(options.appName) : "";
  const fromName = app && app !== business ? cleanEmailName(`${business} via ${app}`) : business;
  const footer = app && app !== business ? `Sent for ${business} by ${app}.` : `Sent by ${business}.`;
  const money = (minor: number) => formatStoreMoney(minor, order.currency, options.locale);
  const lines = [
    ...order.lines.map((line) => `  ${line.quantity} × ${line.name.replace(/[\u0000-\u001f\u007f]/g, " ")} — ${money(line.unitPriceMinor * line.quantity)}`),
    ...(order.shippingMinor > 0 ? [`  Shipping — ${money(order.shippingMinor)}`] : []),
  ].join("\n");
  const ship = order.shipTo;
  const to = ship
    ? [ship.name, ship.line1, ship.line2, [ship.city, ship.region, ship.postalCode].filter(Boolean).join(" "), ship.country].filter((part) => part && part.length > 0).join(", ")
    : "";
  const customer: StoreEmail | null = order.email
    ? {
        to: order.email,
        subject: `Your order from ${business} — ${order.orderNumber}`,
        text: [
          `Thank you for your order from ${business}.`,
          "",
          `Order ${order.orderNumber}`,
          lines,
          `  Total paid: ${money(order.totalMinor)}`,
          "",
          `Questions about your order? Reply to this email and it goes to ${business}.`,
          "",
          footer,
        ].join("\n"),
        replyTo: options.replyTo,
      }
    : null;
  const owner: StoreEmail | null = options.ownerEmail
    ? {
        to: options.ownerEmail,
        subject: `New order ${order.orderNumber} — ${money(order.totalMinor)}`,
        text: [
          `A customer${order.email ? ` (${order.email})` : ""} placed an order on your store.`,
          "",
          `Order ${order.orderNumber}`,
          lines,
          `  Total paid: ${money(order.totalMinor)}`,
          "",
          ...(to ? [`Send it to: ${to}`, ""] : []),
          `See it and mark it as sent: ${options.ordersUrl}`,
          "",
          footer,
        ].join("\n"),
        replyTo: order.email || null,
      }
    : null;
  return { fromName, customer, owner };
}
