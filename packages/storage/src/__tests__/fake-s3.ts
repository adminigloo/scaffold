import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * A fake S3-compatible server (`node:http`) for the adapter's round trip
 * (6.2, review BO-16). It RECORDS each request and checks the header SHAPE
 * (an Authorization header in SigV4's form, `x-amz-date`, and an
 * `x-amz-content-sha256` equal to the body's real hash) and keeps the raw
 * path as sent, so a test can check its encoding. It never verifies a
 * signature with the package's own signer: that would prove nothing. The two
 * AWS test vectors (adapters.test.ts) prove the signer.
 *
 * An unsigned GET (no Authorization) answers `anonymousStatus`: 403 for a
 * private bucket, 200 for one with a public policy (checkPrivate's probe).
 */

export interface SeenRequest {
  readonly method: string;
  /** The path exactly as it arrived, still percent-encoded. */
  readonly rawPath: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly problems: readonly string[];
}

export interface FakeS3 {
  readonly endpoint: string;
  readonly seen: SeenRequest[];
  readonly objects: Map<string, { body: Buffer; contentType: string }>;
  anonymousStatus: number;
  close(): Promise<void>;
}

const AUTH = /^AWS4-HMAC-SHA256 Credential=[^/]+\/(\d{8})\/([a-z0-9-]+)\/s3\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/;

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startFakeS3(options: { readonly region?: string } = {}): Promise<FakeS3> {
  const seen: SeenRequest[] = [];
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const state = { anonymousStatus: 403 };
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers[name] = value;
    const rawPath = (req.url ?? "").split("?")[0] ?? "";
    const problems: string[] = [];
    const auth = headers.authorization;
    if (auth) {
      const match = AUTH.exec(auth);
      if (!match) problems.push(`Authorization isn't SigV4's shape: ${auth}`);
      else {
        if (headers["x-amz-date"]?.slice(0, 8) !== match[1]) problems.push("the credential's date isn't x-amz-date's");
        if (options.region && match[2] !== options.region) problems.push(`region ${match[2]}`);
        for (const signed of ["host", "x-amz-content-sha256", "x-amz-date"]) if (!match[3]?.split(";").includes(signed)) problems.push(`${signed} isn't signed`);
      }
      if (!/^\d{8}T\d{6}Z$/.test(headers["x-amz-date"] ?? "")) problems.push("no x-amz-date");
      const hash = createHash("sha256").update(body).digest("hex");
      if (headers["x-amz-content-sha256"] !== hash) problems.push("x-amz-content-sha256 isn't the body's hash");
    }
    seen.push({ method: req.method ?? "", rawPath, headers, body, problems });
    const key = rawPath;
    if (!auth) {
      if (req.method === "GET" && state.anonymousStatus === 200 && objects.has(key)) {
        res.writeHead(200, { "content-type": objects.get(key)?.contentType ?? "application/octet-stream" });
        res.end(objects.get(key)?.body);
      } else {
        res.writeHead(state.anonymousStatus === 200 ? 404 : state.anonymousStatus);
        res.end("<Error><Code>AccessDenied</Code></Error>");
      }
      return;
    }
    if (req.method === "PUT") {
      objects.set(key, { body, contentType: headers["content-type"] ?? "application/octet-stream" });
      res.writeHead(200, { etag: '"x"' });
      res.end();
    } else if (req.method === "GET") {
      const found = objects.get(key);
      if (!found) {
        res.writeHead(404, { "content-type": "application/xml" });
        res.end("<Error><Code>NoSuchKey</Code></Error>");
      } else {
        res.writeHead(200, { "content-type": found.contentType, "content-length": String(found.body.length) });
        res.end(found.body);
      }
    } else if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(405);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    objects,
    get anonymousStatus() {
      return state.anonymousStatus;
    },
    set anonymousStatus(value: number) {
      state.anonymousStatus = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
