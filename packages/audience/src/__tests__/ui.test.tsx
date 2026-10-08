import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AudienceRulesPanel,
  ExcludedNote,
  excludedSentence,
  IncludeInternalToggle,
  MarkThisBrowserButton,
  maskForDisplay,
  safeHref,
  UnfilteredSourcesNote,
  type RuleView,
  type RunView,
} from "../ui.js";

/**
 * The components without a DOM: what each renders on the server (the first
 * paint of every Next page). The interactive flows — preview before add,
 * keyboard, removal, axe and 44px targets — run in a real browser in
 * e2e/tests/audience-ui.spec.ts.
 */

const html = (node: ReactElement) => renderToStaticMarkup(node);

const RULES: RuleView[] = [
  { id: "r1", kind: "email", value: "rachel@gmail.com", reasonLabel: "Client", createdBy: "dallin@adminigloo.com", createdAt: "2026-10-01T10:00:00Z" },
  { id: "r2", kind: "email_domain", value: "riddlergo.com", createdAt: new Date("2026-09-01T00:00:00Z") },
  { id: "r3", kind: "network", value: "203.0.113.0/24", reasonLabel: "Office", createdAt: "2026-09-02T00:00:00Z" },
];
const RUNS: RunView[] = [
  { id: "x1", action: "apply", subjectsChanged: 3, sessionsAffected: 12, runBy: "dallin@adminigloo.com", runAt: "2026-10-01T10:00:01Z", summary: "Internal rule added (person (email) r***@gmail.com): 12 sessions excluded back to 2026-06-10" },
];

describe("excludedSentence", () => {
  it("lists reasons in precedence order and sums reasons that share a word", () => {
    expect(excludedSentence({ total: 312, byReason: { email: 40, role: 200, named_user: 60, automation: 12 } })).toBe(
      "Excluded: 312 sessions (automation 12, staff 200, named person 100)",
    );
    expect(excludedSentence({ total: 0, byReason: {} })).toBe("Excluded: none");
    expect(excludedSentence({ total: 1200, byReason: { role: 1200 }, unit: "visits" })).toBe("Excluded: 1,200 visits (staff 1,200)");
    expect(excludedSentence({ total: 5, byReason: { role: 5 } }, { includeInternal: true })).toBe("Including 5 internal sessions (staff 5)");
    expect(excludedSentence({ total: 5, byReason: { role: 5 } }, { labels: { role: "team" } })).toBe("Excluded: 5 sessions (team 5)");
  });
});

describe("IncludeInternalToggle", () => {
  it("is a link drawn as a switch; on, it shows the banner", () => {
    const off = html(<IncludeInternalToggle value={false} href="/admin/analytics?include_internal=1" />);
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('href="/admin/analytics?include_internal=1"');
    expect(off).not.toContain(`class="aiu-banner"`);
    const on = html(<IncludeInternalToggle value href="/admin/analytics" />);
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain("Internal traffic is included.");
  });

  it("ships its stylesheet with the first paint (React 19 hoists it)", () => {
    expect(html(<IncludeInternalToggle value={false} href="/x" />)).toContain(`data-href="aiu-styles"`);
  });
});

describe("ExcludedNote", () => {
  it("says what was left out", () => {
    expect(html(<ExcludedNote excluded={{ total: 3, byReason: { pattern: 3 } }} />)).toContain("<b>Excluded:</b> 3 sessions (test account 3)");
  });
});

