import { Issues } from "./errors.js";
import { pathRule } from "./paths.js";
import { absoluteUrl, type Site } from "./site.js";
import { oneLine, utf8Bytes } from "./util.js";

/**
 * llms.txt (the index, https://llmstxt.org) and llms-full.txt (the text) from
 * a content registry the app supplies: the SAME lists its pages render (the
 * feature registry, the pricing plans, the FAQ file, the template rows). The
 * package writes structure only, never prose about your product, so the
 * files cannot drift from the pages (trailcards' hard-coded llms-full.txt
 * promised live trail conditions the real page called "Coming soon", and
 * Riddler Go's llms files missed pricing, how-it-works and the FAQ).
 *
 * Every line under a `##` heading of llms.txt is a `- [name](url): notes`
 * link, the one shape llmstxt.org's parser reads (a bare URL, a numbered step
 * or an `Email:` line is dropped by it): the steps go on one linked line, each
 * plan links to the pricing page with its price as the note, contact is a
 * `mailto:` link.
 *
 * Every link is checked against the site's path list: a page under a
 * `private` or `noindex` path never appears (the sitemap and IndexNow apply
 * the same rule). Off production both files are empty and `llmsResponse`
 * answers 404, as the sitemap is empty there.
 *
 * Each file has a byte budget. Over it, the least important text goes first:
 * optional sections, then (in the full file) long bodies shortened to their
 * summaries, then items from the end of the LONGEST list first (so a
 * 400-trail list gives way before a five-page product list does), each list
 * saying how many it left out and where to find them. The result never
 * exceeds the budget.
 */

export interface LlmsItem {
  title: string;
  /**
   * The item's own page: a path on the site, or an absolute URL. Without one
   * (a puzzle type, an event mode: content with no page of its own) the index
   * links the item to llms-full.txt, where its text is.
   */
  path?: string;
  /** One or two sentences: what this page answers. Used in both files. */
  summary: string;
  /** The page's text, for llms-full.txt (Markdown is fine). Falls back to the summary. */
  body?: string;
}

export interface LlmsSection {
  title: string;
  /**
   * Markdown written under the section's heading in llms-full.txt, before
   * its items: for a section that is a list or a paragraph rather than a set
   * of pages (Riddler Go's "Event modes", "Who it's for"). The index links a
   * section that has only text to the full file.
   */
  text?: string;
  items?: readonly LlmsItem[];
  /** llms.txt's "Optional" section: links a reader with little room may skip. Dropped first under a budget. */
  optional?: boolean;
}

export interface LlmsPricingPlan {
  name: string;
  /** A number (formatted in the plan's currency) or your own text ("Free", "From $499"). */
  price: number | string;
  /** ISO 4217. Required when `price` is a number (here or on `pricing.currency`). */
  currency?: string;
  interval?: "month" | "year" | "week" | "day" | "one-time";
  description?: string;
  features?: readonly string[];
}

export interface LlmsFaqItem {
  question: string;
  answer: string;
  /** Where this one answer is, e.g. "/#faq-accounts". Without one, the FAQ is one link for all of them. */
  path?: string;
}

export interface LlmsRegistry {
  /** Default: the site name. */
  title?: string;
  /** The one-paragraph answer to "what is this?". Required. */
  summary: string;
  /** Further paragraphs, in llms-full.txt only. */
  about?: string;
  sections?: readonly LlmsSection[];
  howItWorks?: { title?: string; path?: string; steps: ReadonlyArray<{ name: string; text: string }> };
  pricing?: { title?: string; path?: string; currency?: string; plans: readonly LlmsPricingPlan[]; note?: string };
  faqs?: { title?: string; path?: string; items: readonly LlmsFaqItem[] };
  /** `links` are further contact routes, e.g. `{ title: "Book a call", path: "/book" }`. */
  contact?: { email?: string; path?: string; links?: ReadonlyArray<{ title: string; path: string }> };
}

