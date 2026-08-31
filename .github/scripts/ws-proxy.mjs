#!/usr/bin/env node
//
// A WebSocket-to-TCP bridge, so the Neon serverless driver can talk to an
// ordinary Postgres.
//
// WHY THIS EXISTS. Every generated project connects through
// `@neondatabase/serverless`, which carries the Postgres wire protocol over a
// WebSocket because that is the only transport on which a serverless function
// can hold an interactive transaction. The consequence is that the driver
// cannot dial a plain listener: point DATABASE_URL at a `postgres:17` service
// container and it attempts `wss://postgres/v2` and dies with a socket error
// that says nothing about why.
//
// So the integration suites — the ones whose assertions are enforced by
// Postgres rather than by the application — could only ever reach a hosted Neon
// branch, which means an account and a credential. Nobody had one in CI, the
// suites reported a tidy green "skipped" on every run, and two of them
// contradicted the code they tested for an entire release. This process is what
// removes the account from that sentence.
//
// NOT `ghcr.io/neondatabase/wsproxy`, though that image does the same job. Its
// behaviour depends on APPEND_PORT and ALLOW_ADDR_REGEX doing what its README
// says, which is one more thing to be wrong about in a pipeline nobody watches.
// Thirty lines that can be read in full, and run identically on a laptop, are
// worth more here than a container.
//
//   node .github/scripts/ws-proxy.mjs [listen-port]
//
// It speaks the address protocol the driver already emits: the client opens
// `ws://<this>/v1?address=<host>:<port>` and every byte after that is Postgres.
// Set DATABASE_WS_PROXY on the app to the `host:port/v1` half; src/db/index.ts
// reads it and configures the driver.
//
// WS_PROXY_TARGET OVERRIDES THE REQUESTED ADDRESS, and it is not a shortcut.
// Boot validation refuses a DATABASE_URL whose hostname does not contain
// `-pooler`, because a project that migrates through a pooled endpoint
// misreports which migrations have applied — a rule worth keeping and one that
// makes `localhost` an illegal value. So the connection string names a pooled
// endpoint that does not resolve, nothing ever tries to resolve it, and the
// bridge decides where the bytes actually go. `ghcr.io/neondatabase/wsproxy`
// calls the same thing APPEND_PORT.
//
// `ws` is resolved from the CURRENT WORKING DIRECTORY rather than from beside
// this file, because this script lives in a repository that does not depend on
// it. Run it from anywhere that has `ws` installed — a generated project has
// one, since it is a dependency of the database package.

import { createRequire } from "node:module";
import { createServer } from "node:http";
import net from "node:net";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "noop.cjs"));
const { WebSocketServer } = require("ws");

const PORT = Number(process.argv[2] ?? 5433);

const server = createServer((_request, response) => {
  // A plain GET, so a job step can wait for readiness without opening a socket
  // it then has to close cleanly.
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ws-proxy\n");
});
const sockets = new WebSocketServer({ server });

const TARGET = process.env.WS_PROXY_TARGET;

sockets.on("connection", (ws, request) => {
  const url = new URL(request.url ?? "/", "http://proxy.invalid");
  const address = TARGET ?? url.searchParams.get("address") ?? "";
  const separator = address.lastIndexOf(":");
  const host = separator === -1 ? address : address.slice(0, separator);
  const port = Number(separator === -1 ? "5432" : address.slice(separator + 1));
  if (!host || !Number.isInteger(port)) {
    console.error(`[ws-proxy] refusing connection with address "${address}"`);
    ws.close();
    return;
  }

  const tcp = net.connect({ host, port });
  // Buffered until the TCP side is up: the driver sends its startup packet the
  // instant the WebSocket opens, and a write to a connecting socket is lost.
  const pending = [];
  let connected = false;

  tcp.on("connect", () => {
    connected = true;
    for (const chunk of pending) tcp.write(chunk);
    pending.length = 0;
  });
  tcp.on("data", (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  tcp.on("close", () => ws.close());
  tcp.on("error", (error) => {
    console.error(`[ws-proxy] ${host}:${port} — ${error.message}`);
    ws.close();
  });

  ws.on("message", (message) => {
    const chunk = Buffer.from(message);
    if (connected) tcp.write(chunk);
    else pending.push(chunk);
  });
  ws.on("close", () => tcp.destroy());
  ws.on("error", () => tcp.destroy());
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[ws-proxy] listening on 127.0.0.1:${PORT}`);
});
