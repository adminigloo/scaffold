import { stripeConnectedAccounts } from "@adminigloo/stripe/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STORE_ADMIN_ROUTE_PERMISSIONS, STORE_ADMIN_ROUTES, STORE_PUBLIC_ROUTES } from "../store-routes.js";
import { createStoreAdminHandlers, createStorePublicHandlers, sniffStorePhoto, type StorePhotoStore } from "../store-handlers.js";
import { createStoreProduct, type StoreCardPayments } from "../store.js";
import { parseMoneyInput, moneyInputValue } from "../widget/money.js";
import { draftOf, productBody, stockWords, StoreAdmin } from "../widget/StoreAdmin.js";
import { cartTotal, Storefront } from "../widget/Storefront.js";
import { withQuantity } from "../widget/cart.js";
import { storeCss } from "../widget/styles.js";
import { createTestDb, schemaDdl, tenant, type TestDb } from "./pglite.js";

/**
 * The store's two handlers over HTTP-shaped requests: every route of the
 * route tables answers, another company's row named in the path is "not
 * found", a cross-site POST is refused, and the permission asked is the
 * table's. Plus the screens' pure pieces (prices typed by the owner, the
 * cart) and that they render.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  for (const statement of schemaDdl([stripeConnectedAccounts])) await t.client.exec(statement);
});
afterAll(async () => {
  await t?.close();
});

const payments: StoreCardPayments = {
  ready: async () => ({ ready: true, accountId: "acct_h" }),
  createSession: async (input) => ({ id: `cs_${input.checkoutId}`, url: `https://checkout.stripe.test/${input.checkoutId}` }),
  expireSession: async () => undefined,
};
const photos: StorePhotoStore & { kept: string[] } = {
  kept: [],
  async put(input) {
    const fileId = `f${photos.kept.length}`;
    photos.kept.push(fileId);
    void input;
    return { url: `https://files.test/${fileId}`, fileId };
  },
  async delete() {},
};

function adminFor(asked: string[]) {
  return createStoreAdminHandlers({
    db: t.db,
    resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null,
    authorize: (_req, permission) => {
      asked.push(permission);
      return { userId: "u1" };
    },
    payments,
    photoStore: photos,
    productLimit: () => 20,
  });
}

function pub() {
  return createStorePublicHandlers({
    db: t.db,
    resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null,
    payments,
    business: () => ({ name: "Green Acres" }),
    thanksUrl: (id) => `https://app.test/thanks/${id}`,
    storeUrl: () => "https://app.test/store",
  });
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function send(path: string, method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.test${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

function fill(text: string, rows: Record<string, string>) {
  return text.replace(/\{([a-z-]+)\}/g, (_, name: string) => rows[name] ?? `missing-${name}`);
}

describe("the store's handlers", () => {
  it("answers every admin route of the table for the company's own rows, asking the table's permission", async () => {
    const a = tenant("a");
    const product = await createStoreProduct(t.db, a, { name: "Soap", priceMinor: 500, currency: "usd" });
    const rows: Record<string, string> = { "store-product": product.id, "store-order": "none", "store-alert": "none" };
    for (const route of STORE_ADMIN_ROUTES) {
      if (route.kind === "order-sent" || route.kind === "attention-resolve" || route.kind === "product-remove") continue;
      const asked: string[] = [];
      const res = await adminFor(asked).handle(send(`/api/app/${a}/store/${fill(route.path, rows)}`, route.method, route.method === "POST" ? JSON.parse(fill(JSON.stringify(route.body), rows)) : undefined));
      expect(res.status, `${route.kind}: ${await res.clone().text()}`).toBeLessThan(300);
      expect(asked).toEqual([STORE_ADMIN_ROUTE_PERMISSIONS[route.kind]]);
    }
    const remove = await adminFor([]).handle(send(`/api/app/${a}/store/v1/admin/products/${product.id}/remove`, "POST", {}));
    expect(remove.status).toBe(200);
  });

  it("answers \"not found\" for another company's product in the path, and changes nothing", async () => {
    const a = tenant("a");
    const b = tenant("b");
    const aProduct = await createStoreProduct(t.db, a, { name: "A only", priceMinor: 500, currency: "usd" });
    for (const route of STORE_ADMIN_ROUTES.filter((r) => r.path.includes("{store-product}"))) {
      const res = await adminFor([]).handle(send(`/api/app/${b}/store/${fill(route.path, { "store-product": aProduct.id })}`, route.method, route.body ? JSON.parse(fill(JSON.stringify(route.body), { "store-product": aProduct.id })) : undefined));
      expect(res.status, route.kind).toBe(404);
      expect(await res.text()).not.toContain("A only");
    }
    const listed = await (await adminFor([]).handle(send(`/api/app/${a}/store/v1/admin/products`, "GET"))).json();
    expect(listed.products.map((p: { name: string }) => p.name)).toEqual(["A only"]);
  });

  it("refuses a cross-site POST", async () => {
    const a = tenant("a");
    const res = await adminFor([]).handle(send(`/api/app/${a}/store/v1/admin/products`, "POST", { name: "X", priceMinor: 100, currency: "usd" }, { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
  });

  it("serves the store page and Check out at the company's address, refusing another company's product", async () => {
    const a = tenant("a");
    const b = tenant("b");
    const aProduct = await createStoreProduct(t.db, a, { name: "A soap", priceMinor: 800, currency: "usd", stock: 2 });
    const page = await (await pub().handle(send(`/api/t/${a}/store/v1/store`, "GET"))).json();
    expect(page.products.map((p: { name: string }) => p.name)).toEqual(["A soap"]);
    expect(page.takingOrders).toBe(true);
    const ok = await pub().handle(send(`/api/t/${a}/store/v1/store/checkout`, "POST", { cartId: "cart-aaaaaaaa", lines: [{ productId: aProduct.id, quantity: 1 }] }));
    expect(ok.status).toBe(200);
    const started = await ok.json();
    expect(started.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const status = await (await pub().handle(send(`/api/t/${a}/store/v1/store/checkouts/${started.checkoutId}`, "GET"))).json();
    expect(status).toMatchObject({ state: "pending", totalMinor: 800 });
    // Under B's address: A's product isn't for sale, A's checkout isn't there.
    const forged = await pub().handle(send(`/api/t/${b}/store/v1/store/checkout`, "POST", { cartId: "cart-bbbbbbbb", lines: [{ productId: aProduct.id, quantity: 1 }] }));
    expect(forged.status).toBe(404);
    expect((await pub().handle(send(`/api/t/${b}/store/v1/store/checkouts/${started.checkoutId}`, "GET"))).status).toBe(404);
    for (const route of STORE_PUBLIC_ROUTES) expect(route.permission).toBeNull();
  });
});

describe("the screens' pieces", () => {
  it("reads a typed price by string arithmetic, never floating point", () => {
    expect(parseMoneyInput("12.5", "usd")).toBe(1250);
    expect(parseMoneyInput("$0.10", "usd")).toBe(10);
    expect(parseMoneyInput("19.99", "usd")).toBe(1999);
    expect(parseMoneyInput("1,200", "usd")).toBeNull();
    expect(parseMoneyInput("1.234", "usd")).toBeNull();
    expect(parseMoneyInput("1200", "jpy")).toBe(1200);
    expect(parseMoneyInput("12.5", "jpy")).toBeNull();
    expect(moneyInputValue(1205, "usd")).toBe("12.05");
    expect(productBody({ name: "Soap", description: "", price: "4.20", currency: "usd", forSale: true, counting: true, stock: "3", maxPerOrder: "5" })).toEqual({
      body: { name: "Soap", description: "", priceMinor: 420, currency: "usd", status: "active", maxPerOrder: 5, stock: 3 },
    });
    expect(productBody({ name: "Soap", description: "", price: "", currency: "usd", forSale: true, counting: false, stock: "", maxPerOrder: "5" })).toEqual({ problem: "Type the price like 12.50." });
  });

  it("sends the shelf count only when the owner changed it, with the number the form started from", () => {
    const product = { id: "p1", name: "Soap", description: null, priceMinor: 420, currency: "usd", status: "active" as const, stock: 5, held: 2, maxPerOrder: 5, photoUrl: null };
    const unchanged = productBody({ ...draftOf(product, "usd"), name: "Soap bar" }, product);
    expect("body" in unchanged && unchanged.body).not.toHaveProperty("stock");
    const changed = productBody({ ...draftOf(product, "usd"), stock: "8" }, product);
    expect("body" in changed && changed.body).toMatchObject({ stock: 8, stockWas: 5 });
    expect(stockWords(product)).toBe("On the shelf: 5 · Held in carts: 2 · Available: 3");
  });

  it("keeps ids and quantities in the cart, never a price", () => {
    let cart = { id: "cart-xxxxxxxx", lines: [] as Array<{ productId: string; quantity: number }> };
    cart = withQuantity(cart, "p1", 2) as typeof cart;
    cart = withQuantity(cart, "p2", 1) as typeof cart;
    cart = withQuantity(cart, "p1", 3) as typeof cart;
    expect(cart.lines).toEqual([
      { productId: "p1", quantity: 3 },
      { productId: "p2", quantity: 1 },
    ]);
    expect(Object.keys(cart.lines[0]!)).toEqual(["productId", "quantity"]);
    const total = cartTotal(cart, [
      { id: "p1", name: "A", description: null, priceMinor: 100, currency: "usd", photoUrl: null, soldOut: false, fewLeft: null, maxPerOrder: 5 },
      { id: "p2", name: "B", description: null, priceMinor: 250, currency: "usd", photoUrl: null, soldOut: false, fewLeft: null, maxPerOrder: 5 },
    ]);
    expect(total).toEqual({ minor: 550, currency: "usd", count: 4 });
  });

  it("takes every colour from the app's theme tokens, with dark fallbacks, never a fixed white under inherited text", () => {
    expect(storeCss).toContain("--aics-surface: var(--color-surface, #ffffff)");
    expect(storeCss).toContain("@media (prefers-color-scheme: dark)");
    expect(storeCss).not.toMatch(/background:\s*#fff/i);
    expect(storeCss).not.toMatch(/color:\s*inherit/);
  });

  it("renders the owner's screen and the store page", () => {
    expect(renderToStaticMarkup(<StoreAdmin baseUrl="/api/app/c/store" storefrontUrl="/t/green/store" />)).toContain("See your store");
    expect(renderToStaticMarkup(<Storefront baseUrl="/api/t/green/store" />)).toContain("Loading");
  });

  it("knows a photo by its bytes", () => {
    expect(sniffStorePhoto(new Uint8Array(Buffer.from(PNG, "base64")))).toBe("image/png");
    expect(sniffStorePhoto(new TextEncoder().encode("<svg/>"))).toBeNull();
  });
});
