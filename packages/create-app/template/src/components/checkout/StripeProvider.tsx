"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { loadStripe, type Appearance, type Stripe } from "@stripe/stripe-js";
import { Elements } from "@stripe/react-stripe-js";
import { Notice } from "@/components/ui";

/**
 * Loads Stripe.js ONCE per browser tab.
 *
 * At module scope, not inside the component. `loadStripe` injects a script tag
 * and resolves to a singleton; calling it on every render re-enters that work
 * and, worse, hands `<Elements>` a NEW promise identity each time — which
 * react-stripe-js treats as a different Stripe instance and answers with
 * "Unsupported prop change: options.stripe is not a mutable property". The
 * Payment Element then unmounts mid-payment.
 *
 * `null` when the publishable key is absent, so the module still imports
 * cleanly on a deployment with no Stripe and the component below can explain
 * itself instead of the page throwing.
 *
 * READ FROM `process.env` RATHER THAN `@/env`, which is the second and last
 * place in this app allowed to do that — `proxy.ts` is the first, for the same
 * reason. `@/env` composes the database fragment, so importing it from a
 * "use client" module drags the Neon driver and `ws` into the BROWSER bundle,
 * where neither can run. A `NEXT_PUBLIC_*` name is inlined by the compiler, so
 * the line below is a build-time constant and not a runtime lookup — the rule
 * it bends is about configuration drift, which cannot happen to a literal.
 */
const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
const stripePromise: Promise<Stripe | null> | null = publishableKey
  ? loadStripe(publishableKey)
  : null;

/**
 * Our theme tokens, read out of the live stylesheet.
 *
 * The Payment Element renders inside a cross-origin iframe, so our Tailwind
 * classes cannot reach it: Stripe styles it from an `appearance` object of
 * plain CSS values. Hardcoding hexes here would fork the palette — two places
 * to change a colour, and the second one gets found by a customer reporting
 * that the card form is white on a dark page.
 *
 * So the values come from `getComputedStyle(document.documentElement)`, which
 * resolves the same `--color-*` custom properties `@theme` declares in
 * app/globals.css, already switched for the active colour scheme. A token that
 * resolves to nothing is OMITTED rather than defaulted, because Stripe's own
 * default is a better answer than an invented hex.
 */
function readToken(styles: CSSStyleDeclaration, name: string): string | undefined {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : undefined;
}

function appearanceFromTheme(): Appearance {
  const styles = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};

  const map: Record<string, string> = {
    colorPrimary: "--color-accent",
    colorBackground: "--color-surface",
    colorText: "--color-ink",
    colorTextSecondary: "--color-ink-muted",
    colorTextPlaceholder: "--color-ink-muted",
    colorDanger: "--color-danger",
    borderRadius: "--radius-card",
    fontFamily: "--font-sans",
  };

  for (const [key, token] of Object.entries(map)) {
    const value = readToken(styles, token);
    if (value !== undefined) variables[key] = value;
  }

  // Stripe's own field borders come from `colorBackground` shading, which lands
  // near-invisible against our surface. The rule below restates the one border
  // token so a card input has the same hairline as every other control in the
  // product.
  const line = readToken(styles, "--color-line");
  const accent = readToken(styles, "--color-accent");

  return {
    // `night` is not chosen from a stored preference — the tokens above already
    // carry the active theme. It only tells Stripe which end of ITS OWN derived
    // values (shadows, disabled states) to start from, and starting light on a
    // dark page produces grey-on-grey text that no token override can rescue.
    theme: isDarkTheme(styles) ? "night" : "stripe",
    variables,
    rules: {
      ...(line === undefined
        ? {}
        : { ".Input": { border: `1px solid ${line}`, boxShadow: "none" } }),
      // The focus ring the rest of the app gets from globals.css. Without it
      // the one control a customer must use with a keyboard is the one control
      // with no visible focus.
      ...(accent === undefined
        ? {}
        : {
            ".Input:focus": {
              outline: `2px solid ${accent}`,
              outlineOffset: "2px",
              boxShadow: "none",
            },
          }),
    },
  };
}

/**
 * Which end of the palette are we on?
 *
 * Derived from the resolved surface token rather than from `matchMedia`, so it
 * stays correct if a project later adds a manual theme toggle that sets the
 * tokens without touching the media query.
 */
function isDarkTheme(styles: CSSStyleDeclaration): boolean {
  const surface = readToken(styles, "--color-surface");
  if (surface === undefined) return false;
  return relativeLuminanceIsDark(surface);
}

/**
 * A crude light/dark test on a hex colour. Crude is correct here: the answer
 * picks one of two Stripe base themes, and being one shade out changes nothing
 * a customer can see. Anything that is not a `#rrggbb` falls back to light,
 * which is the safe direction — Stripe's light base on a light page.
 */
function relativeLuminanceIsDark(colour: string): boolean {
  const match = /^#([0-9a-f]{6})$/i.exec(colour);
  if (!match?.[1]) return false;
  const hex = match[1];
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

export interface StripeProviderProps {
  /** From `checkout.createIntent`. Elements cannot mount without one. */
  readonly clientSecret: string;
  readonly children: ReactNode;
}

/**
 * Wraps the Payment Element in a configured Stripe Elements context.
 *
 * Separate from CheckoutForm because the two have different reasons to change:
 * this file is theme plumbing, that file is the payment flow. It is also the
 * only file that touches `@stripe/stripe-js`, so a version bump has one place
 * to land.
 */
export function StripeProvider({ clientSecret, children }: StripeProviderProps) {
  // Recomputed when the OS colour scheme flips, so a customer who switches
  // themes mid-checkout does not end up with a black card form on a white page.
  // react-stripe-js forwards an appearance change to `elements.update()`;
  // `clientSecret` is deliberately NOT in this dependency list because Elements
  // refuses to have it changed after mount.
  const [scheme, setScheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    setScheme(query.matches ? "dark" : "light");
    const onChange = (event: MediaQueryListEvent) =>
      setScheme(event.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const appearance = useMemo<Appearance | undefined>(() => {
    // Server render and the first client pass have no document to read tokens
    // from. Returning undefined lets Elements mount with its own defaults and
    // pick up ours on the effect-driven re-render a tick later.
    if (typeof document === "undefined") return undefined;
    return appearanceFromTheme();
    // `scheme` is the trigger, not an input: the tokens it changes are read
    // fresh from the document each time.
  }, [scheme]);

  if (stripePromise === null) {
    return (
      <Notice tone="warn" title="Card payments are switched off">
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set on this deployment, so
        Stripe.js was never loaded and there is no form to fill in. Add it to{" "}
        <code>.env.local</code> and restart —{" "}
        <a href="/setup" className="text-accent underline">
          /setup
        </a>{" "}
        lists what else is outstanding.
      </Notice>
    );
  }

  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
      {children}
    </Elements>
  );
}
