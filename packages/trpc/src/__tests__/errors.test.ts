import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { PermissionDeniedError } from "@adminigloo/permissions";
import {
  isPermissionDenied,
  permissionDenied,
  permissionDeniedToTRPCError,
} from "../errors.js";

/**
 * A second physical copy of `PermissionDeniedError`, as pnpm produces when a
 * peer range is satisfied by two different installs. Nothing about this object
 * is related to the imported class, which is the whole reason the check is
 * name-based.
 */
class DuplicateCopyPermissionDeniedError extends Error {
  readonly name = "PermissionDeniedError";
  constructor(readonly permission: string) {
    super(`Permission denied: ${permission}`);
  }
}

describe("permissionDeniedToTRPCError", () => {
  it("maps a real PermissionDeniedError onto FORBIDDEN", () => {
    const error = permissionDeniedToTRPCError(
      new PermissionDeniedError("billing.invoice.void", "tenant"),
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect(error?.code).toBe("FORBIDDEN");
    expect(error?.message).toBe("Permission denied: billing.invoice.void");
  });

  it("keeps the original as the cause, so the server log still names the scope", () => {
    const cause = new PermissionDeniedError("staff.impersonate", "staff");
    expect(permissionDeniedToTRPCError(cause)?.cause).toBe(cause);
  });

  it("maps a denial thrown by a DUPLICATE copy of the permissions package", () => {
    // This is the case `instanceof` gets wrong, and it only reproduces on the
    // machine with the duplicate install: the 403 silently becomes a 500.
    const error = permissionDeniedToTRPCError(
      new DuplicateCopyPermissionDeniedError("billing.invoice.void"),
    );

    expect(error?.code).toBe("FORBIDDEN");
    expect(error?.message).toBe("Permission denied: billing.invoice.void");
  });

  it("declines anything that is not a permission denial", () => {
    expect(permissionDeniedToTRPCError(new Error("connection reset"))).toBeUndefined();
    expect(
      permissionDeniedToTRPCError(new TRPCError({ code: "NOT_FOUND" })),
    ).toBeUndefined();
    expect(permissionDeniedToTRPCError(undefined)).toBeUndefined();
    expect(permissionDeniedToTRPCError(null)).toBeUndefined();
    expect(permissionDeniedToTRPCError("Permission denied: x")).toBeUndefined();
  });

  it("declines an error wearing the name but carrying no permission", () => {
    // Mapping this would produce `Permission denied: undefined`, which looks
    // like a real answer and is therefore worse than the 500 it replaced.
    const nameOnly = new Error("nope");
    nameOnly.name = "PermissionDeniedError";
    expect(permissionDeniedToTRPCError(nameOnly)).toBeUndefined();
  });

  it("declines a plain object impersonating one", () => {
    // Only a thrown Error reaches us as a tRPC error cause. Anything else
    // arrived from somewhere that was never a throw, and guessing about it is
    // how a deserialised payload starts deciding response codes.
    expect(
      permissionDeniedToTRPCError({
        name: "PermissionDeniedError",
        permission: "billing.invoice.void",
      }),
    ).toBeUndefined();
  });

  it("uses the permission field rather than reusing the thrown message", () => {
    // The two happen to agree for PermissionDeniedError. They must not be
    // allowed to drift: a message someone reworded upstream would change the
    // wire response of every 403 in the app.
    const odd = new DuplicateCopyPermissionDeniedError("reports.export");
    odd.message = "you shall not pass";

    expect(permissionDeniedToTRPCError(odd)?.message).toBe(
      "Permission denied: reports.export",
    );
  });
});

describe("isPermissionDenied", () => {
  it("narrows to something with a permission key", () => {
    const cause: unknown = new PermissionDeniedError("reports.export", "tenant");
    expect(isPermissionDenied(cause) && cause.permission).toBe("reports.export");
  });

  it("rejects non-errors without throwing on them", () => {
    expect(isPermissionDenied(0)).toBe(false);
    expect(isPermissionDenied("")).toBe(false);
    expect(isPermissionDenied([])).toBe(false);
  });
});

describe("permissionDenied", () => {
  it("is the single FORBIDDEN shape the middleware throws", () => {
    const error = permissionDenied("billing.invoice.void");
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toBe("Permission denied: billing.invoice.void");
  });
});
