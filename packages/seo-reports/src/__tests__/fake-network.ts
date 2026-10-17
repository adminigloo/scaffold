import type { ResolveHost, Transport, TransportResponse } from "../net.js";

/**
 * A FAKE INTERNET for the tests: names → addresses, addresses → pages. No
 * request leaves the process. A page is { status, headers, body } keyed by
 * its full address; anything missing answers 404.
 */
export interface FakePage {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface FakeNetwork {
  resolve: ResolveHost;
  transport: Transport;
  /** Every request the transport was asked to make, in order, with the address it connected to. */
  requests: { url: string; address: string; userAgent: string | undefined }[];
}

export function fakeNetwork(pages: Record<string, FakePage>, dns: Record<string, string[]> = {}): FakeNetwork {
  const requests: FakeNetwork["requests"] = [];
  return {
    requests,
    resolve: async (host) => {
      const found = dns[host.toLowerCase()];
      if (found) return found;
      // Every other name is a public address.
      return ["93.184.216.34"];
    },
    transport: async (req): Promise<TransportResponse> => {
      requests.push({ url: req.url.toString(), address: req.address, userAgent: req.headers["user-agent"] });
      if (req.signal.aborted) throw new Error("aborted");
      const page = pages[req.url.toString()];
      const body = new TextEncoder().encode(page?.body ?? "");
      const truncated = body.byteLength > req.maxBytes;
      return {
        status: page ? (page.status ?? 200) : 404,
        headers: { "content-type": "text/html; charset=utf-8", ...(page?.headers ?? {}) },
        body: truncated ? body.subarray(0, req.maxBytes) : body,
        truncated,
      };
    },
  };
}

export function html(opts: { title?: string; description?: string; canonical?: string; body?: string; head?: string }): string {
  return `<!doctype html><html><head>
${opts.title !== undefined ? `<title>${opts.title}</title>` : ""}
${opts.description !== undefined ? `<meta name="description" content="${opts.description}">` : ""}
${opts.canonical !== undefined ? `<link rel="canonical" href="${opts.canonical}">` : ""}
<meta property="og:title" content="x"><meta property="og:image" content="https://x.example/og.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Green Acres"}</script>
${opts.head ?? ""}
</head><body><h1>Heading</h1><h2>Section</h2>${opts.body ?? ""}</body></html>`;
}
