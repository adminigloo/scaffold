import { describe, expect, it } from "vitest";
import { resolvePublicBookingPolicy } from "__SCOPE__/scheduling";
import {
  PUBLIC_POLICY,
  PUBLIC_VISIT_LENGTHS,
  publicRequestInput,
  publicSlotsInput,
} from "@/server/scheduling-policy";

/**
 * The public scheduling inputs and the policy they are checked against.
 *
 * The package refuses a visit length the policy doesn't offer, so the danger
 * here is not a bad booking — it is a contract that lies: a picker built from
 * the procedure's input type offering 45 minutes, and every one of those
 * requests coming back 400. The inputs are derived from the policy so they
 * can't, and this keeps them derived.
 */

const request = {
  slotId: "abc",
  customerName: "Pat",
  customerEmail: "pat@example.com",
};

describe("the public scheduling inputs", () => {
  it("slots takes exactly the policy's visit lengths, 60 by default", () => {
    for (const minutes of PUBLIC_VISIT_LENGTHS) {
      expect(publicSlotsInput.safeParse({ durationMinutes: minutes }).success).toBe(true);
    }
    for (const minutes of [15, 45, 480]) {
      expect(publicSlotsInput.safeParse({ durationMinutes: minutes }).success).toBe(false);
    }
    expect(publicSlotsInput.parse({})).toEqual({ durationMinutes: 60, daysAhead: 14 });
  });

  it("slots looks no further than the policy's horizon", () => {
    expect(publicSlotsInput.safeParse({ daysAhead: PUBLIC_POLICY.horizonDays }).success).toBe(true);
    expect(publicSlotsInput.safeParse({ daysAhead: PUBLIC_POLICY.horizonDays + 1 }).success).toBe(false);
  });

  it("a request takes the same lengths, and neither a tenant nor a skill from the client", () => {
    expect(publicRequestInput.safeParse({ ...request, durationMinutes: 90 }).success).toBe(true);
    expect(publicRequestInput.safeParse({ ...request, durationMinutes: 45 }).success).toBe(false);
    const parsed = publicRequestInput.parse({
      ...request,
      durationMinutes: 60,
      tenantId: "someone-else",
      requiredSkill: "anything",
    });
    expect(parsed).not.toHaveProperty("tenantId");
    expect(parsed).not.toHaveProperty("requiredSkill");
  });

  it("is the policy the package runs on", () => {
    const resolved = resolvePublicBookingPolicy(PUBLIC_POLICY);
    expect(resolved.durationsMinutes).toEqual(PUBLIC_VISIT_LENGTHS);
    expect(resolved.requestStatus).toBe("pending");
    expect(resolved.maxOpenRequestsPerRequester).toBe(3);
  });
});
