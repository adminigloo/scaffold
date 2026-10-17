import { Fragment, type ReactNode } from "react";

/**
 * The assistant's answers, rendered — SAFELY. Models write a little Markdown
 * (a list, some bold, a link), and showing the asterisks reads as broken. So
 * the small subset people actually see is turned into React elements:
 *
 *   paragraphs and line breaks, `### headings`, `- bullets`, `1. numbers`,
 *   **bold**, *italic*, `code`, ``` fenced code ```, [links](https://…)
 *
 * NO HTML, EVER. Nothing here touches innerHTML: every piece of text becomes a
 * React text node, so `<script>` in an answer is shown as the characters
 * `<script>`. A link is kept only when it goes to http(s), mailto:, tel: or a
 * path on this site ("/app/…"); anything else (javascript:, data:) is shown as
 * plain text. Links to other sites open in a new tab without a referrer.
 */

const SAFE_URL = /^(https?:\/\/|mailto:|tel:|\/(?!\/))/i;

/** A link target the widget will follow, or null. */
export function safeLink(url: string): string | null {
  const trimmed = url.trim();
  if (!SAFE_URL.test(trimmed)) return null;
  // No whitespace or control characters smuggled into a scheme.
  if (/[\s\u0000-\u001f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Which links become links. "all" (the model's answers): http(s), mail,
 * phone and this site. "site" (the business's own saved answers, served word
 * for word to everyone who asks): only paths on this site — anything else is
 * shown as plain text, so a saved answer can't send people to another site.
 */
export type LinkPolicy = "all" | "site";

let policy: LinkPolicy = "all";

function allowed(href: string): boolean {
  return policy === "all" || href.startsWith("/");
}

/** One pass of the inline rules over `text`. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // code | bold | italic (* or _) | [label](url) | bare https URL
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let n = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const k = `${key}-${n++}`;
    const [whole, code, bold, italic, link, bare] = match;
    if (code) {
      out.push(<code key={k}>{code.slice(1, -1)}</code>);
    } else if (bold) {
      out.push(<strong key={k}>{inline(bold.slice(2, -2), k)}</strong>);
    } else if (italic) {
      out.push(<em key={k}>{inline(italic.slice(1, -1), k)}</em>);
    } else if (link) {
      const close = link.indexOf("](");
      const label = link.slice(1, close);
      const href = safeLink(link.slice(close + 2, -1));
      out.push(href && allowed(href) ? anchor(href, inline(label, k), k) : <Fragment key={k}>{whole}</Fragment>);
    } else if (bare) {
      const href = safeLink(bare);
      out.push(href && allowed(href) ? anchor(href, bare, k) : <Fragment key={k}>{bare}</Fragment>);
    }
    last = match.index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function anchor(href: string, children: ReactNode, key: string): ReactNode {
  const external = /^https?:\/\//i.test(href);
  return (
    <a key={key} href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  );
}

function lines(paragraph: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  paragraph.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${key}-br${i}`} />);
    out.push(...inline(line, `${key}-l${i}`));
  });
  return out;
}

/** Markdown text → React elements (see the module comment for what is kept). */
export function renderMarkdown(text: string, options: { links?: LinkPolicy } = {}): ReactNode {
  const previous = policy;
  policy = options.links ?? "all";
  try {
    return renderBlocks(text);
  } finally {
    policy = previous;
  }
}

function renderBlocks(text: string): ReactNode {
  const source = text.replace(/\r\n?/g, "\n");
  const blocks: ReactNode[] = [];
  const rows = source.split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let b = 0;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push(<p key={`p${b++}`}>{lines(paragraph, `p${b}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const k = `list${b++}`;
    const items = list.items.map((item, i) => <li key={`${k}-${i}`}>{inline(item, `${k}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
    list = null;
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? "";
    if (/^\s*```/.test(row)) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      i += 1;
      while (i < rows.length && !/^\s*```/.test(rows[i] ?? "")) {
        code.push(rows[i] ?? "");
        i += 1;
      }
      blocks.push(
        <pre key={`pre${b++}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(row);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(<h3 key={`h${b++}`}>{inline(heading[1] ?? "", `h${b}`)}</h3>);
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(row);
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(row);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet?.[1] ?? numbered?.[1] ?? "").trim());
      continue;
    }
    if (row.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(row);
  }
  flushParagraph();
  flushList();
  return <>{blocks}</>;
}
