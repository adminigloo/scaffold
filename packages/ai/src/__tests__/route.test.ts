import { describe, expect, it, vi } from "vitest";
import { createPermissionSet } from "@adminigloo/permissions";
import type { Principal } from "@adminigloo/auth";
import { createStreamRoute, InvalidStreamScopeError } from "../route.js";
import type { StreamRouteAuth, StreamRouteContext } from "../route.js";
import type { StreamUsage } from "../stream.js";

const PRINCIPAL: Principal = {
  userId: "u_1",
  externalId: "user_2yQ",
  email: "ada@example.test",
};

const TENANT_A = "t_acme";
const TENANT_B = "t_globex";

/** A member of `TENANT_A` holding `granted` in that tenant and nowhere else. */
const authWith = (...granted: readonly string[]): StreamRouteAuth => ({
  principal: PRINCIPAL,
  scope: { tenantId: TENANT_A, can: createPermissionSet(granted) },
});

const request = (): Request => new Request("https://app.test/api/chat", { method: "POST" });

/** A response shaped like the ones a provider SDK hands back. */
function streamingResponse(chunks: readonly string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) controller.close();
      else {
        index += 1;
        controller.enqueue(encoder.encode(chunk));
      }
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

function bodyOf(response: Response): NonNullable<Response["body"]> {
  const body = response.body;
  if (!body) throw new Error("expected a streaming body");
  return body;
}

describe("createStreamRoute - the order", () => {
  it("answers 401 and never reaches the handler with no principal", async () => {
    const handler = vi.fn(async () => streamingResponse(["never"]));
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => null,
      handler,
    });

    const response = await route(request());

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 403 and never reaches the handler on a denied permission", async () => {
    // The single check this module exists for. A permission test inside the
    // handler runs after the provider call has started and, once the first byte
    // is out, cannot become a 403 at all - the client renders a partial answer
    // and then the stream just stops.
    const handler = vi.fn(async () => streamingResponse(["never"]));
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.history.view"),
      handler,
    });

    const response = await route(request());

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: "forbidden",
      permission: "ai.chat.use",
    });
  });

  it("refuses at the status line rather than inside an event stream", async () => {
    // A refusal encoded as an SSE error event arrives as a 200, so the client
    // mounts the chat UI before it can discover it was denied.
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => null,
      handler: async () => streamingResponse(["never"]),
    });

    const response = await route(request());

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("resolves, checks, and only then opens the stream", async () => {
    const order: string[] = [];
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => {
        order.push("resolve");
        return authWith("ai.chat.use");
      },
      handler: async () => {
        order.push("handler");
        return streamingResponse(["hi"]);
      },
    });

    await route(request());

    expect(order).toEqual(["resolve", "handler"]);
  });

  it("hands the handler the principal, the scoped permission set and the request", async () => {
    const req = request();
    const contexts: StreamRouteContext[] = [];

    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async (ctx) => {
        contexts.push(ctx);
        return streamingResponse(["hi"]);
      },
    });

    await route(req);

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.principal).toBe(PRINCIPAL);
    expect(contexts[0]?.req).toBe(req);
    // The whole set, not just the checked key: a handler that needs a second
    // permission must not have to resolve one all over again.
    expect(contexts[0]?.scope.can.can("ai.chat.use")).toBe(true);
    expect(contexts[0]?.scope.can.can("ai.config.manage")).toBe(false);
  });

  it("lets a broken identity provider be a 500, not a 401", async () => {
    // Returning null on an infrastructure failure would tell the client to sign
    // in again, which is the one thing that cannot fix it, and would hide an
    // outage behind a login screen.
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => {
        throw new Error("clerk unreachable");
      },
      handler: async () => streamingResponse(["hi"]),
    });

    await expect(route(request())).rejects.toThrow("clerk unreachable");
  });
});