export interface LlmsOptions {
  /** Byte budget. Default 50,000 for llms.txt, 200,000 for llms-full.txt (Riddler Go's D19 cap). */
  maxBytes?: number;
  /** Where llms-full.txt is served. Default "/llms-full.txt"; `false` when the site serves only llms.txt. */
  fullPath?: string | false;
  /** Where llms.txt is served. Default "/llms.txt". */
  indexPath?: string;
  /** Where the sitemap is. Default "/sitemap.xml". */
  sitemapPath?: string;
}

export interface LlmsDocument {
  text: string;
  bytes: number;
  maxBytes: number;
  /** Whether anything was shortened, dropped or cut to fit. */
  trimmed: boolean;
  /** Bodies replaced by their summary. */
  shortened: number;
  /** Items left out (each list names how many and where they are). */
  omitted: number;
  /** The tail was cut at a line boundary because even the essentials did not fit. */
  cut: boolean;
  /** The site is not indexable: the text is empty and `llmsResponse` answers 404. */
  offProduction: boolean;
}

export const LLMS_TXT_MAX_BYTES = 50_000;
export const LLMS_FULL_MAX_BYTES = 200_000;

// ---------------------------------------------------------------------------
// Validation and formatting
// ---------------------------------------------------------------------------

function validate(site: Site, registry: LlmsRegistry): void {
  const issues = new Issues("llms");
  const link = (path: string | undefined, at: string): void => {
    if (path === undefined) return;
    if (typeof path !== "string" || path.trim() === "") {
      issues.add(`${at} must be a path or a URL when given`);
      return;
    }
    let url: string;
    try {
      url = absoluteUrl(site, path);
    } catch {
      issues.add(`${at} "${path}" is neither an absolute URL nor a path starting with "/"`);
      return;
    }
    if (!url.startsWith(`${site.url}/`)) return;
    const rule = pathRule(site.paths, url);
    if (rule === "private" || rule === "noindex") issues.add(`${at} ${url} is under a ${rule} path in the site's path list, so it cannot be listed`);
  };

  issues.check(typeof registry.summary === "string" && oneLine(registry.summary) !== "", "summary is required");
  (registry.sections ?? []).forEach((section, s) => {
    issues.check(typeof section.title === "string" && section.title.trim() !== "", `sections[${s}].title is required`);
    issues.check((section.items?.length ?? 0) > 0 || Boolean(section.text?.trim()), `sections[${s}] needs items or text`);
    (section.items ?? []).forEach((item, i) => {
      const at = `sections[${s}].items[${i}]`;
      issues.check(typeof item.title === "string" && item.title.trim() !== "", `${at}.title is required`);
      issues.check(typeof item.summary === "string" && item.summary.trim() !== "", `${at}.summary is required`);
      link(item.path, `${at}.path`);
    });
  });
  link(registry.howItWorks?.path, "howItWorks.path");
  (registry.howItWorks?.steps ?? []).forEach((step, i) => {
    issues.check(Boolean(step.name?.trim()) && Boolean(step.text?.trim()), `howItWorks.steps[${i}] needs a name and text`);
  });
  link(registry.pricing?.path, "pricing.path");
  (registry.pricing?.plans ?? []).forEach((plan, i) => {
    issues.check(Boolean(plan.name?.trim()), `pricing.plans[${i}].name is required`);
    if (typeof plan.price === "number") {
      const currency = plan.currency ?? registry.pricing?.currency;
      issues.check(Boolean(currency && /^[A-Z]{3}$/.test(currency)), `pricing.plans[${i}]: a numeric price needs an ISO 4217 currency`);
      issues.check(Number.isFinite(plan.price) && plan.price >= 0, `pricing.plans[${i}].price must be at least 0`);
    } else {
      issues.check(typeof plan.price === "string" && plan.price.trim() !== "", `pricing.plans[${i}].price is required`);
    }
  });
  link(registry.faqs?.path, "faqs.path");
  (registry.faqs?.items ?? []).forEach((item, i) => {
    issues.check(Boolean(item.question?.trim()) && Boolean(item.answer?.trim()), `faqs.items[${i}] needs a question and an answer`);
    link(item.path, `faqs.items[${i}].path`);
  });
  link(registry.contact?.path, "contact.path");
  if (registry.contact?.email !== undefined) issues.check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registry.contact.email), "contact.email is not an email address");
  (registry.contact?.links ?? []).forEach((entry, i) => {
    issues.check(Boolean(entry.title?.trim()), `contact.links[${i}].title is required`);
    link(entry.path, `contact.links[${i}].path`);
  });
  issues.throwIfAny();
}