describe("AudienceRulesPanel", () => {
  const noop = async () => ({ retroactive: true, subjects: { users: 0, visitors: 0, orgs: 0, events: 0, orders: 0 }, windows: [], limits: [] });

  it("staff: rules, the add form, Remove on each rule, the code rule and the history", () => {
    const out = html(
      <AudienceRulesPanel rules={RULES} runs={RUNS} canEdit onPreview={noop} onAdd={async () => {}} onRemove={async () => {}} codeRule="Platform role is super, staff or analytics" />,
    );
    expect(out).toContain("rachel@gmail.com");
    expect(out).toContain("Rules (3)");
    expect(out).toContain("Add a rule");
    expect((out.match(/>Remove</g) ?? []).length).toBe(3);
    expect(out).toContain("Platform role is super, staff or analytics");
    expect(out).toContain("cleans history");
    expect(out).toContain("new visits only");
    expect(out).toContain("12 sessions excluded back to 2026-06-10");
    // Add is disabled until a preview of the same draft exists.
    expect(out).toMatch(/<button type="button" class="aiu-btn aiu-btn-primary" disabled=""[^>]*>Add rule<\/button>/);
  });

  it("the analytics role: no form, no Remove, and no address on the page", () => {
    const out = html(<AudienceRulesPanel rules={RULES} runs={RUNS} canEdit={false} maskEmails onPreview={noop} onAdd={async () => {}} onRemove={async () => {}} />);
    expect(out).not.toContain("Add a rule");
    expect(out).not.toContain(">Remove<");
    expect(out).toContain("View only.");
    expect(out).not.toContain("rachel@gmail.com");
    expect(out).not.toContain("dallin@adminigloo.com");
    expect(out).toContain("r***@gmail.com");
  });

  it("an empty list says the defaults still apply", () => {
    expect(html(<AudienceRulesPanel rules={[]} canEdit={false} />)).toContain("No rules yet. The defaults and the rule in code still apply.");
  });
});

describe("MarkThisBrowserButton and UnfilteredSourcesNote", () => {
  it("offers the button, or the state when already marked", () => {
    expect(html(<MarkThisBrowserButton onMark={async () => {}} />)).toContain("Exclude this browser from analytics");
    expect(html(<MarkThisBrowserButton onMark={async () => {}} marked />)).toContain("This browser is excluded from analytics.");
  });

  it("lists the outside numbers that cannot be cleaned", () => {
    const out = html(<UnfilteredSourcesNote />);
    for (const name of ["Google Search Console", "AI answer engines", "Stripe and Clerk dashboards", "Digests already sent", "Ad pixels"]) {
      expect(out).toContain(name);
    }
  });
});

describe("maskForDisplay", () => {
  it("masks any address in text", () => {
    expect(maskForDisplay("asked by jane.doe@gmail.com and bob@x.io")).toBe("asked by j***@gmail.com and b***@x.io");
  });
});

// ---------------------------------------------------------------------------
// Review regressions. Each test below fails on the code before its fix.
// ---------------------------------------------------------------------------

describe("review: the toggle never follows a script URL", () => {
  it("accepts paths, queries, fragments and http(s); refuses javascript:, data:, protocol-relative and control characters", () => {
    for (const ok of ["/admin/analytics?include_internal=1", "?include_internal=1", "#top", "audience?x=1", "https://admin.riddlergo.com/a"]) {
      expect(safeHref(ok), ok).toBe(ok);
    }
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "java\nscript:alert(1)", "data:text/html,x", "//evil.example/x", "\u0001javascript:x", ""]) {
      expect(safeHref(bad), JSON.stringify(bad)).toBeNull();
    }
    const out = html(<IncludeInternalToggle value={false} href="javascript:alert(document.cookie)" />);
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="#"');
  });
});

describe("review: a view-only panel masks by default", () => {
  it("canEdit={false} without maskEmails shows no address; an editor still sees them", () => {
    const viewer = html(<AudienceRulesPanel rules={RULES} runs={RUNS} canEdit={false} />);
    expect(viewer).not.toContain("rachel@gmail.com");
    expect(viewer).not.toContain("dallin@adminigloo.com");
    expect(viewer).toContain("r***@gmail.com");
    expect(html(<AudienceRulesPanel rules={RULES} runs={RUNS} canEdit />)).toContain("rachel@gmail.com");
    expect(html(<AudienceRulesPanel rules={RULES} runs={RUNS} canEdit={false} maskEmails={false} />)).toContain("rachel@gmail.com");
  });
});
