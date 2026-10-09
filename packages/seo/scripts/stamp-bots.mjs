// Records which @adminigloo/analytics bot list this package was last released
// with (bots.lock.json). Run after `pnpm build`, in the same change as the
// @adminigloo/seo changeset that ships a new list:
//
//   pnpm --filter @adminigloo/analytics build && pnpm --filter @adminigloo/seo build
//   pnpm --filter @adminigloo/seo stamp:bots
//
// src/__tests__/robots-drift.test.ts fails while the list analytics has now
// differs from this stamp and no @adminigloo/seo changeset is pending.
import { readFileSync, writeFileSync } from "node:fs";
import { KNOWN_CRAWLERS, ROBOTS_CONTROL_TOKENS } from "@adminigloo/analytics/crawlers";
import { botListFingerprint } from "../dist/index.js";

const analytics = JSON.parse(readFileSync(new URL("../node_modules/@adminigloo/analytics/package.json", import.meta.url), "utf8")).version;
const lock = {
  fingerprint: botListFingerprint([...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS]),
  analytics,
  bots: [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS].filter((bot) => bot.robotsTokens.length > 0).map((bot) => bot.name),
};
writeFileSync(new URL("../bots.lock.json", import.meta.url), `${JSON.stringify(lock, null, 2)}\n`);
console.log(`bots.lock.json: ${lock.bots.length} bots from @adminigloo/analytics ${analytics}, fingerprint ${lock.fingerprint}`);