function linkText(value: string): string {
  return oneLine(value).replace(/([[\]\\])/g, "\\$1");
}

function linkUrl(site: Site, path: string): string {
  return absoluteUrl(site, path).replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
}

/** `- [text](url): note`, or `- text: note` when there is nowhere to link. */
function linkLine(text: string, url: string | null, note?: string): string {
  const head = url ? `- [${linkText(text)}](${url})` : `- ${oneLine(text)}`;
  return `${head}${note ? `: ${oneLine(note)}` : ""}\n`;
}

function block(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function formatPrice(plan: LlmsPricingPlan, fallbackCurrency: string | undefined): string {
  const amount =
    typeof plan.price === "number"
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: plan.currency ?? fallbackCurrency ?? "USD",
          minimumFractionDigits: Number.isInteger(plan.price) ? 0 : undefined,
        }).format(plan.price)
      : oneLine(plan.price);
  if (!plan.interval) return amount;
  return plan.interval === "one-time" ? `${amount} one-time` : `${amount}/${plan.interval}`;
}

function emptyDocument(maxBytes: number): LlmsDocument {
  return { text: "", bytes: 0, maxBytes, trimmed: false, shortened: 0, omitted: 0, cut: false, offProduction: true };
}

// ---------------------------------------------------------------------------
// The budgeted document
// ---------------------------------------------------------------------------

interface Unit {
  /** Richest first; a droppable unit's last variant is "". */
  variants: string[];
  level: number;
  /** Lower degrades first. Infinity never degrades. */
  priority: number;
  group: number | null;
}

interface Group {
  note: (omitted: number) => string;
  omitted: number;
}

class Doc {
  readonly units: Unit[] = [];
  readonly groups: Group[] = [];
  /** The unit index after which each group's note is written. */
  readonly noteAfter = new Map<number, number>();

  fixed(text: string): void {
    this.units.push({ variants: [text], level: 0, priority: Number.POSITIVE_INFINITY, group: null });
  }

  group(note: (omitted: number) => string): number {
    this.groups.push({ note, omitted: 0 });
    return this.groups.length - 1;
  }

  item(group: number, variants: string[], priority: number): void {
    this.units.push({ variants: [...variants, ""], level: 0, priority, group });
    this.noteAfter.set(group, this.units.length - 1);
  }

  size(): number {
    let total = 0;
    for (const unit of this.units) total += utf8Bytes(unit.variants[unit.level]!);
    for (const g of this.groups) total += g.omitted > 0 ? utf8Bytes(g.note(g.omitted)) : 0;
    return total;
  }

  render(): string {
    const out: string[] = [];
    const notes = new Map<number, number>();
    for (const [group, index] of this.noteAfter) notes.set(index, group);
    this.units.forEach((unit, index) => {
      out.push(unit.variants[unit.level]!);
      const group = notes.get(index);
      if (group !== undefined && this.groups[group]!.omitted > 0) out.push(this.groups[group]!.note(this.groups[group]!.omitted));
    });
    return out.join("");
  }

  /**
   * The next unit to shorten or drop at one priority: the last movable unit
   * of the list with the most units still standing (a tie goes to the later
   * list), so the longest list gives way first and every list loses from its
   * end.
   */
  private next(priority: number, movable: (unit: Unit) => boolean): Unit | null {
    const standing = new Map<number, number>();
    const last = new Map<number, Unit>();
    for (const unit of this.units) {
      if (unit.priority !== priority || unit.group === null) continue;
      if (unit.level < unit.variants.length - 1) standing.set(unit.group, (standing.get(unit.group) ?? 0) + 1);
      if (movable(unit)) last.set(unit.group, unit);
    }
    let best: { group: number; count: number } | null = null;
    for (const group of last.keys()) {
      const count = standing.get(group) ?? 0;
      if (!best || count > best.count || (count === best.count && group > best.group)) best = { group, count };
    }
    return best ? last.get(best.group)! : null;
  }

