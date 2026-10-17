import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiMentions, createAiMentionsTransport, trendSentence } from "../ui.js";
import type { MentionsOverviewWire, QuestionWire } from "../wire.js";

/**
 * The AI mentions screen's first paint: the question, the verdict, the quote
 * AS TEXT (an answer's markup never becomes markup), only http(s) sources as
 * links, the trend in words; the form for who the business is before it's
 * been said; Check now only for someone who may and only when it's on.
 */

const question: QuestionWire = {
  id: "q1",
  question: "wheelchair ramp rental Raleigh",
  createdAt: "2026-10-01T00:00:00.000Z",
  latest: {
    id: "c1",
    questionId: "q1",
    checkedAt: "2026-10-16T15:00:00.000Z",
    engine: "Claude",
    status: "done",
    cited: true,
    mentioned: true,
    sourceCited: true,
    matchedOn: "brand",
    snippet: "…try Ramp Masters <script>alert(1)</script> for rentals…",
    sources: ["https://rampmasters.com/rentals"],
    matchedUrl: "https://rampmasters.com/rentals",
    competitorsNamed: ["TruGreen"],
    problem: null,
  },
  trend: [
    { week: "2026-10-06", checks: 1, cited: 0 },
    { week: "2026-10-13", checks: 2, cited: 2 },
  ],
  nextAutomaticAt: "2026-10-23T15:00:00.000Z",
};

const overview: MentionsOverviewWire = {
  profile: { brand: "Ramp Masters", domain: "rampmasters.com", aliases: [], competitors: ["TruGreen"], updatedAt: "2026-10-01T00:00:00.000Z" },
  suggested: null,
  questions: [question],
  canManage: true,
  engine: { on: true, label: "Claude", message: null },
  maxQuestions: 25,
  automatic: true,
  notice: null,
};

const transport = createAiMentionsTransport({ baseUrl: "/x" });

describe("<AiMentions>", () => {
  it("shows the verdict, the quote as text, the sources and the trend", () => {
    const markup = renderToStaticMarkup(<AiMentions transport={transport} initial={overview} />);
    expect(markup).toContain("Named you");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>alert");
    expect(markup).toContain('href="https://rampmasters.com/rentals"');
    expect(markup).toContain('rel="nofollow noopener noreferrer"');
    expect(markup).toContain("Also named: TruGreen");
    expect(markup).toContain("Named in 2 of 3 answers over the last 2 weeks.");
    expect(markup).toContain("Check now");
    expect(markup).toContain("Asked again automatically around Oct 23.");
  });

  it("says when the month's checks are used up", () => {
    const markup = renderToStaticMarkup(<AiMentions transport={transport} initial={{ ...overview, notice: "This month's AI mention checks are used up. They start again on November 1." }} />);
    expect(markup).toContain("They start again on November 1.");
  });

  it("asks who the business is first, from the company's name, and hides Check now while off", () => {
    const markup = renderToStaticMarkup(
      <AiMentions transport={transport} initial={{ ...overview, profile: null, suggested: { brand: "Snowplow Co", domain: null }, engine: { on: false, label: null, message: "Checking isn't switched on here yet." } }} />,
    );
    expect(markup).toContain("How answers would name you");
    expect(markup).toContain('value="Snowplow Co"');
    expect(markup).toContain("Checking isn&#x27;t switched on here yet.");
    expect(markup).not.toContain("Check now");
  });

  it("shows no controls to someone who may only look", () => {
    const markup = renderToStaticMarkup(<AiMentions transport={transport} initial={{ ...overview, canManage: false }} />);
    expect(markup).not.toContain("Check now");
    expect(markup).not.toContain("Remove");
    expect(markup).not.toContain("Add a question");
  });

  it("says a question nobody's checked lately hasn't been", () => {
    expect(trendSentence({ ...question, trend: [{ week: "x", checks: 0, cited: 0 }] })).toBe("Not checked in the last 8 weeks.");
  });
});