describe("createStreamRoute - the permission set carries its tenant", () => {
  it("reports the tenant resolve resolved for, never one named by the request", async () => {
    // The request says tenant B in both the query string and the body, the way
    // a caller who types a tenant id does. `resolve` resolved grants in tenant
    // A. A context that repeated the request's answer would hand the handler
    // tenant A's grants over tenant B's rows, and every check would pass.
    const contexts: StreamRouteContext[] = [];
    const resolved = authWith("ai.chat.use");

    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => resolved,
      handler: async (ctx) => {
        contexts.push(ctx);
        return streamingResponse(["hi"]);
      },
    });

    await route(
      new Request(`https://app.test/api/chat?tenantId=${TENANT_B}`, {
        method: "POST",
        body: JSON.stringify({ tenantId: TENANT_B }),
      }),
    );

    expect(contexts[0]?.scope.tenantId).toBe(TENANT_A);
    expect(contexts[0]?.scope.tenantId).not.toBe(TENANT_B);
    // The same object, not a copy: a tenant id and a permission set copied out
    // side by side are two values a later edit can let drift apart.
    expect(contexts[0]?.scope).toBe(resolved.scope);
  });

  it("gives the handler no way to read the grants without their tenant", async () => {
    const contexts: StreamRouteContext[] = [];
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async (ctx) => {
        // A bare `ctx.can` is what lets a handler authorize against grants
        // whose tenant it never looked at. It must not typecheck, and it must
        // not exist at runtime either - `ctx.can?.can(...)` on an undefined
        // property would silently deny instead of failing loudly.
        // @ts-expect-error - permissions are reachable only through the scope
        expect(ctx.can).toBeUndefined();
        contexts.push(ctx);
        return streamingResponse(["hi"]);
      },
    });

    await route(request());

    expect(Object.keys(contexts[0] ?? {})).not.toContain("can");
    expect(contexts[0]?.scope.can.can("ai.chat.use")).toBe(true);
  });

  it("answers 403 and never opens the stream for a non-member", async () => {
    // A signed-in caller who is not in this tenant at all. The refusal happens
    // at the same point as every other one, above the handler, so nothing is
    // sent to the provider and nothing is written to the response.
    const reports: StreamUsage[] = [];
    const handler = vi.fn(async () => streamingResponse(["never"]));
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => ({ principal: PRINCIPAL, scope: null }),
      handler,
      onUsage: (usage) => void reports.push(usage),
    });

    const response = await route(request());

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    // A refusal at the status line, not an error event inside a 200 the client
    // has already started rendering.
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: "forbidden",
      reason: "not_a_member",
    });
    expect(reports).toEqual([]);
  });

  it("keeps a non-member distinct from a member holding no grants", async () => {
    // The two are one status apart and worlds apart in meaning, and the
    // resolver that cannot tell them apart - `createPermissionSet(grants ?? [])`
    // - lets any signed-in caller be treated as inside any tenant they name.
    // Whether they then get through is left to whichever permissions happen to
    // be granted by default.
    const nonMember = await createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => ({ principal: PRINCIPAL, scope: null }),
      handler: async () => streamingResponse(["never"]),
    })(request());

    const memberWithoutGrant = await createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith(),
      handler: async () => streamingResponse(["never"]),
    })(request());

    expect(nonMember.status).toBe(403);
    expect(memberWithoutGrant.status).toBe(403);
    expect(await nonMember.json()).toEqual({
      error: "forbidden",
      reason: "not_a_member",
    });
    expect(await memberWithoutGrant.json()).toEqual({
      error: "forbidden",
      permission: "ai.chat.use",
    });
  });

  it("treats a blank tenant id as a broken resolver, not as a refusal", async () => {
    // An empty tenant id is falsy, so it survives `if (tenantId)` and lands in
    // `WHERE tenant_id = ''` while the request still carries real grants. A 403
    // would show the user an access problem they cannot act on and keep the
    // resolver bug out of the error tracker.
    const handler = vi.fn(async () => streamingResponse(["never"]));
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => ({
        principal: PRINCIPAL,
        scope: { tenantId: "", can: createPermissionSet(["ai.chat.use"]) },
      }),
      handler,
    });

    await expect(route(request())).rejects.toBeInstanceOf(InvalidStreamScopeError);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("createStreamRoute - the response belongs to the handler", () => {
  it("streams the handler's body through unchanged", async () => {
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async () => streamingResponse(["one ", "two ", "three"]),
      onUsage: () => {},
    });

    expect(await (await route(request())).text()).toBe("one two three");
  });

  it("carries status, statusText and headers across the metering wrap", async () => {
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async () =>
        streamingResponse(["hi"], {
          status: 207,
          statusText: "Partial",
          headers: {
            "content-type": "text/event-stream",
            "x-model": "some-model-2026-01-01",
          },
        }),
      onUsage: () => {},
    });

    const response = await route(request());

    expect(response.status).toBe(207);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-model")).toBe("some-model-2026-01-01");
  });
});

