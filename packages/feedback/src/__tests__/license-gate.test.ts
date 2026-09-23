import { describe, expect, it } from "vitest";
import { generateLicenseKeypair, signLicense } from "@adminigloo/license";
import { createFeedbackHandlers } from "../index.js";

/**
 * The license gate is a no-op unless configured, and a 402 when configured to
 * enforce and unsatisfied. It fires BEFORE the client-key check, so these
 * assertions read the gate off the status code alone — 402 is the gate, 401 is
 * the visitor-key check behind it — with no database interaction at all.
 */

const KEYS = generateLicenseKeypair();
const BASE = "http://localhost/api/igloo";
const nullDb = {} as never; // never reached; the gate returns first, or 401 does

function req(): Request {
  return new Request(`${BASE}/v1/config`, { method: "GET" });
}

function feedbackLicense(): string {
  return signLicense(
    {
      v: 1,
      customer: "acme",
      features: ["feedback"],
      issuedAt: Math.floor(Date.now() / 1000) - 100,
    },
    KEYS.privateKey,
  );
}

describe("feedback license gate", () => {
  it("is a no-op when no license is configured", async () => {
    const { handle } = createFeedbackHandlers({ db: nullDb });
    // No x-adminigloo-key header, so the client-key check answers 401 — proving
    // the request got PAST any gate rather than being stopped by a 402.
    expect((await handle(req())).status).toBe(401);
  });

  it("is a no-op in mode off even with no key", async () => {
    const { handle } = createFeedbackHandlers({
      db: nullDb,
      license: { mode: "off", publicKey: KEYS.publicKey },
    });
    expect((await handle(req())).status).toBe(401);
  });

  it("answers 402 under enforce with no license", async () => {
    const { handle } = createFeedbackHandlers({
      db: nullDb,
      license: { mode: "enforce", publicKey: KEYS.publicKey },
    });
    expect((await handle(req())).status).toBe(402);
  });

  it("answers 402 under enforce for a license that does not cover feedback", async () => {
    const wrong = signLicense(
      { v: 1, customer: "acme", features: ["assistant"], issuedAt: 1 },
      KEYS.privateKey,
    );
    const { handle } = createFeedbackHandlers({
      db: nullDb,
      license: { mode: "enforce", publicKey: KEYS.publicKey, key: wrong },
    });
    expect((await handle(req())).status).toBe(402);
  });

  it("passes the gate for a valid feedback license, then hits the key check", async () => {
    const { handle } = createFeedbackHandlers({
      db: nullDb,
      license: { mode: "enforce", publicKey: KEYS.publicKey, key: feedbackLicense() },
    });
    // Past the 402 gate; 401 because no visitor key header was sent.
    expect((await handle(req())).status).toBe(401);
  });
});
