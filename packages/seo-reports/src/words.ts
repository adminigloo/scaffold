/**
 * THE WORKLIST'S WORDS (0.2): for each check, what a business owner is asked
 * to do about it — no "canonical", no "h1", no "JSON-LD" in the sentence they
 * act on (the evidence keeps the technical name in brackets, for whoever they
 * hand it to). Shared by the screen and by anyone drawing the report
 * themselves.
 */

export interface CheckWords {
  /** The to-do, as an instruction: "Give each page a title". */
  readonly todo: string;
  /** Why it matters, in one sentence. */
  readonly why: string;
}

export const CHECK_WORDS: Readonly<Record<string, CheckWords>> = {
  "page.fetch": { todo: "Fix pages that don't open", why: "A page that answers with an error can't be found in search, and visitors who follow a link to it leave." },
  "page.title": { todo: "Give each page a clear title", why: "Search results show the title as the blue link people click." },
  "page.description": { todo: "Write a one-line summary for each page", why: "It's the line under the link in search results — your pitch." },
  "page.h1": { todo: "Give each page one main heading", why: "One heading tells search engines and AI assistants what the page is about." },
  "page.canonical": { todo: "Tell search engines each page's main address", why: "Without it, copies of a page with extra bits in the address compete with the real one." },
  "page.og": { todo: "Add a picture and title for link previews", why: "Links shared in texts and social posts show a plain grey box without them." },
  "page.noindex": { todo: "Let search engines list these pages", why: "These pages ask to be left out of search, so nobody can find them there." },
  "page.x-robots-tag": { todo: "Stop the server hiding these pages from search", why: "Your server tells search engines to leave these pages out." },
  "page.img-alt": { todo: "Describe your pictures", why: "Search engines and screen readers can't see pictures; a short description tells them what's there." },
  "page.structured-data": { todo: "Add your business details in a form machines can read", why: "AI assistants and search engines quote your name, address and hours from it first." },
  "page.headings": { todo: "Break long pages into sections", why: "AI assistants quote sections with clear headings; walls of text get skipped." },
  "site.robots": { todo: "Serve a robots.txt file", why: "It's the first file search engines look for, telling them what they may read." },
  "site.ai-crawlers": { todo: "Let AI assistants read your site", why: "AI assistants you block can only describe you from what other people write." },
  "site.search-crawlers": { todo: "Let Google and Bing read your site", why: "Search engines you block can't list your pages at all." },
  "site.llms-txt": { todo: "Add an llms.txt file", why: "It tells AI assistants where the important pages are." },
  "site.sitemap": { todo: "Serve a sitemap listing your pages", why: "It's how search engines find every page, not just the ones linked from your home page." },
  "site.crawl-cap": { todo: "Only part of the site was checked", why: "Checks stop after a set number of pages; the rest are checked next time." },
  "site.duplicate-titles": { todo: "Give pages different titles", why: "Pages with the same title look like the same page in search results." },
  "site.duplicate-descriptions": { todo: "Give pages different summaries", why: "The same summary on many pages tells searchers nothing about which one they want." },
  "site.broken-links": { todo: "Fix links that lead nowhere", why: "Visitors hit an error page, and search engines count it against the site." },
  "site.moved-away": { todo: "Check links that move to another website", why: "Some of your addresses send visitors to a site that isn't on your list, so they weren't checked." },
};

/** The words for a check id; a sensible fallback for an id this version doesn't know. */
export function wordsFor(id: string, label: string): CheckWords {
  return CHECK_WORDS[id] ?? { todo: label, why: "" };
}
