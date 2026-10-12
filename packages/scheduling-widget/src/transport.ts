import { useMemo } from "react";
import { createSchedulingClient, type SchedulingTransport } from "./client.js";
import type { Result } from "./http.js";

/**
 * Every component takes `transport` OR `baseUrl` (contract 8.1). With both,
 * `transport` wins — a host backing the widget with tRPC or a server action
 * passes its own object. With neither, the component still renders: every
 * call answers with one plain error rather than throwing inside React.
 */

const MISSING: Result<never> = {
  ok: false,
  error: { code: "bad_response", message: "This page isn't connected to a booking server yet.", status: 0 },
};

function missingTransport(): SchedulingTransport {
  const fail = () => Promise.resolve(MISSING);
  return { config: fail, slots: fail, request: fail, visit: fail, reschedule: fail, cancel: fail, icsUrl: () => null };
}

export function usePublicTransport(transport: SchedulingTransport | undefined, baseUrl: string | undefined): SchedulingTransport {
  return useMemo(
    () => transport ?? (baseUrl ? createSchedulingClient({ baseUrl }) : missingTransport()),
    [transport, baseUrl],
  );
}

/** A promise that settles after `ms` (the fill-time wait). */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
