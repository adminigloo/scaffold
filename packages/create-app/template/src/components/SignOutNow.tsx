"use client";

import { useClerk } from "@clerk/nextjs";
import { useEffect, useRef } from "react";

/**
 * Signs the browser out once, then sends it to `redirectUrl`.
 *
 * Client-side because that is where Clerk's session lives. The ref keeps a
 * second render (React's development double-invoke) from starting a second
 * sign-out while the first is still in flight.
 */
export function SignOutNow({ redirectUrl }: { readonly redirectUrl: string }) {
  const { signOut } = useClerk();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void signOut({ redirectUrl });
  }, [signOut, redirectUrl]);
  return (
    <p role="status" className="text-sm text-ink-muted">
      Signing you out&hellip;
    </p>
  );
}
