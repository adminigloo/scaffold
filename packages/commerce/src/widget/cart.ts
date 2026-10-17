/**
 * The customer's cart: product ids and quantities only, kept in this
 * browser (localStorage, one cart per store) — never a price. The server
 * prices it at Check out. A random cart id lets a second press of the same
 * cart get the same payment page.
 */
export interface CartLine {
  readonly productId: string;
  readonly quantity: number;
}

export interface Cart {
  readonly id: string;
  readonly lines: readonly CartLine[];
}

function storageKey(baseUrl: string): string {
  return `adminigloo-store-cart:${baseUrl}`;
}

function newCartId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function emptyCart(): Cart {
  return { id: newCartId(), lines: [] };
}

export function loadCart(baseUrl: string): Cart {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(baseUrl));
    if (raw) {
      const parsed = JSON.parse(raw) as Cart;
      if (typeof parsed.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(parsed.id) && Array.isArray(parsed.lines)) {
        return { id: parsed.id, lines: parsed.lines.filter((l) => typeof l.productId === "string" && Number.isInteger(l.quantity) && l.quantity > 0) };
      }
    }
  } catch {
    /* a blocked or broken storage: a fresh cart */
  }
  return emptyCart();
}

export function saveCart(baseUrl: string, cart: Cart): void {
  try {
    globalThis.localStorage?.setItem(storageKey(baseUrl), JSON.stringify(cart));
  } catch {
    /* the cart lives for this page only */
  }
}

export function clearCart(baseUrl: string): void {
  try {
    globalThis.localStorage?.removeItem(storageKey(baseUrl));
  } catch {
    /* nothing kept */
  }
}

/** Set one product's quantity (0 takes it out), at most 99. */
export function withQuantity(cart: Cart, productId: string, quantity: number): Cart {
  const q = Math.max(0, Math.min(99, Math.floor(quantity)));
  if (q === 0) return { id: cart.id, lines: cart.lines.filter((line) => line.productId !== productId) };
  const found = cart.lines.some((line) => line.productId === productId);
  return {
    id: cart.id,
    lines: found ? cart.lines.map((line) => (line.productId === productId ? { productId, quantity: q } : line)) : [...cart.lines, { productId, quantity: q }],
  };
}
