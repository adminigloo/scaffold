import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmailPreferences, SignUpEmailChoice } from "../ui.js";

const initial = {
  preferences: { userId: "user_ann", timeZone: "America/Chicago", timeZoneSource: "browser" as const, deliveryHour: 7, choices: { morning: false, "price-alerts": true } },
  kinds: [
    { type: "digest" as const, key: "morning", title: "Morning summary", description: "Yesterday's results." },
    { type: "alert" as const, key: "price-alerts", title: "Price alerts", description: "When a price crosses your line." },
  ],
  siteTimeZone: "America/New_York",
};

describe("the screens", () => {
  it("the preferences list every email with its own box, the hour and the zone", () => {
    const markup = renderToStaticMarkup(<EmailPreferences initial={initial} timeZones={["America/Chicago", "Asia/Tokyo"]} />);
    expect(markup).toContain("Morning summary");
    expect(markup).toContain("Price alerts");
    expect(markup).toMatch(/id="aidg-morning" type="checkbox"(?![^>]*checked)/);
    expect(markup).toMatch(/id="aidg-price-alerts" type="checkbox" checked=""/);
    expect(markup).toContain("At or after 7 AM, America/Chicago.");
    expect(markup).toContain("This site&#x27;s (America/New_York)");
  });

  it("says so when there is nothing to choose", () => {
    expect(renderToStaticMarkup(<EmailPreferences initial={{ ...initial, kinds: [] }} />)).toContain("doesn&#x27;t send any emails you can choose yet");
  });

  it("the sign-up opt-in is unticked, one box per digest", () => {
    const markup = renderToStaticMarkup(<SignUpEmailChoice digests={[{ key: "morning", title: "Morning summary", description: "Yesterday's results." }]} />);
    expect(markup).toContain("Email me the Morning summary");
    expect(markup).not.toContain("checked");
    expect(renderToStaticMarkup(<SignUpEmailChoice digests={[]} />)).toBe("");
  });
});
