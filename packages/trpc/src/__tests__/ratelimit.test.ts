import { describe, expect, it } from "vitest";
import { initTRPC, TRPCError } from "@trpc/server";
import { createPermissionSet } from "@adminigloo/permissions";
import type { PermissionSet } from "@adminigloo/permissions";
import type { Principal } from "@adminigloo/auth";
import type { RateLimiter, RateLimitPolicy } from "@adminigloo/observability";
import { createScaffoldContext } from "../context.js";
import type { ScaffoldContext } from "../context.js";
import { createProcedures } from "../procedures.js";
import type { PermissionLoaders } from "../procedures.js";
import type { RateLimitLadderOptions } from "../ratelimit.js";
import type { ProcedureMeta } from "../scope.js";
import { scopeOfProcedure } from "../inventory.js";

// A real tRPC instance and a real caller, as in procedures.test.ts. A stub
// would pass even if the middleware were never installed on the chain, which
// is the failure this file exists to catch.
const t = initTRPC.context<ScaffoldContext>().meta<ProcedureMeta>().create();

const alice: Principal = {
  userId: "usr_alice",
  externalId: "user_2alice",
  email: "alice@example.com",
};
const bob: Principal = {
  userId: "usr_bob",
  externalId: "user_2bob",
  email: "bob@example.com",
};

const loaders: PermissionLoaders = {
  async loadTenantPermissions({ tenantId }): Promise<PermissionSet | null> {
    return tenantId === "tnt_acme" ? createPermissionSet(["reports.read"]) : null;
  },
  async loadStaffPermissions(): Promise<PermissionSet | null> {
    return createPermissionSet(["staff.tenants.read"]);
  },
};

/**
 * A limiter that records what it was asked and answers from a table.
 *
 * Recorded rather than mocked: the assertions here are about WHICH key and
 * WHICH budget each rung spends, and that is the entire content of "keyed
 * sensibly per rung".
 */
function recordingLimiter(allow: (key: string, seen: number) => boolean = () => true) {
  const seen = new Map<string, number>();
  const calls: { key: string; policy: RateLimitPolicy }[] = [];
  const limiter: RateLimiter = {
    distributed: false,
    limit({ key, policy }) {
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      calls.push({ key, policy });
      return Promise.resolve({
        allowed: allow(key, count),
        remaining: 0,
        resetAt: new Date(Date.now() + 30_000),
      });
    },
  };
  return { limiter, calls };
}

function routerFor(rateLimit: RateLimitLadderOptions | undefined) {
  const p = createProcedures(t, loaders, rateLimit === undefined ? {} : { rateLimit });
  return {
    p,
    router: t.router({
      ping: p.publicProcedure.meta({ scope: "public" }).query(() => "pong"),
      signUp: p.publicProcedure.meta({ scope: "public" }).mutation(() => "queued"),
      me: p.protectedProcedure
        .meta({ scope: "authenticated" })
        .query(({ ctx }) => ctx.principal.userId),
      rename: p.protectedProcedure
        .meta({ scope: "authenticated" })
        .mutation(() => "renamed"),
      tenantEcho: p.tenantProcedure
        .meta({ scope: "tenant" })
        .query(({ ctx }) => ctx.tenantId),
      listTenants: p
        .requireStaff("staff.tenants.read")
        .meta({ scope: "staff" })
        .query(() => ["tnt_acme"]),
    }),
  };
}

function callerFor(
  router: ReturnType<typeof routerFor>["router"],
  principal: Principal | null,
  ipAddress: string | null = null,
) {
  return t.createCallerFactory(router)(
    createScaffoldContext({ principal, ipAddress }),
  );
}

async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (cause) {
    if (cause instanceof TRPCError) return cause.code;
    throw cause;
  }
  throw new Error("expected the call to reject, and it resolved");
}

describe("with no rateLimit option", () => {
  it("installs nothing", async () => {
    // Not a middleware that checks a flag and returns — no middleware. An app
    // that has not opted in behaves exactly as it did before this existed.
    const { router } = routerFor(undefined);
    for (let i = 0; i < 50; i += 1) {
      expect(await callerFor(router, null, "203.0.113.7").ping()).toBe("pong");
    }
  });
});

describe("keys", () => {
  it("keys an anonymous public call by IP", async () => {
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({ limiter });
    await callerFor(router, null, "203.0.113.7").ping();
    expect(calls).toEqual([
      { key: "public:query:ip:203.0.113.7", policy: { limit: 60, windowMs: 60_000 } },
    ]);
  });

  it("keys an authenticated call by user, not by IP", async () => {
    // The account is the thing being limited: it survives a change of network,
    // and an office behind one NAT does not share a budget between forty people.
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({ limiter });
    await callerFor(router, alice, "203.0.113.7").me();
    expect(calls[0]?.key).toBe("authenticated:query:user:usr_alice");
  });

  it("keys the tenant rung by user rather than by tenant", async () => {
    // Keying by tenant would let one member of a large organisation exhaust
    // the budget for all of their colleagues.
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({ limiter });
    await callerFor(router, alice).tenantEcho({ tenantId: "tnt_acme" });
    expect(calls[0]?.key).toBe("tenant:query:user:usr_alice");
  });

  it("keys the staff rung separately from the authenticated one", async () => {
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({ limiter });
    await callerFor(router, alice).listTenants();
    expect(calls[0]?.key).toBe("staff:query:user:usr_alice");
  });

  it("does not limit an anonymous caller with no resolvable IP", async () => {
    // A laptop: every platform this deploys to sets x-forwarded-for. A shared
    // "unknown" bucket would rate-limit a developer out of their own dev server.
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({ limiter });
    await callerFor(router, null, null).ping();
    expect(calls).toEqual([]);
  });
});