  fit(maxBytes: number): Omit<LlmsDocument, "maxBytes" | "offProduction"> {
    let shortened = 0;
    let omitted = 0;
    let size = this.size();
    const priorities = [...new Set(this.units.map((unit) => unit.priority).filter((p) => Number.isFinite(p)))].sort((a, b) => a - b);
    // Pass 1: shorten (richest → next variant), never to "" here. Pass 2: drop.
    for (const pass of ["shorten", "drop"] as const) {
      const movable = pass === "shorten" ? (unit: Unit) => unit.level < unit.variants.length - 2 : (unit: Unit) => unit.level < unit.variants.length - 1;
      for (const priority of priorities) {
        while (size > maxBytes) {
          const unit = this.next(priority, movable);
          if (!unit) break;
          const before = utf8Bytes(unit.variants[unit.level]!);
          let noteDelta = 0;
          if (pass === "drop") {
            const g = this.groups[unit.group!]!;
            const oldNote = g.omitted > 0 ? utf8Bytes(g.note(g.omitted)) : 0;
            g.omitted += 1;
            noteDelta = utf8Bytes(g.note(g.omitted)) - oldNote;
            omitted += 1;
            unit.level = unit.variants.length - 1;
          } else {
            shortened += 1;
            unit.level += 1;
          }
          size += utf8Bytes(unit.variants[unit.level]!) - before + noteDelta;
        }
      }
    }
    let text = this.render();
    let cut = false;
    if (utf8Bytes(text) > maxBytes) {
      const marker = "\n[truncated]\n";
      const lines = text.split("\n");
      while (lines.length > 0 && utf8Bytes(lines.join("\n")) + utf8Bytes(marker) > maxBytes) lines.pop();
      text = lines.length > 0 ? `${lines.join("\n").replace(/\n+$/, "")}${marker}` : "";
      cut = true;
    }
    return { text, bytes: utf8Bytes(text), trimmed: shortened > 0 || omitted > 0 || cut, shortened, omitted, cut };
  }
}

/** What goes first under a budget. In the index, FAQ links go before page links (the answers are in the full file); in the full file, page text goes before answers. */
const PRIORITY = { optional: 0, faq: 1, item: 2 } as const;
const FULL_PRIORITY = { optional: 0, item: 1, faq: 2 } as const;

