import { NextResponse } from "next/server";
import { z } from "zod";
import {
  configuredAiProviders,
  createStreamRoute,
  meterStream,
  reportUsage,
  type StreamRouteContext,
} from "__SCOPE__/ai";
import {
  rateLimitHeaders,
  RATE_LIMIT_POLICIES,
  type RateLimitPolicy,
  type RateLimitResult,
} from "__SCOPE__/observability";
import { resolveRequestId } from "__SCOPE__/observability/request";
import { env } from "@/env";
import { currentPrincipal } from "@/server/auth";
import { loadTenantPermissions } from "@/server/permissions";
import { failClosedLimiter } from "@/server/rate-limit";
import { requestLog } from "@/server/logger";
import { reportError } from "@/server/error-reporter";
import {
  AI_MAX_TOKENS,
  AI_MODEL,
  anthropic,
  newSpend,
  recordAiUsage,
} from "@/server/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The streamed assistant.
 *
 * A ROUTE HANDLER AND NOT A tRPC PROCEDURE, deliberately. A streamed response
 * has no useful shape for tRPC to type and superjson would buffer the whole
 * thing before serialising it, which is the opposite of streaming. That is why
 * `_app.ts` says AI goes through a plain handler.
 *
 * THE ORDER IS THE WHOLE DESIGN, and `createStreamRoute` is what enforces it:
 *
 *   1. resolve the principal
 *   2. resolve their permissions FOR ONE NAMED TENANT
 *   3. refuse a non-member, then refuse a member without `ai.chat.use`
 *   4. spend the request against a per-minute AND a per-day budget
 *   5. and only then open a stream
 *
 * Once headers are flushed there is no way back: the status line went out as
 * 200 long before any later check could run, the browser is already rendering,
 * and the only remaining move is to stop mid-sentence. To the customer that is
 * indistinguishable from the model failing; in the log it is a 200 for a
 * request that should never have reached the provider. Steps 1-4 are all cheap
 * and they all happen before the first byte.
 *
 * THE TENANT ARRIVES IN A HEADER, not the body, so authorization can run
 * without reading the body at all. A route whose job is to refuse before
 * spending anything should not have to parse a megabyte of prompt to discover
 * who is asking. The header is the caller's to set and is therefore not trusted
 * for anything: `loadTenantPermissions` returns null for a tenant this
 * principal is not a member of, and null is a 403.
 */
const TENANT_HEADER = "x-tenant-id";

/**
 * Bounded on every axis a caller controls.
 *
 * `.strict()` rather than a bare object: an unknown key is a client sending a
 * parameter this route does not implement — a model override, a system prompt,
 * a temperature — and quietly dropping it is how a caller comes to believe it
 * worked. The model, the ceiling and the instructions are this file's to set.
 */
const ChatBody = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1).max(20_000),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

/**
 * What the assistant is for.
 *
 * Written here rather than accepted from the request, because a caller-supplied
 * system prompt is a caller-supplied bill: it is the cheapest way to turn a
 * product feature into general-purpose inference somebody else pays for. Edit
 * this string; do not add a parameter for it.
 */
const SYSTEM_PROMPT =
  "You are the assistant inside __PROJECT_NAME__. Answer the question that " +
  "was asked, in plain prose, and say plainly when you do not know.";

/** The dimension the usage rows are grouped by. */
const OPERATION = "chat";

export const POST = createStreamRoute({
  permission: "ai.chat.use",

  /**
   * Identity, tenant and grants in one pass.
   *
   * One pass because a route that fetched the principal, opened the stream and
   * then loaded permissions would already have lost the ability to refuse.
   * Returning `{ principal, scope: null }` is "a real person who is not a
   * member of this tenant" — a 403, and a different event from "no principal",
   * which is a 401.
   */
  async resolve({ req }) {
    const principal = await currentPrincipal();
    if (!principal) return null;

    const tenantId = req.headers.get(TENANT_HEADER)?.trim();
    if (!tenantId) return { principal, scope: null };

    const can = await loadTenantPermissions({ principal, tenantId });
    if (can === null) return { principal, scope: null };

    return { principal, scope: { tenantId, can } };
  },

  handler: chat,
});