describe("budgets", () => {
  it("spends one budget per call, not one per rung it inherits", async () => {
    // The authenticated rungs are built from the unlimited root rather than
    // from publicProcedure, so an authenticated call does not also spend the
    // anonymous IP budget.
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({ limiter });
    await callerFor(router, alice, "203.0.113.7").me();
    expect(calls).toHaveLength(1);
  });

  it("gives a mutation a tighter budget than a query", async () => {
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({ limiter });
    const caller = callerFor(router, alice);
    await caller.me();
    await caller.rename();
    expect(calls[0]?.policy.limit).toBe(300);
    expect(calls[1]?.policy.limit).toBe(60);
  });

  it("counts a mutation and a query against different keys", async () => {
    // They are measured against two different limits, so sharing one counter
    // would let the tighter of the two silently govern both.
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({ limiter });
    const caller = callerFor(router, alice);
    await caller.me();
    await caller.rename();
    expect(calls[0]?.key).not.toBe(calls[1]?.key);
  });

  it("gives two users their own budgets", async () => {
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({ limiter });
    await callerFor(router, alice).me();
    await callerFor(router, bob).me();
    expect(new Set(calls.map((c) => c.key)).size).toBe(2);
  });
});

describe("refusal", () => {
  it("is TOO_MANY_REQUESTS, which tRPC maps to a 429", async () => {
    const { limiter } = recordingLimiter(() => false);
    const { router } = routerFor({ limiter });
    expect(await codeOf(callerFor(router, alice).me())).toBe("TOO_MANY_REQUESTS");
  });

  it("names the wait, because tRPC cannot send a Retry-After header", async () => {
    const { limiter } = recordingLimiter(() => false);
    const { router } = routerFor({ limiter });
    try {
      await callerFor(router, alice).me();
      throw new Error("expected the call to reject");
    } catch (cause) {
      expect((cause as TRPCError).message).toMatch(/Try again in \d+ seconds?\./);
    }
  });

  it("refuses before the handler runs", async () => {
    let handlerRan = false;
    const { limiter } = recordingLimiter(() => false);
    const p = createProcedures(t, loaders, { rateLimit: { limiter } });
    const router = t.router({
      expensive: p.protectedProcedure.meta({ scope: "authenticated" }).mutation(() => {
        handlerRan = true;
        return "done";
      }),
    });
    await codeOf(
      t.createCallerFactory(router)(createScaffoldContext({ principal: alice }))
        .expensive(),
    );
    expect(handlerRan).toBe(false);
  });

  it("lets the limit through and refuses the next one", async () => {
    const { limiter } = recordingLimiter((_key, seen) => seen <= 2);
    const { router } = routerFor({ limiter });
    const caller = callerFor(router, alice);
    expect(await caller.me()).toBe("usr_alice");
    expect(await caller.me()).toBe("usr_alice");
    expect(await codeOf(caller.me())).toBe("TOO_MANY_REQUESTS");
  });
});

describe("overrides", () => {
  it("can leave one path unlimited", async () => {
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({
      limiter,
      policyFor: (info) =>
        info.path === "me" ? null : { limit: 1, windowMs: 60_000 },
    });
    await callerFor(router, alice).me();
    expect(calls).toEqual([]);
  });

  it("can key off anything on the context", async () => {
    const { limiter, calls } = recordingLimiter();
    const { router } = routerFor({
      limiter,
      keyFor: (info) => `request:${info.ctx.requestId}`,
    });
    await callerFor(router, alice).me();
    expect(calls[0]?.key).toMatch(/^authenticated:query:request:/);
  });
});

describe("the scope audit still sees the rung", () => {
  it("reports the same scope with the limiter installed as without", () => {
    // The rate-limit middleware is deliberately not scope-tagged. If it were
    // tagged wrongly, or if adding it displaced the tagged middlewares,
    // `auditBuiltProcedures` would start passing procedures it should fail.
    const { limiter } = recordingLimiter();
    const plain = routerFor(undefined).router;
    const limited = routerFor({ limiter }).router;
    for (const path of ["ping", "me", "tenantEcho", "listTenants"] as const) {
      expect(scopeOfProcedure(limited[path])).toBe(scopeOfProcedure(plain[path]));
    }
  });

  it("still derives staff for a staff procedure", () => {
    const { limiter } = recordingLimiter();
    const { router } = routerFor({ limiter });
    expect(scopeOfProcedure(router.listTenants)).toBe("staff");
    expect(scopeOfProcedure(router.tenantEcho)).toBe("tenant");
    expect(scopeOfProcedure(router.ping)).toBe("public");
  });
});