/** llms.txt: the index. A title, the summary, then link lists. */
export function llmsTxt(site: Site, registry: LlmsRegistry, options: LlmsOptions = {}): LlmsDocument {
  validate(site, registry);
  const maxBytes = options.maxBytes ?? LLMS_TXT_MAX_BYTES;
  if (!site.indexable) return emptyDocument(maxBytes);
  const fullUrl = options.fullPath === false ? null : linkUrl(site, options.fullPath ?? "/llms-full.txt");
  const sitemapUrl = linkUrl(site, options.sitemapPath ?? "/sitemap.xml");
  const target = (path: string | undefined): string | null => (path ? linkUrl(site, path) : fullUrl);
  const doc = new Doc();
  doc.fixed(`# ${oneLine(registry.title ?? site.name)}\n\n> ${oneLine(registry.summary)}\n\n`);
  doc.fixed(`${fullUrl ? linkLine("Full text", fullUrl) : ""}${linkLine("Sitemap", sitemapUrl)}`);

  const more = (where: string) => (n: number) => `- […and ${n} more](${where})\n`;
  const sections = registry.sections ?? [];
  const listed = (section: LlmsSection) => (section.items?.length ?? 0) > 0 || (Boolean(section.text?.trim()) && fullUrl !== null);
  const sectionLines = (doc: Doc, section: LlmsSection, group: number, priority: number) => {
    const items = section.items ?? [];
    if (items.length === 0) doc.item(group, [linkLine(section.title, fullUrl)], priority);
    for (const item of items) doc.item(group, [linkLine(item.title, target(item.path), item.summary)], priority);
  };
  const whereMore = (section: LlmsSection) => ((section.items ?? []).every((item) => item.path) ? sitemapUrl : (fullUrl ?? sitemapUrl));

  for (const section of sections.filter((s) => !s.optional && listed(s))) {
    doc.fixed(`\n## ${oneLine(section.title)}\n\n`);
    sectionLines(doc, section, doc.group(more(whereMore(section))), PRIORITY.item);
  }

  const how = registry.howItWorks;
  if (how && how.steps.length > 0) {
    const title = oneLine(how.title ?? "How it works");
    const steps = how.steps.map((step, i) => `${i + 1}. ${oneLine(step.name)}`).join("; ");
    doc.fixed(`\n## ${title}\n\n${linkLine(title, target(how.path), steps)}`);
  }

  const pricing = registry.pricing;
  if (pricing && pricing.plans.length > 0) {
    const title = oneLine(pricing.title ?? "Pricing");
    const where = target(pricing.path);
    const lines = pricing.plans.map((plan) => linkLine(plan.name, where, `${formatPrice(plan, pricing.currency)}${plan.description ? `. ${oneLine(plan.description)}` : ""}`));
    doc.fixed(`\n## ${title}\n\n${lines.join("")}`);
  }

  const faqs = registry.faqs;
  if (faqs && faqs.items.length > 0) {
    const title = oneLine(faqs.title ?? "FAQ");
    const where = target(faqs.path);
    const own = faqs.items.filter((item) => item.path);
    const rest = faqs.items.filter((item) => !item.path);
    doc.fixed(`\n## ${title}\n\n`);
    const group = doc.group(more(where ?? sitemapUrl));
    for (const item of own) doc.item(group, [linkLine(item.question, linkUrl(site, item.path!))], PRIORITY.faq);
    if (rest.length > 0) {
      // One link for every answer that has no anchor of its own, not N identical links.
      if (where) doc.item(group, [linkLine(title, where, `${rest.length} ${rest.length === 1 ? "question" : "questions"}`)], PRIORITY.faq);
      else for (const item of rest) doc.item(group, [linkLine(item.question, null)], PRIORITY.faq);
    }
  }

  const contact = contactLines(site, registry.contact);
  if (contact) doc.fixed(`\n## Contact\n\n${contact}`);

  const optional = sections.filter((s) => s.optional && listed(s));
  if (optional.length > 0) {
    doc.fixed("\n## Optional\n\n");
    const group = doc.group(more(optional.every((s) => (s.items ?? []).every((item) => item.path) && (s.items?.length ?? 0) > 0) ? sitemapUrl : (fullUrl ?? sitemapUrl)));
    for (const section of optional) sectionLines(doc, section, group, PRIORITY.optional);
  }

  return { ...doc.fit(maxBytes), maxBytes, offProduction: false };
}

function contactLines(site: Site, contact: LlmsRegistry["contact"]): string {
  if (!contact) return "";
  return [
    contact.email ? linkLine("Email", `mailto:${oneLine(contact.email)}`) : "",
    contact.path ? linkLine("Contact", linkUrl(site, contact.path)) : "",
    ...(contact.links ?? []).map((entry) => linkLine(entry.title, linkUrl(site, entry.path))),
  ].join("");
}

