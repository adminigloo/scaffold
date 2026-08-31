/**
 * `pnpm dev` for a project that takes money: the Next server and the Stripe
 * webhook listener, on ONE port that both of them read from the same place.
 *
 * WHAT THIS REPLACED, AND WHY IT HAD TO. The dev script used to be
 *
 *   concurrently -k "next dev" "stripe listen --forward-to localhost:3000/…"
 *
 * and it was wrong in two ways that both end with a developer staring at a
 * checkout that never completes.
 *
 * ONE: THE PORT WAS WRITTEN TWICE. `next dev` with no `--port` takes 3000 if it
 * is free and the next free port if it is not — so a second project already
 * running, or a stray dev server, silently moves the app to 3001 while the
 * listener keeps forwarding to 3000. Stripe reports every delivery as a success
 * because the CLI is happy; nothing arrives; no order is ever written. There is
 * no error anywhere to search for. Here the port is resolved once, from
 * NEXT_PUBLIC_APP_URL — the value the app already uses to build absolute URLs —
 * and both processes are told the same number, `next dev` explicitly, so a busy
 * port fails loudly instead of moving quietly.
 *
 * TWO: `-k` KILLED THE APP WHEN THE STRIPE CLI WAS ABSENT. `concurrently -k`
 * stops every other process the moment one exits, and a machine without the
 * Stripe CLI installed exits that one instantly — so `pnpm dev` on a freshly
 * generated project printed "stripe is not recognised" and took the dev server
 * down with it. The webhook listener is an OPTIONAL half of local development
 * (the simulated checkout needs no Stripe at all), and this script treats it as
 * one: no CLI, one printed line saying what is not running and what still is.
 *
 * It is not a general process manager and should not become one. Two children,
 * one signal handler, and the app's exit code is the script's exit code.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { pointsAtLocalhost } from "__SCOPE__/env";

/** Where the webhook route lives. One string, used in the message and the flag. */
const WEBHOOK_PATH = "/api/webhooks/stripe";

/**
 * The port to serve on, from the URL the app already declares.
 *
 * READ OUT OF .env.local RATHER THAN THE PROCESS ENVIRONMENT, because that file
 * is where the value actually is: `next dev` loads it, this script starts
 * before Next does, and nothing else has put it in `process.env`. Parsed with
 * six lines rather than a dotenv dependency — one `KEY=value` is all that is
 * being read, and a parser that also handles quoting and interpolation would be
 * a dependency whose behaviour has to match Next's exactly or the app and this
 * script disagree about the port.
 *
 * A NON-LOCAL URL IS NOT AN ERROR AND NOT A PORT. Point NEXT_PUBLIC_APP_URL at
 * a tunnel — which is exactly what you do to receive real Stripe webhooks — and
 * its port is 443 on somebody else's host. Binding the dev server to that would
 * be nonsense, so the tunnel case falls back to PORT or 3000 and says so.
 */
function resolvePort(): { readonly port: number; readonly why: string } {
  const declared = readEnvLocal("NEXT_PUBLIC_APP_URL") ?? process.env["NEXT_PUBLIC_APP_URL"];

  if (declared && pointsAtLocalhost(declared)) {
    const port = Number(new URL(declared).port || "3000");
    return { port, why: `NEXT_PUBLIC_APP_URL=${declared}` };
  }

  const fromEnv = Number(process.env["PORT"]);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return { port: fromEnv, why: "PORT" };
  }

  return {
    port: 3000,
    why: declared
      ? `the default — NEXT_PUBLIC_APP_URL is ${declared}, which is not a local host`
      : "the default — NEXT_PUBLIC_APP_URL is not set",
  };
}

function readEnvLocal(key: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(".env.local", "utf8");
  } catch {
    // Gitignored, so a fresh clone has none. Not a failure: every value in it
    // is optional, and the caller has a default.
    return undefined;
  }
  for (const line of contents.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === key) return (match[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const { port, why } = resolvePort();
const forwardTo = `localhost:${port}${WEBHOOK_PATH}`;
const children: ChildProcess[] = [];

/**
 * `shell: true` on both spawns, because `next` and `stripe` are resolved
 * through PATH — on Windows they are `.cmd` shims that `spawn` cannot execute
 * directly. It is safe here specifically because nothing interpolated into
 * either command line comes from outside: the port is a number this file
 * parsed, and the rest is a literal.
 */
function start(command: string, label: string): ChildProcess {
  const child = spawn(command, { shell: true, stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => {
    console.error(`[dev] could not start ${label}: ${error.message}`);
  });
  return child;
}

console.info(`[dev] http://localhost:${port} - port from ${why}`);

const next = start(`next dev --port ${port}`, "next");

/**
 * The listener, started only if the CLI is there.
 *
 * `stripe --version` rather than a PATH lookup, because "installed" and
 * "runnable" are different on every platform and only one of them matters. A
 * non-zero exit or an ENOENT both mean the same thing to this script.
 */
const probe = spawn("stripe --version", { shell: true, stdio: "ignore" });
probe.on("error", () => announceNoStripe());
probe.on("exit", (code) => {
  if (code !== 0) return announceNoStripe();
  console.info(`[dev] forwarding Stripe events to ${forwardTo}`);
  start(`stripe listen --forward-to ${forwardTo}`, "stripe listen");
});

function announceNoStripe(): void {
  console.info(
    `[dev] the Stripe CLI is not installed, so nothing is forwarding webhooks ` +
      `to ${forwardTo}. The app is running and the simulated checkout works ` +
      `without it. Install the CLI when you have real keys to test against.`,
  );
}

/**
 * The app's exit is the script's exit, and everything else is cleaned up.
 *
 * Without this, killing `next dev` leaves `stripe listen` attached to the
 * terminal holding a webhook endpoint open against a server that is gone — and
 * the next `pnpm dev` then runs beside it, forwarding two copies of every
 * event.
 */
next.on("exit", (code, signal) => {
  for (const child of children) if (child !== next) child.kill();
  process.exit(signal ? 1 : (code ?? 0));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}
