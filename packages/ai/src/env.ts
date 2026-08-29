import { z } from "zod";
import { prefixedSecret } from "@adminigloo/env";

/** The providers this package knows how to detect. */
export type AiProvider = "anthropic" | "openai" | "google";

/**
 * The provider keys, as an app's validated env exposes them. Every field is
 * optional; that is the whole design.
 */
export interface AiProviderKeys {
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly OPENAI_API_KEY?: string | undefined;
  readonly GOOGLE_GENERATIVE_AI_API_KEY?: string | undefined;
}

/**
 * This package's contribution to the environment contract.
 *
 * EVERY KEY IS OPTIONAL, and that is not laziness. A missing provider key must
 * degrade the AI feature, never block boot: preview branches that should not be
 * spending on inference, self-hosted installs that use one provider, CI, and
 * every local checkout by someone working on billing. `dbServer()` is required
 * because an app without a database cannot serve a page; an app without
 * Anthropic serves every page except the chat. Making these required is how you
 * get a deployment that will not start because of a feature nobody on that
 * branch was using — and the fix people reach for is a fake key, which fails
 * later, further away, with a worse message.
 *
 * A key that is PRESENT is still validated. "Set but empty" and "set but
 * pasted with the prefix trimmed" are misconfigurations, not absences, and
 * failing at boot with the variable named beats a 401 from the provider on the
 * first user prompt.
 */
export function aiServer() {
  return {
    // `sk-ant-` has been stable across every Anthropic key type, so the check
    // costs nothing and catches the classic paste of an OpenAI key into the
    // Anthropic variable.
    ANTHROPIC_API_KEY: prefixedSecret("sk-ant-").optional(),
    // Only `sk-`: OpenAI has shipped `sk-`, `sk-proj-`, `sk-svcacct-` and
    // `sk-admin-`, and pinning today's longest prefix turns tomorrow's valid
    // key into a boot failure. The shared stem is the part worth asserting.
    OPENAI_API_KEY: prefixedSecret("sk-").optional(),
    // No prefix check. Google issues several credential shapes for this slot
    // (`AIza…` API keys, and tokens minted for a service account), so a prefix
    // rule would reject a credential that works. Length-1 still catches the
    // empty string, which is the common "configured but broken" case: the
    // variable exists, so nothing degrades, and the provider rejects it.
    GOOGLE_GENERATIVE_AI_API_KEY: z
      .string()
      .min(1, { message: "is set but empty — unset it, or give it a real key" })
      .optional(),
  };
}

/**
 * Which providers this deployment can actually call.
 *
 * The counterpart to the optional keys above, and the same shape as
 * `isStripeConfigured`: surfaces are hidden rather than reached, so "AI is not
 * set up here" never presents as "the app is broken".
 *
 * Whitespace-trimmed because these values also arrive from places no Zod schema
 * has seen — a shell export, a `.env` copied with a trailing space, a secrets
 * manager that stores `" "` for a cleared field.
 */
export function configuredAiProviders(env: AiProviderKeys): readonly AiProvider[] {
  const providers: AiProvider[] = [];
  if (isPresent(env.ANTHROPIC_API_KEY)) providers.push("anthropic");
  if (isPresent(env.OPENAI_API_KEY)) providers.push("openai");
  if (isPresent(env.GOOGLE_GENERATIVE_AI_API_KEY)) providers.push("google");
  return providers;
}

/** True when at least one provider is usable. */
export function isAiConfigured(env: AiProviderKeys): boolean {
  return configuredAiProviders(env).length > 0;
}

function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
