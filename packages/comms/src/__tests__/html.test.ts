import { describe, expect, it } from "vitest";
import { escapeHtml, plainTextToEmailHtml } from "../html.js";

describe("plainTextToEmailHtml", () => {
  it("escapes BEFORE adding markup, so a variable cannot inject HTML", () => {
    const html = plainTextToEmailHtml('Hi <script>alert(1)</script> & "friends"');
    expect(html).toBe("<p>Hi &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;friends&quot;</p>");
    expect(html).not.toContain("<script>");
  });

  it("turns blank-line paragraphs into <p> and single newlines into <br>", () => {
    expect(plainTextToEmailHtml("Hi Sam,\n\nLine one\nLine two\r\n\r\nBye")).toBe(
      "<p>Hi Sam,</p>\n<p>Line one<br>Line two</p>\n<p>Bye</p>",
    );
  });

  it("links http(s) URLs, leaving trailing punctuation outside the link", () => {
    expect(plainTextToEmailHtml("Review us: https://example.com/r?a=1&b=2.")).toBe(
      '<p>Review us: <a href="https://example.com/r?a=1&amp;b=2">https://example.com/r?a=1&amp;b=2</a>.</p>',
    );
  });

  it("does not let a quote in a URL break out of the href", () => {
    const html = plainTextToEmailHtml('https://x.com/"><img src=x onerror=alert(1)>');
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://x.com/">https://x.com/</a>&quot;&gt;&lt;img');
  });

  it("never links a javascript: URL", () => {
    expect(plainTextToEmailHtml("javascript:alert(1)")).toBe("<p>javascript:alert(1)</p>");
  });
});

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
