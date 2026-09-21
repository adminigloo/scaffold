import type {
  EmbedMeasurement,
  EmbedOption,
  EmbedProduct,
  EmbedRange,
  EmbedTakeoff,
} from "./types.js";

/** Shared with every adminigloo widget; the embed key rides in this header. */
const KEY_HEADER = "x-adminigloo-key";

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
 * The wire client. Holds (baseUrl, clientKey) and sends the key on every call;
 * every method returns a value on failure rather than throwing, so a flaky
 * network degrades the widget instead of crashing the host page.
 */
export class EstimatorTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly clientKey: string,
  ) {}

  private url(path: string): string {
    return this.baseUrl.replace(/\/$/, "") + path;
  }

  private headers(json = false): Record<string, string> {
    return {
      [KEY_HEADER]: this.clientKey,
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  async config(): Promise<EmbedProduct[]> {
    try {
      const res = await fetch(this.url("/v1/config"), { headers: this.headers() });
      if (!res.ok) return [];
      const data = (await res.json()) as { products?: EmbedProduct[] };
      return data.products ?? [];
    } catch {
      return [];
    }
  }

  async options(productId: string): Promise<EmbedOption[]> {
    try {
      const res = await fetch(this.url("/v1/options"), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ productId }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { options?: EmbedOption[] };
      return data.options ?? [];
    } catch {
      return [];
    }
  }

  async calculate(input: {
    productId: string;
    measurement: EmbedMeasurement;
    quantity: number;
    optionValueIds: string[];
  }): Promise<EmbedRange | null> {
    try {
      const res = await fetch(this.url("/v1/calculate"), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(input),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { result?: EmbedRange | null };
      return data.result ?? null;
    } catch {
      return null;
    }
  }

  async submit(input: SubmitInput): Promise<{ estimateNumber: string } | null> {
    try {
      const res = await fetch(this.url("/v1/submit"), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(input),
      });
      if (!res.ok) return null;
      return (await res.json()) as { estimateNumber: string };
    } catch {
      return null;
    }
  }

  async takeoff(input: {
    productId: string;
    imageBase64: string;
    mediaType: string;
  }): Promise<{ available: boolean; result: EmbedTakeoff | null }> {
    try {
      const res = await fetch(this.url("/v1/takeoff"), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(input),
      });
      if (!res.ok) return { available: true, result: null };
      return (await res.json()) as { available: boolean; result: EmbedTakeoff | null };
    } catch {
      return { available: true, result: null };
    }
  }
}
