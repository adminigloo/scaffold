import { describe, expect, it } from "vitest";
import * as admin from "../admin/index.js";
import * as pub from "../index.js";

/**
 * Both entries speak the same wire version, the one the server's routes carry
 * (`{base}/v1/...`), and export what contract 9.8 names — so a host's import
 * line from the README works as written.
 */
describe("estimator-widget entries", () => {
  it("speak wire version v1 from both entries", () => {
    expect(pub.ESTIMATOR_WIRE_VERSION).toBe("v1");
    expect(admin.ESTIMATOR_WIRE_VERSION).toBe(pub.ESTIMATOR_WIRE_VERSION);
  });

  it("the public entry exports what 9.8 names", () => {
    for (const name of [
      "EstimateTool",
      "QuoteView",
      "CustomerFields",
      "EstimatorProvider",
      "EstimatorButton",
      "EstimatorModal",
      "useEstimator",
      "EstimatorTransport",
      "createEstimatorClient",
      "injectEstimatorStyles",
      "estimatorWidgetCss",
      "LIGHT_TOKENS",
      "DARK_TOKENS",
      "CONTRAST_PAIRS",
      "contrastRatio",
      "brandTokens",
      "resolveHostTheme",
      "fitWithin",
      "resizePhoto",
      "formatMoney",
      "friendlyError",
      "ESTIMATOR_WIRE_VERSION",
    ]) {
      expect(pub, name).toHaveProperty(name);
    }
  });

  it("the admin entry exports what 9.8 names", () => {
    for (const name of [
      "EstimatorAdmin",
      "PriceBook",
      "EstimatesQueue",
      "EstimatesQueueActions",
      "EstimateEditor",
      "EmbedKeys",
      "EstimatorSettings",
      "AdminNotices",
      "createEstimatorAdminClient",
      "injectEstimatorAdminStyles",
      "estimatorAdminCss",
      "ESTIMATOR_WIRE_VERSION",
    ]) {
      expect(admin, name).toHaveProperty(name);
    }
  });

  it("the customer entry never carries the staff screens", () => {
    for (const name of ["PriceBook", "EstimateEditor", "createEstimatorAdminClient", "estimatorAdminCss"]) expect(pub).not.toHaveProperty(name);
  });
});
