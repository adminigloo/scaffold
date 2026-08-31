import { neonConfig } from "@neondatabase/serverless";
import { createDb } from "__SCOPE__/db";
import { env } from "@/env";
// The OBJECT, not the module namespace. `src/db/schema.ts` says at length why;
// the short version is that drizzle calls `Object.keys` on whatever it is given
// and a namespace made entirely of re-exports is a Proxy that throws on it.
import { schema } from "./schema";

/**
 * REACHING A POSTGRES THAT IS NOT NEON, over the same driver.
 *
 * The driver this project uses speaks the Postgres wire protocol over a
 * WebSocket, because that is the only transport a serverless function can hold
 * an interactive transaction on. It therefore cannot dial a plain Postgres
 * listener: point `DATABASE_URL` at `localhost:5432` and it tries
 * `wss://localhost/v2` and fails with a socket error that says nothing about
 * why.
 *
 * That is the whole reason the integration suites in this project ran nowhere
 * for so long. They need a real database — the properties they assert are
 * enforced by Postgres, not by the application — and the only database they
 * could reach was a hosted Neon branch, which means an account, a credential
 * and a person willing to create both before running `pnpm test`. So nobody
 * ran them, `describeIntegration` reported them as skipped, and the suite was
 * green through two tests that contradicted the code they were testing.
 *
 * `DATABASE_WS_PROXY` removes the account from that sentence. Set it to the
 * `host:port/path` of a WebSocket-to-TCP proxy — `ghcr.io/neondatabase/wsproxy`
 * in front of a stock `postgres:17` container is the whole of it — and the same
 * driver, the same pool and the same Drizzle configuration talk to a database
 * on this machine. Nothing about the app changes; only how the bytes get there.
 *
 * READ FROM `process.env` RATHER THAN FROM `@/env`, deliberately. It is a
 * transport detail of the harness and not configuration of the product: a
 * deployment must never set it, `.env.example` does not offer it, and putting
 * it through the validated schema would advertise it as something a production
 * environment might reasonably want. Absent — which is every deployment and
 * every laptop pointed at Neon — this block does nothing at all.
 *
 * Set BEFORE `createDb` is called, and it must be: `neonConfig` is a mutable
 * singleton read at connect time, and the pool below is constructed at module
 * load. The driver is a PEER dependency of the package that opens the pool, so
 * there is exactly one copy of that singleton in the project and this is it.
 */
const wsProxy = process.env.DATABASE_WS_PROXY;
if (wsProxy) {
  neonConfig.wsProxy = wsProxy;
  // A local proxy is plain `ws://`, and the TLS the driver would otherwise
  // negotiate inside the tunnel has nothing to negotiate with.
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  // The startup pipelining is an optimisation for Neon's own endpoint, which
  // answers the auth challenge before it is asked. A stock Postgres does not,
  // and the connection hangs.
  neonConfig.pipelineConnect = false;
}

/**
 * The database handle.
 *
 * `reuseAcrossReloads` outside production because Next re-evaluates modules on
 * every edit in dev, and without the guard each edit leaks a connection pool
 * until Neon starts refusing new connections.
 *
 * With no DATABASE_URL yet this returns a stand-in that throws a typed error
 * naming the variable on the first query, rather than at import. That is what
 * lets the app boot, render, and tell you what is missing instead of crashing
 * before it can say anything.
 */
export const db = createDb({
  connectionString: env.DATABASE_URL,
  reuseAcrossReloads: env.NODE_ENV !== "production",
  schema,
});

export type Db = typeof db;