async function chat(ctx: StreamRouteContext): Promise<Response> {
  const requestId = resolveRequestId(ctx.req.headers);
  const log = requestLog(requestId);

  /**
   * Step 4. TWO BUDGETS, BOTH CHECKED, AND FAIL CLOSED.
   *
   * A per-minute cap alone does not bound the money: twenty a minute is still
   * 28,800 calls a day. The daily one is the one that bounds the invoice, and
   * the burst one is what stops a loop in somebody's client from reaching it
   * inside a minute. Both are keyed by USER — the account is what is being
   * limited, it survives a change of network, and a NAT'd office does not
   * share one budget between forty people.
   *
   * `failClosedLimiter` refuses when the store is unreachable. Everywhere else
   * in this application an outage in the limiter degrades to no limiting,
   * because the alternative takes the product down over the component that was
   * protecting it. Here that trade inverts: an unthrottled model route is the
   * one omission that produces a same-day invoice, so a Redis outage costs a
   * chat session rather than a five-figure bill.
   */
  const refusal = await overBudget(ctx.principal.userId);
  if (refusal) {
    log.warn(
      { userId: ctx.principal.userId, tenantId: ctx.scope.tenantId },
      "ai chat refused: over budget, or the rate limit store is unreachable",
    );
    return refusal;
  }

  /**
   * No provider key. A DOCUMENTED NO-OP WITH A REAL ANSWER, not a throw and not
   * a silent empty stream: 503 with the (empty) list of providers this
   * deployment could use, which is the same list /setup renders. Checked here
   * rather than at the top of the file so that an anonymous caller cannot use
   * this route to discover whether the key exists.
   */
  if (!anthropic) {
    return NextResponse.json(
      { error: "ai_not_configured", providers: configuredAiProviders(env) },
      { status: 503 },
    );
  }

  /**
   * The body, read LAST — after identity, permission, budget and provider.
   *
   * That is the point of putting the tenant in a header: nothing about the
   * prompt is parsed for a caller who was never going to be served, so the
   * cheapest requests to refuse stay the cheapest to handle.
   */
  const parsed = ChatBody.safeParse(await ctx.req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "bad_request",
        expected: `{ messages: [{ role, content }] }, tenant in ${TENANT_HEADER}`,
      },
      { status: 400 },
    );
  }

  const spend = newSpend();
  const startedAt = Date.now();

  const upstream = anthropic.messages.stream({
    model: AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: parsed.data.messages,
  });

  const encoder = new TextEncoder();

  /**
   * The provider's event stream, flattened to the text a browser can render.
   *
   * Text deltas only. The alternative — forwarding the provider's SSE frames
   * verbatim — makes every client in the product a parser of one vendor's wire
   * format, and swapping providers then means rewriting the front end.
   */
  const source = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of upstream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        // Awaited AFTER the loop, because this is where the token counts are:
        // the provider reports them at the end, and until it has, `reported`
        // stays false and the row is written with an unknown cost.
        const final = await upstream.finalMessage();
        spend.model = final.model;
        spend.inputTokens = final.usage.input_tokens;
        spend.outputTokens = final.usage.output_tokens;
        spend.cachedInputTokens = final.usage.cache_read_input_tokens ?? 0;
        spend.reported = true;
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      // The consumer went away. Tell the provider to stop generating tokens we
      // are going to be billed for and nobody will read.
      upstream.abort();
    },
  });

  /**
   * `meterStream` is what makes cancellation count.
   *
   * A person who closes the tab or hits stop has already spent the tokens — the
   * provider generated them and will bill for them — but the request never
   * reaches whatever line sits after the loop. Recording usage only on clean
   * completion makes every abandoned request invisible, which under-reports
   * exactly the traffic that spikes when the model is slow.
   *
   * `startedAt` is the authorization boundary rather than the first byte: the
   * wait before a provider emits anything is most of what a slow request feels
   * like, and a latency column that starts at the first chunk reports those as
   * fast.
   */
  return new Response(
    meterStream(source, {
      startedAt,
      onUsage: (usage) =>
        reportUsage(
          async (settled) => {
            if (settled.outcome === "errored") {
              log.error({ err: settled.error }, "ai chat stream failed");
              await reportError({
                error: settled.error,
                source: "route",
                url: ctx.req.url,
                userId: ctx.principal.userId,
                tenantId: ctx.scope.tenantId,
                requestId,
                context: { route: "/api/ai/chat", model: spend.model },
              });
            }
            await recordAiUsage({
              tenantId: ctx.scope.tenantId,
              userId: ctx.principal.userId,
              operation: OPERATION,
              spend,
              usage: settled,
            });
          },
          usage,
        ),
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // No buffering anywhere between here and the browser. A proxy that
        // collects the body first turns a streamed answer into a long pause
        // followed by the whole thing at once, and nothing in the code looks
        // wrong.
        "cache-control": "no-store, no-transform",
        "x-request-id": requestId,
      },
    },
  );
}

/**
 * Both budgets, or null when the caller is inside them.
 *
 * The refusal carries the headers of whichever budget said no, so a client that
 * reads `Retry-After` waits the right amount of time: a minute for the burst
 * cap, the rest of the day for the daily one. Set on the refusal only — a 200
 * here is a stream, and headers describing a budget belong on the answer that
 * refuses it.
 */
async function overBudget(userId: string): Promise<Response | null> {
  for (const [name, policy] of [
    ["ai", RATE_LIMIT_POLICIES.ai],
    ["aiDaily", RATE_LIMIT_POLICIES.aiDaily],
  ] as const satisfies readonly (readonly [string, RateLimitPolicy])[]) {
    const result: RateLimitResult = await failClosedLimiter.limit({
      key: `ai:${name}:user:${userId}`,
      policy,
    });
    if (!result.allowed) {
      return NextResponse.json(
        { error: "rate_limited", budget: name },
        { status: 429, headers: rateLimitHeaders(result, policy) },
      );
    }
  }
  return null;
}
