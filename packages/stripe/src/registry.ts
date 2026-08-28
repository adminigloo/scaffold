import type Stripe from "stripe";

export type StripeEventType = Stripe.Event["type"];

/** The concrete event interface for one `type`, e.g. `CheckoutSessionCompletedEvent`. */
export type StripeEventOf<TType extends StripeEventType> = Extract<
  Stripe.Event,
  { type: TType }
>;

export type StripeEventHandler<TType extends StripeEventType = StripeEventType> = (
  event: StripeEventOf<TType>,
) => Promise<void> | void;

export class DuplicateEventHandlerError extends Error {
  readonly name = "DuplicateEventHandlerError";
  constructor(readonly type: string) {
    super(
      `A handler is already registered for "${type}". Two handlers for one event ` +
        `is the trailcards double-write bug in miniature: both run, both believe ` +
        `they own the invariant, and the order they run in decides the outcome. ` +
        `Compose the work into a single handler instead.`,
    );
  }
}

export interface DispatchResult {
  readonly type: string;
  /** False when no handler is registered — recorded, not an error. See `dispatch`. */
  readonly handled: boolean;
}

export interface EventRegistry {
  /**
   * Register the one handler for an event type. Throws if the type is taken.
   * Returns the registry so registrations chain.
   */
  on<TType extends StripeEventType>(
    type: TType,
    handler: StripeEventHandler<TType>,
  ): EventRegistry;
  handlerFor(type: string): StripeEventHandler | undefined;
  /**
   * The types this registry answers for, in registration order.
   *
   * Exported so a test can assert it against the event list configured on the
   * Stripe endpoint. An event enabled in the dashboard with no handler here is
   * invisible otherwise — it is delivered, ledgered, and quietly discarded.
   */
  handledTypes(): readonly StripeEventType[];
  dispatch(event: Stripe.Event): Promise<DispatchResult>;
}

export interface EventRegistryOptions {
  /**
   * Called for a delivery with no registered handler. Log it here; the
   * dispatch still counts as a success.
   */
  readonly onUnhandled?: (event: Stripe.Event) => void;
}

/**
 * A registry mapping one Stripe event type to exactly one handler.
 *
 * "Exactly one" is the invariant, and it is enforced at registration rather
 * than left to convention. trailcards has `checkout.session.completed` and
 * `payment_intent.succeeded` both creating orders and cross-checking each
 * other's work; each is individually reasonable and together they are two
 * writers for one invariant. A registry that silently accepted a second
 * handler for a type would rebuild that bug inside a single file.
 */
export function createEventRegistry(
  options: EventRegistryOptions = {},
): EventRegistry {
  // The map erases the per-type narrowing `on` enforces at its boundary: a
  // handler for one concrete event is not assignable to one accepting the whole
  // union, because parameters are contravariant. Widening is sound HERE, and
  // only here, because a handler is filed under the literal `type` it was
  // registered with and is only ever retrieved by `event.type` — so the event
  // reaching it always matches the type it declared.
  const handlers = new Map<string, StripeEventHandler>();

  const registry: EventRegistry = {
    on(type, handler) {
      if (handlers.has(type)) throw new DuplicateEventHandlerError(type);
      handlers.set(type, handler as unknown as StripeEventHandler);
      return registry;
    },

    handlerFor(type) {
      return handlers.get(type);
    },

    handledTypes() {
      return [...handlers.keys()] as StripeEventType[];
    },

    /**
     * Run the handler for this event.
     *
     * An unregistered type resolves as a SUCCESS with `handled: false`, not an
     * error. Stripe delivers every event type enabled on the endpoint, and
     * enabling a type nobody handles is normal — someone turned it on to see
     * the shape. Throwing would answer 500, Stripe would retry for three days
     * and then disable the endpoint, taking the events we DO handle with it.
     *
     * A handler that throws is left to propagate, deliberately. The caller must
     * not stamp `processed_at` and must answer 500, so the delivery is retried
     * against a row that is still unclaimed-and-unfinished.
     */
    async dispatch(event) {
      const handler = handlers.get(event.type);
      if (!handler) {
        options.onUnhandled?.(event);
        return { type: event.type, handled: false };
      }
      await handler(event);
      return { type: event.type, handled: true };
    },
  };

  return registry;
}
