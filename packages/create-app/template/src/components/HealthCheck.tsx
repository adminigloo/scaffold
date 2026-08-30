"use client";

import { api } from "@/trpc/client";

/**
 * Proves the client wiring end to end: a component calls a tRPC procedure and
 * gets a typed answer back. Delete it once you have a real feature.
 */
export function HealthCheck() {
  const { data, isLoading, error } = api.health.useQuery();

  // A live status, so it is announced rather than silently swapped for anyone
  // who cannot see it change.
  if (isLoading) {
    return (
      <span role="status" className="text-ink-muted">
        <Dot className="bg-line" /> checking API…
      </span>
    );
  }

  if (error) {
    return (
      <span role="status" className="text-danger">
        <Dot className="bg-danger" /> API error: {error.message}
      </span>
    );
  }

  return (
    <span role="status" className="text-ink-muted">
      <Dot className="bg-accent" /> API responded, ok: {String(data?.ok)}
    </span>
  );
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={`mr-1.5 inline-block size-2 rounded-full ${className}`} />;
}
