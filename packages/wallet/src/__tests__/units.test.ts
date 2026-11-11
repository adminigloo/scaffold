import { describe, expect, it } from "vitest";
import { formatCredits, isCreditUnit, MAX_CREDIT_AMOUNT, assertCreditAmount, InvalidCreditAmountError } from "../units.js";
import { walletPermissions } from "../permissions.js";

describe("units", () => {
  it("is a lower-case slug that starts with a letter", () => {
    for (const ok of ["crowns", "ai-credits", "t", "gems2"]) expect(isCreditUnit(ok)).toBe(true);
    for (const bad of ["Crowns", "crowns ", " crowns", "2gems", "-gems", "a".repeat(33), "", "gold_crowns", null, 3]) {
      expect(isCreditUnit(bad)).toBe(false);
    }
  });

  it("caps a single movement where an int column still has room", () => {
    expect(() => assertCreditAmount(MAX_CREDIT_AMOUNT)).not.toThrow();
    expect(() => assertCreditAmount(MAX_CREDIT_AMOUNT + 1)).toThrow(InvalidCreditAmountError);
    expect(MAX_CREDIT_AMOUNT * 2).toBeLessThan(2_147_483_647);
  });

  it("formats with or without a label", () => {
    expect(formatCredits(1, "crowns", { one: "crown", many: "crowns" })).toBe("1 crown");
    expect(formatCredits(2500, "crowns", { one: "crown", many: "crowns" })).toBe("2,500 crowns");
    expect(formatCredits(3, "ai-credits")).toBe("3 ai-credits");
  });
});

describe("permissions", () => {
  it("are staff keys under credits.*, adjust held by admin only by default", () => {
    expect(Object.keys(walletPermissions).every((key) => key.startsWith("credits."))).toBe(true);
    expect(walletPermissions["credits.balances.adjust"].defaultFor).toEqual(["admin"]);
  });
});
