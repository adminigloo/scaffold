/**
 * The injected "asker" for __SCOPE__/aeo, and the tenant its queries live under.
 *
 * @adminigloo/aeo tracks the questions your customers ask an AI assistant and
 * checks whether the answer mentions you. To run a check it needs a way to ASK
 * a model a question — and which model, on whose account, is the app's decision,
 * not the package's. So the package takes an asker: `(query) => Promise<string | null>`.
 *
 * SHIPPED AS A DEGRADING STUB, on purpose — the same rule the notifications
 * inbox follows ("producers are yours to wire"). Out of the box this returns
 * null, so `runCitationChecks` records nothing and the admin page stays honestly
 * empty rather than throwing. Wire it to a model and the feature turns on with
 * no other change.
 *
 * TO WIRE IT (two common shapes):
 *   • This project was generated with `--ai`: import the model client from
 *     `@/server/ai` and ask it, recording usage on the same rails the assistant
 *     uses — that is the metered, production shape.
 *   • Standalone: `new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })` and return
 *     the text, or call whichever answer engine you actually want to measure.
 * Either way, keep the null return when no key is set, so a citation run
 * degrades to a no-op instead of failing.
 */
export const AEO_TENANT = "primary";

export function makeAeoAsker(): (query: string) => Promise<string | null> {
  return async (_query: string): Promise<string | null> => {
    // Wire a model here (see the file header). Null until you do, so the
    // citation run is a clean no-op rather than an error.
    return null;
  };
}