/** llms-full.txt: the text itself, every page's body, the pricing, the steps and the answers. */
export function llmsFullTxt(site: Site, registry: LlmsRegistry, options: LlmsOptions = {}): LlmsDocument {
  validate(site, registry);
  const maxBytes = options.maxBytes ?? LLMS_FULL_MAX_BYTES;
  if (!site.indexable) return emptyDocument(maxBytes);
  const indexUrl = linkUrl(site, options.indexPath ?? "/llms.txt");
  const sitemapUrl = linkUrl(site, options.sitemapPath ?? "/sitemap.xml");
  const doc = new Doc();
  doc.fixed(`# ${oneLine(registry.title ?? site.name)}\n\n> ${oneLine(registry.summary)}\n\n`);
  if (registry.about) doc.fixed(`${block(registry.about)}\n\n`);
  doc.fixed(`${linkLine("Site", linkUrl(site, "/"))}${linkLine("Index", indexUrl)}${linkLine("Sitemap", sitemapUrl)}`);

  const how = registry.howItWorks;
  if (how && how.steps.length > 0) {
    const title = oneLine(how.title ?? "How it works");
    const steps = how.steps.map((step, i) => `${i + 1}. **${oneLine(step.name)}**: ${block(step.text)}`).join("\n");
    doc.fixed(`\n## ${title}\n\n${how.path ? `Source: ${linkUrl(site, how.path)}\n\n` : ""}${steps}\n`);
  }

  const pricing = registry.pricing;
  if (pricing && pricing.plans.length > 0) {
    const title = oneLine(pricing.title ?? "Pricing");
    const plans = pricing.plans.map((plan) => {
      const head = `### ${oneLine(plan.name)}: ${formatPrice(plan, pricing.currency)}\n`;
      const description = plan.description ? `\n${block(plan.description)}\n` : "";
      const features = plan.features && plan.features.length > 0 ? `\n${plan.features.map((f) => `- ${oneLine(f)}`).join("\n")}\n` : "";
      return `${head}${description}${features}`;
    });
    doc.fixed(
      `\n## ${title}\n\n${pricing.path ? `Source: ${linkUrl(site, pricing.path)}\n\n` : ""}${plans.join("\n")}${pricing.note ? `\n${block(pricing.note)}\n` : ""}`,
    );
  }

  const more = (where: string) => (n: number) => `\n…and ${n} more: ${where}\n`;
  const sections = registry.sections ?? [];
  const ordered = [...sections.filter((s) => !s.optional), ...sections.filter((s) => s.optional)];
  for (const section of ordered) {
    const items = section.items ?? [];
    if (items.length === 0 && !section.text?.trim()) continue;
    doc.fixed(`\n## ${oneLine(section.title)}\n${section.text?.trim() ? `\n${block(section.text)}\n` : ""}`);
    if (items.length === 0) continue;
    const group = doc.group(more(sitemapUrl));
    for (const item of items) {
      const head = item.path ? `\n### [${linkText(item.title)}](${linkUrl(site, item.path)})\n\n` : `\n### ${oneLine(item.title)}\n\n`;
      const summary = `${head}${block(item.summary)}\n`;
      const variants = item.body && block(item.body) !== block(item.summary) ? [`${head}${block(item.body)}\n`, summary] : [summary];
      doc.item(group, variants, section.optional ? FULL_PRIORITY.optional : FULL_PRIORITY.item);
    }
  }

  const faqs = registry.faqs;
  if (faqs && faqs.items.length > 0) {
    const title = oneLine(faqs.title ?? "FAQ");
    doc.fixed(`\n## ${title}\n${faqs.path ? `\nSource: ${linkUrl(site, faqs.path)}\n` : ""}`);
    const group = doc.group(more(faqs.path ? linkUrl(site, faqs.path) : linkUrl(site, "/")));
    for (const item of faqs.items) doc.item(group, [`\n### ${oneLine(item.question)}\n\n${block(item.answer)}\n`], FULL_PRIORITY.faq);
  }

  const contact = contactLines(site, registry.contact);
  if (contact) doc.fixed(`\n## Contact\n\n${contact}`);

  return { ...doc.fit(maxBytes), maxBytes, offProduction: false };
}

/**
 * A plain-text Response for an llms route. Browser caching only, no
 * `s-maxage`: a CDN-cached copy would hide the crawler fetches a crawler log
 * exists to count (Riddler Go's D4 lesson). `X-Robots-Tag: noindex` keeps the
 * file itself out of search results, where it would compete with the pages it
 * describes; answer engines read it all the same (`noindex: false` to drop
 * the header). A document built off production is a 404.
 */
export function llmsResponse(doc: LlmsDocument | string, options: { cacheSeconds?: number; noindex?: boolean } = {}): Response {
  if (typeof doc !== "string" && doc.offProduction) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" },
    });
  }
  return new Response(typeof doc === "string" ? doc : doc.text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": `public, max-age=${options.cacheSeconds ?? 300}`,
      ...(options.noindex === false ? {} : { "X-Robots-Tag": "noindex" }),
    },
  });
}
