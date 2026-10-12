import { useMemo } from "react";
import { createEstimatorClient, type EstimatorPublicTransport } from "./client.js";
import type { Result } from "./http.js";
import type { EmbedMeasurement, EmbedOption, EmbedProduct, EmbedRange, EmbedTakeoff, SubmitBody } from "./types.js";

/**
 * Choosing a transport, and 0.1's class kept for the hosts that call it.
 *
 * Every component takes `transport` OR `baseUrl` (+ `clientKey`) (contract
 * 9.1). With both, `transport` wins — a host backing the estimator with tRPC
 * or a server action passes its own object. With neither, the component still
 * renders: every call answers one plain error rather than throwing in React.
 */

const MISSING: Result<never> = {
  ok: false,
  error: { code: "bad_response", message: "This page isn't connected to an estimator server yet.", status: 0 },
};

/** A transport whose every call answers "not connected" (no `baseUrl`, no `transport`). */
export function missingPublicTransport(): EstimatorPublicTransport {
  const fail = () => Promise.resolve(MISSING);
  return { config: fail, calculate: fail, photo: fail, takeoff: fail, submit: fail, quote: fail, acceptQuote: fail, declineQuote: fail };
}

export function usePublicTransport(
  transport: EstimatorPublicTransport | undefined,
  baseUrl: string | undefined,
  clientKey: string | undefined,
): EstimatorPublicTransport {
  return useMemo(
    () => transport ?? (baseUrl ? createEstimatorClient({ baseUrl, ...(clientKey ? { clientKey } : {}) }) : missingPublicTransport()),
    [transport, baseUrl, clientKey],
  );
}

/** A promise that settles after `ms` (the fill-time wait). */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ---------------------------------------------------------------------------
// 0.1's class
// ---------------------------------------------------------------------------

/** 0.1's submit shape (the server still takes these names as aliases). */
export interface SubmitInput {
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  jobAddress?: string | null;
  source?: "public_tool" | "photo";
  items: Array<{
    productId: string;
    description: string;
    measurement: EmbedMeasurement;
    quantity: number;
    optionValueIds: string[];
  }>;
}

/**
 * @deprecated 0.1's wire client, kept with its 0.1 method shapes as a thin
 * wrapper over `createEstimatorClient` (contract 9.1). New code uses
 * `createEstimatorClient`, whose calls return `Result`s with the server's
 * reason instead of an empty list or null.
 *
 * Every method still resolves on failure (an empty list, null), never
 * rejects, so a flaky network degrades a 0.1 host instead of crashing it.
 */
export class EstimatorTransport {
  /** The 0.2 client underneath; the provider's components use it. */
  readonly client: ReturnType<typeof createEstimatorClient>;

  constructor(baseUrl: string, clientKey?: string) {
    this.client = createEstimatorClient({ baseUrl, ...(clientKey ? { clientKey } : {}) });
  }

  async config(): Promise<EmbedProduct[]> {
    const res = await this.client.config();
    if (!res.ok) return [];
    return res.data.products.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      description: p.description,
      measurementMode: p.measurementMode,
      isEstimatable: p.isEstimatable,
    }));
  }

  async options(productId: string): Promise<EmbedOption[]> {
    const res = await this.client.options(productId);
    return res.ok ? res.data.options : [];
  }

  async calculate(input: { productId: string; measurement: EmbedMeasurement; quantity: number; optionValueIds: string[] }): Promise<EmbedRange | null> {
    const res = await this.client.calculate(input);
    return res.ok ? res.data.result : null;
  }

  async submit(input: SubmitInput): Promise<{ estimateNumber: string } | null> {
    // 0.1 sent no fill time; the server lets a keyed body without one through
    // (allowLegacyWidgetBodies), exactly as it let 0.1 widgets through before.
    const body: SubmitBody = {
      name: input.customerName?.trim() ?? "",
      ...(input.customerEmail?.trim() ? { email: input.customerEmail.trim() } : {}),
      ...(input.customerPhone?.trim() ? { phone: input.customerPhone.trim() } : {}),
      ...(input.jobAddress?.trim() ? { address: input.jobAddress.trim() } : {}),
      items: input.items.map((item) => ({
        productId: item.productId,
        description: item.description,
        measurement: item.measurement,
        quantity: item.quantity,
        optionValueIds: item.optionValueIds,
      })),
    };
    const res = await this.client.submit(body);
    return res.ok ? { estimateNumber: res.data.estimateNumber } : null;
  }

  /**
   * The model no longer measures (estimator 0.3, rule A), so `result` is
   * always null; `available` still says whether photos are read here.
   */
  async takeoff(input: { productId: string; imageBase64: string; mediaType: string }): Promise<{ available: boolean; result: EmbedTakeoff | null }> {
    const mediaType = input.mediaType === "image/png" || input.mediaType === "image/webp" ? input.mediaType : "image/jpeg";
    const res = await this.client.takeoff({ productId: input.productId, imageBase64: input.imageBase64, mediaType });
    return { available: res.ok ? res.data.available : true, result: null };
  }
}
