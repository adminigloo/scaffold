import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import {
  createEventRegistry,
  DuplicateEventHandlerError,
  type StripeEventType,
} from "../registry.js";

function event(type: StripeEventType, id = "evt_1"): Stripe.Event {
  return {
    id,
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: 1_756_382_400,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object: { id: "obj_1", metadata: {} } },
  } as unknown as Stripe.Event;
}

describe("createEventRegistry — one handler per type", () => {
  it("rejects a second handler for a type it already knows", () => {
    const registry = createEventRegistry();
    registry.on("checkout.session.completed", () => {});
    expect(() => registry.on("checkout.session.completed", () => {})).toThrow(
      DuplicateEventHandlerError,
    );
  });

  it("keeps the first handler after rejecting the second", () => {
    // The throw must not have half-registered anything: the original handler is
    // still the one that runs.
    const first = vi.fn();
    const registry = createEventRegistry();
    registry.on("payment_intent.succeeded", first);
    expect(() => registry.on("payment_intent.succeeded", vi.fn())).toThrow();
    expect(registry.handlerFor("payment_intent.succeeded")).toBe(first);
  });

  it("names the type in the error so the collision is findable", () => {
    const registry = createEventRegistry();
    registry.on("charge.refunded", () => {});
    expect(() => registry.on("charge.refunded", () => {})).toThrow(/charge\.refunded/);
  });

  it("allows different types, and chains", () => {
    const registry = createEventRegistry()
      .on("checkout.session.completed", () => {})
      .on("payment_intent.succeeded", () => {});
    expect(registry.handledTypes()).toEqual([
      "checkout.session.completed",
      "payment_intent.succeeded",
    ]);
  });
});

describe("dispatch", () => {
  it("routes to the handler registered for that type, and only that one", async () => {
    const completed = vi.fn();
    const succeeded = vi.fn();
    const registry = createEventRegistry()
      .on("checkout.session.completed", completed)
      .on("payment_intent.succeeded", succeeded);

    const result = await registry.dispatch(event("checkout.session.completed"));

    expect(result).toEqual({ type: "checkout.session.completed", handled: true });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(succeeded).not.toHaveBeenCalled();
  });

  it("awaits an async handler before reporting success", async () => {
    // If dispatch did not await, processed_at would be stamped while the work
    // was still in flight — the exact state the two-phase ledger exists to
    // make impossible.
    const order: string[] = [];
    const registry = createEventRegistry().on(
      "invoice.paid",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("handler");
      },
    );
    await registry.dispatch(event("invoice.paid"));
    order.push("dispatch-returned");
    expect(order).toEqual(["handler", "dispatch-returned"]);
  });

  it("treats an unregistered type as a success, not an error", async () => {
    // Stripe delivers every type enabled on the endpoint. Throwing here would
    // answer 500, Stripe would retry for three days and then disable the
    // endpoint, taking the events we DO handle with it.
    const registry = createEventRegistry();
    await expect(registry.dispatch(event("customer.created"))).resolves.toEqual({
      type: "customer.created",
      handled: false,
    });
  });

  it("hands an unhandled event to the observer so it is still visible", async () => {
    const onUnhandled = vi.fn();
    const registry = createEventRegistry({ onUnhandled });
    const unhandled = event("customer.created", "evt_unhandled");
    await registry.dispatch(unhandled);
    expect(onUnhandled).toHaveBeenCalledWith(unhandled);
  });

  it("lets a handler's failure propagate so the route can answer 500", async () => {
    const registry = createEventRegistry().on("charge.refunded", () => {
      throw new Error("ledger write failed");
    });
    await expect(registry.dispatch(event("charge.refunded"))).rejects.toThrow(
      "ledger write failed",
    );
  });

  it("propagates a rejected promise from an async handler too", async () => {
    const registry = createEventRegistry().on("charge.refunded", async () => {
      await Promise.reject(new Error("timeout"));
    });
    await expect(registry.dispatch(event("charge.refunded"))).rejects.toThrow("timeout");
  });
});

describe("handledTypes", () => {
  it("is empty on a fresh registry", () => {
    expect(createEventRegistry().handledTypes()).toEqual([]);
  });

  it("is the list you assert against the endpoint's enabled events", () => {
    const registry = createEventRegistry()
      .on("checkout.session.completed", () => {})
      .on("charge.refunded", () => {});
    expect([...registry.handledTypes()].sort()).toEqual([
      "charge.refunded",
      "checkout.session.completed",
    ]);
  });
});

describe("handlerFor", () => {
  it("returns undefined rather than throwing for an unknown type", () => {
    expect(createEventRegistry().handlerFor("nope.not.a.type")).toBeUndefined();
  });
});