describe("createStreamRoute - usage", () => {
  it("reports once when the client reads the whole stream", async () => {
    const reports: StreamUsage[] = [];
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async () => streamingResponse(["a", "b"]),
      onUsage: (usage) => void reports.push(usage),
    });

    await (await route(request())).text();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "completed", chunks: 2 });
  });

  it("reports the abandoned request when the client disconnects", async () => {
    const reports: StreamUsage[] = [];
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async () => streamingResponse(["a", "b", "c", "d"]),
      onUsage: (usage) => void reports.push(usage),
    });

    const reader = bodyOf(await route(request())).getReader();
    await reader.read();
    await reader.cancel("client went away");

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "cancelled", chunks: 1 });
  });

  it("reports a handler that threw before any stream existed, then rethrows", async () => {
    // By this point the provider has usually been called, so the tokens are
    // spent even though nothing was ever streamed. These are the requests most
    // worth seeing in the table, and the ones a stream-only meter loses.
    const reports: StreamUsage[] = [];
    const boom = new Error("provider returned 400");
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async () => {
        throw boom;
      },
      onUsage: (usage) => void reports.push(usage),
    });

    await expect(route(request())).rejects.toThrow("provider returned 400");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "errored", chunks: 0 });
    expect(reports[0]?.error).toBe(boom);
  });

  it("reports a non-streaming response exactly once", async () => {
    // A cached answer or a 204 is still an authorized request. Keeping the
    // one-to-one means a gap in ai_usage is a dropped write, not a response
    // shape nobody thought about.
    const reports: StreamUsage[] = [];
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async () => new Response(null, { status: 204 }),
      onUsage: (usage) => void reports.push(usage),
    });

    const response = await route(request());

    expect(response.status).toBe(204);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "completed", chunks: 0 });
  });

  it("records nothing for a refused request", async () => {
    // A denial spent no tokens. Counting refusals as usage makes a
    // credential-stuffing run look like a spend spike, and hides the real one.
    const reports: StreamUsage[] = [];
    const onUsage = (usage: StreamUsage) => void reports.push(usage);

    await createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => null,
      handler: async () => streamingResponse(["a"]),
      onUsage,
    })(request());

    await createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.history.view"),
      handler: async () => streamingResponse(["a"]),
      onUsage,
    })(request());

    expect(reports).toEqual([]);
  });

  it("does not truncate the answer when the usage write fails", async () => {
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async () => streamingResponse(["a", "b"]),
      onUsage: () => Promise.reject(new Error("pool exhausted")),
    });

    expect(await (await route(request())).text()).toBe("ab");
  });

  it("still rethrows a handler failure when the usage write also fails", async () => {
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async () => {
        throw new Error("provider returned 400");
      },
      onUsage: () => {
        throw new Error("usage table is full");
      },
    });

    await expect(route(request())).rejects.toThrow("provider returned 400");
  });

  it("measures latency from the injected clock", async () => {
    const reports: StreamUsage[] = [];
    let clock = 0;
    const route = createStreamRoute({
      permission: "ai.chat.use",
      resolve: async () => authWith("ai.chat.use"),
      handler: async () => streamingResponse(["a"]),
      onUsage: (usage) => void reports.push(usage),
      now: () => {
        clock += 100;
        return clock;
      },
    });

    await (await route(request())).text();

    // One tick when the route authorized, one when the stream settled. The
    // stream wrap does not restart the clock, so the number covers the wait for
    // the first token too.
    expect(reports[0]?.durationMs).toBe(100);
  });
});
