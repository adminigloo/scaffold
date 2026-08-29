"use client";

import { api } from "@/trpc/client";

/**
 * Proves the client wiring end to end: a component calls a tRPC procedure and
 * gets a typed answer back. Delete it once you have a real feature.
 */
export function HealthCheck() {
  const { data, isLoading, error } = api.health.useQuery();

  if (isLoading) return <span>checking API…</span>;
  if (error) return <span>API error: {error.message}</span>;
  return <span>API says ok: {String(data?.ok)}</span>;
}
