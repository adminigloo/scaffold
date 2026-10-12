import { defineConfig } from "tsup";

/**
 * Two entries, both client bundles, the booking-widget's arrangement: the
 * customer-facing components (`.`: VisitPicker, ManageVisit) and the staff
 * screens (`./admin`: ScheduleCalendar, CrewDay, SchedulingSettings). Separate
 * entries so a marketing page that embeds the picker never ships the calendar;
 * one config because both need the same banner. tsup strips in-file
 * "use client" directives while bundling, so the banner re-applies it to every
 * bundle head (shared chunks included). Without it, every app-router page that
 * renders one of these from a server component fails to build.
 *
 * The admin entry lives at src/admin/index.ts and is NAMED `admin` here, so it
 * lands at dist/admin.js, the path package.json's "./admin" export points at.
 *
 * `clean` is done once in the build script (the analytics precedent), so a
 * second config added later cannot delete this one's output mid-build.
 */
export default defineConfig({
  entry: { index: "src/index.ts", admin: "src/admin/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
  banner: { js: '"use client";' },
  external: ["react", "react-dom"],
});
