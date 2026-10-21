"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";

/**
 * A licence key, in full, with a copy button.
 *
 * WHY THIS IS THE MOST IMPORTANT COMPONENT IN THE OVERLAY. `applyGrant` mints a
 * real Crockford-base32 key inside the transaction that books the order and
 * writes it to `order_items.metadata.licenseKey`. Before this overlay, the only
 * surface that ever rendered it was `/checkout/success` — once, on a page the
 * buyer is about to navigate away from. A customer who closed that tab had
 * permanently lost a key that no page, no admin screen and no support tool
 * could retrieve. The key was generated correctly and irretrievably.
 *
 * SHOWN IN FULL, NEVER MASKED. Masking is the instinct because it looks like a
 * secret, and it is wrong here: this is a bearer string the customer is
 * expected to paste into another application, they already own it, and the
 * page it is on already required proving they own the order. A mask with a
 * reveal button adds a click to every legitimate use and protects against
 * nothing except somebody standing behind them — who can also see the reveal.
 *
 * THE FONT IS THE FEATURE. The alphabet excludes I, L, O and U specifically so
 * the key survives being read off a screen and retyped, and a proportional font
 * undoes that: it is the rendering, not the alphabet, that makes `1` and `l`
 * indistinguishable. `font-mono` with `tracking` is what keeps the four groups
 * of five separable at a glance.
 *
 * `select-all` so a triple-click or a keyboard select takes the whole key and
 * not one hyphen-delimited group, which is what a double-click does and is the
 * most common way a copied key arrives truncated.
 */
export function LicenceKey({ value }: { readonly value: string }) {
  const [copied, setCopied] = useState(false);

  // The confirmation clears itself. Without this the button reads "Copied" for
  // the rest of the session, so a customer who copies a second key gets no
  // feedback at all — the state that matters is the transition, not the label.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="select-all rounded-[3px] border border-line bg-canvas px-2 py-1 font-mono text-sm tracking-wider">
        {value}
      </code>
      <Button
        onClick={() => {
          // `navigator.clipboard` is undefined on an insecure origin and can be
          // denied by permission policy. Neither is worth a crash on a page
          // whose whole job is to make sure the key is not lost: the key is
          // already on screen and selectable, so a failed copy costs the reader
          // a manual selection rather than the key.
          void navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      {/* Announced rather than only drawn, because the confirmation is the
          entire feedback for the action and a button label that changes under
          the pointer is not announced by default. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Licence key copied to the clipboard" : ""}
      </span>
    </div>
  );
}
