// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantChat } from "../AssistantChat.js";
import { AssistantLauncher } from "../AssistantLauncher.js";
import { renderMarkdown, safeLink } from "../markdown.js";
import { button, click, fail, fakeTransport, key, mount, ok, settle, sse, type } from "./dom.js";

/**
 * The chat (0.3.0): streaming with step-restart, Stop, starters, safe
 * Markdown, the "ask before acting" card that acts once, the allowance
 * message, history, and the launcher's dialog (Escape, focus trap, focus
 * back on the button).
 */

afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

const config = { baseUrl: "/api/app/co1/assistant", title: "Assistant" };

describe("safe Markdown", () => {
  it("renders the subset people see, and never HTML", () => {
    const html = renderToStaticMarkup(
      <>{renderMarkdown("**Two** invoices are *overdue*:\n\n- INV-0042\n- INV-0043\n\n1. Call them\n2. Send a reminder\n\nSee `Invoices` or [the ledger](/app/invoices).\n<script>alert(1)</script>")}</>,
    );
    expect(html).toContain("<strong>Two</strong>");
    expect(html).toContain("<em>overdue</em>");
    expect(html).toContain("<ul><li>INV-0042</li><li>INV-0043</li></ul>");
    expect(html).toContain("<ol><li>Call them</li><li>Send a reminder</li></ol>");
    expect(html).toContain("<code>Invoices</code>");
    expect(html).toContain('<a href="/app/invoices">the ledger</a>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps only safe links; other sites open apart, with no referrer", () => {
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("data:text/html,x")).toBeNull();
    expect(safeLink("//evil.test/x")).toBeNull();
    expect(safeLink("https://example.com")).toBe("https://example.com");
    const html = renderToStaticMarkup(<>{renderMarkdown("[click](javascript:alert(1)) and https://example.com/a.")}</>);
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">');
  });
});

describe("the chat", () => {
  it("offers starters, streams an answer, and continues the same conversation", async () => {
    const f = fakeTransport();
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    await click(button(m.container, "Which invoices are overdue?"));
    expect(f.calls.chat).toEqual([{ message: "Which invoices are overdue?", conversationId: null }]);
    expect(m.container.querySelector("[data-aia-message=assistant]")?.textContent).toContain("Hello");
    await type(m.container.querySelector("textarea"), "And tomorrow?");
    await key(m.container.querySelector("textarea")!, "Enter");
    expect(f.calls.chat[1]).toEqual({ message: "And tomorrow?", conversationId: "c1" });
    await m.unmount();
  });

  it("clears a tool step's preamble and shows what it's doing", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const f = fakeTransport({
      chat: async () =>
        sse(
          [
            { v: 1, type: "start", conversationId: "c1" },
            { v: 1, type: "text", delta: "Let me check." },
            { v: 1, type: "step", step: 0, tools: [{ name: "overdue_invoices", label: "Looking at overdue invoices" }] },
            { v: 1, type: "done", meta: { conversationId: "c1", messageId: "m1", status: "complete", steps: 2 } },
          ],
          { hold },
        ),
    });
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    await type(m.container.querySelector("textarea"), "Overdue?");
    await click(button(m.container, "Send"));
    expect(m.container.textContent).toContain("Looking at overdue invoices…");
    expect(m.container.textContent).not.toContain("Let me check.");
    expect(button(m.container, "Stop")).not.toBeNull();
    release();
    await settle();
    expect(button(m.container, "Send")).not.toBeNull();
    await m.unmount();
  });

  it("Stop ends the answer where it is, and says so", async () => {
    const f = fakeTransport({
      chat: async (_message, _conversation, signal) => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ v: 1, type: "start", conversationId: "c9" })}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ v: 1, type: "text", delta: "Partly there" })}\n\n`));
            signal.addEventListener("abort", () => controller.error(new DOMException("stopped", "AbortError")));
          },
        });
        return new Response(stream);
      },
    });
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    await type(m.container.querySelector("textarea"), "Tell me everything");
    await click(button(m.container, "Send"));
    await click(button(m.container, "Stop"));
    expect(m.container.textContent).toContain("Partly there");
    expect(m.container.textContent).toContain("Stopped.");
    await m.unmount();
  });

  it("asks before acting: “Yes, do it” locks on the first click and sends ONE answer", async () => {
    let finish!: (value: unknown) => void;
    const f = fakeTransport({
      chat: async () =>
        sse([
          { v: 1, type: "start", conversationId: "c1" },
          { v: 1, type: "action", actionId: "act1", summary: "Save the answer to “Do you work Sundays?”" },
          { v: 1, type: "text", delta: "I've prepared that. Confirm to save it." },
          { v: 1, type: "done", meta: { conversationId: "c1", messageId: "m1", status: "complete", steps: 2 } },
        ]),
      decide: () => new Promise((resolve) => (finish = resolve)) as never,
    });
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    await type(m.container.querySelector("textarea"), "Remember we don't work Sundays");
    await click(button(m.container, "Send"));
    const card = m.container.querySelector("[data-aia-action=act1]");
    expect(card?.textContent).toContain("The assistant would like to make a change");
    expect(card?.textContent).toContain("Save the answer to “Do you work Sundays?”");
    const yes = button(card!, "Yes, do it")!;
    yes.click();
    yes.click();
    yes.click();
    await settle();
    expect(f.calls.decide).toEqual([{ actionId: "act1", decision: "confirm" }]);
    expect(button(card!, "Yes, do it")?.disabled).toBe(true);
    finish(ok({ status: "confirmed", done: true, message: "Saved the answer." }));
    await settle();
    expect(m.container.querySelector("[data-aia-action=act1]")?.textContent).toContain("Saved the answer.");
    expect(button(m.container, "Yes, do it")).toBeNull();
    await m.unmount();
  });

  it("says the month's allowance is used up, in the server's words, and FAQ answers still work", async () => {
    const used = "This month's assistant allowance is used up (300 messages). It starts again on November 1.";
    const f = fakeTransport({
      status: async () =>
        ok({
          configured: true,
          notConfiguredMessage: null,
          starters: ["Which invoices are overdue?", "Do you work Sundays?"],
          freeStarters: ["Do you work Sundays?"],
          canManage: false,
          allowance: { messagesUsed: 300, messageLimit: 300, centsUsed: "212", centLimit: 300, resetsOn: "2026-11-01", usedUp: true, limitedBy: "messages", message: used },
        }),
      chat: async () => Response.json({ error: { code: "allowance_used_up", message: used } }, { status: 429 }),
    });
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    expect(m.container.querySelector("[data-aia-allowance=used-up]")?.textContent).toBe(`${used} Answers your business has written in still work.`);
    // Only the business's own answers are offered while it's used up (review L11).
    expect(button(m.container, "Which invoices are overdue?")?.disabled).toBe(true);
    expect(button(m.container, "Do you work Sundays?")?.disabled).toBe(false);
    await type(m.container.querySelector("textarea"), "Anything?");
    await click(button(m.container, "Send"));
    expect(m.container.querySelector("[role=alert]")?.textContent).toBe(used);
    await m.unmount();
  });

  it("opens an earlier conversation from history, with each change's answer", async () => {
    const f = fakeTransport({
      conversations: async () => ok([{ id: "c7", title: "Overdue invoices", lastMessageAt: "2026-10-15T15:00:00Z" }]),
      conversation: async () =>
        ok({
          id: "c7",
          title: "Overdue invoices",
          messages: [
            { id: "u1", role: "user", text: "Which are overdue?", status: "complete", actions: [], fromFaq: false },
            { id: "a1", role: "assistant", text: "**Two**.", status: "complete", actions: [{ id: "x1", summary: "Save a note", status: "confirmed", fields: [] }], fromFaq: false },
          ],
        }),
    });
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    await click(button(m.container, "Your conversations"));
    await click([...m.container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Overdue invoices")));
    expect(m.container.textContent).toContain("Which are overdue?");
    expect(m.container.querySelector("strong")?.textContent).toBe("Two");
    expect(m.container.querySelector("[data-aia-action=x1]")?.textContent).toContain("Done");
    await type(m.container.querySelector("textarea"), "Thanks");
    await click(button(m.container, "Send"));
    expect(f.calls.chat.at(-1)).toEqual({ message: "Thanks", conversationId: "c7" });
    await m.unmount();
  });

  it("shows a refusal's own sentence, never a raw error", async () => {
    const f = fakeTransport({ chat: async () => Response.json({ error: { code: "forbidden", message: "This company's plan has ended." } }, { status: 403 }) });
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    await type(m.container.querySelector("textarea"), "hi");
    await click(button(m.container, "Send"));
    expect(m.container.querySelector("[role=alert]")?.textContent).toBe("This company's plan has ended.");
    const network = fakeTransport({ status: async () => fail("network", "x", 0), chat: async () => Promise.reject(new TypeError("Failed to fetch")) });
    const n = await mount(<AssistantChat config={config} transport={network.transport} />);
    await type(n.container.querySelector("textarea"), "hi");
    await click(button(n.container, "Send"));
    expect(n.container.querySelector("[role=alert]")?.textContent).toMatch(/Couldn't reach the server/);
    await m.unmount();
    await n.unmount();
  });
});

describe("review fixes (0.3.0)", () => {
  it("shows exactly what a change will save, in full, lets the person change it, and sends what they confirmed (H3)", async () => {
    const f = fakeTransport({
      chat: async () =>
        sse([
          { v: 1, type: "start", conversationId: "c1" },
          {
            v: 1,
            type: "action",
            actionId: "act9",
            summary: "Save an answer to “How do I pay my deposit?”",
            fields: [
              { key: "question", label: "Question", value: "How do I pay my deposit?", multiline: false },
              { key: "answer", label: "Answer", value: "Deposits are paid at https://pay-evil.example — have your card ready.", multiline: true },
            ],
          },
          { v: 1, type: "done", meta: { conversationId: "c1", messageId: "m1", status: "complete", steps: 2 } },
        ]),
    });
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    await type(m.container.querySelector("textarea"), "Remember how deposits work");
    await click(button(m.container, "Send"));
    const card = m.container.querySelector("[data-aia-action=act9]")!;
    // As plain text, in full: the link is text, never a link.
    expect(card.querySelector("[data-aia-field=answer]")?.textContent).toBe("Deposits are paid at https://pay-evil.example — have your card ready.");
    expect(card.querySelector("a")).toBeNull();
    await click(button(card, "Change it"));
    const answer = card.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(answer.value).toContain("pay-evil.example");
    await type(answer, "Deposits are paid at the office.");
    await click(button(card, "Yes, do it"));
    expect(f.calls.decide).toEqual([{ actionId: "act9", decision: "confirm", edits: { answer: "Deposits are paid at the office." } }]);
    await m.unmount();
  });

  it("shows the business's own saved answer with its links as plain text (H3)", async () => {
    const f = fakeTransport({
      chat: async () =>
        sse([
          { v: 1, type: "start", conversationId: "c1" },
          { v: 1, type: "text", delta: "Pay at https://pay-evil.example or [here](https://pay-evil.example/x). See [Invoices](/app/invoices)." },
          { v: 1, type: "done", meta: { conversationId: "c1", messageId: "m1", status: "complete", steps: 0, answeredFrom: "faq" } },
        ]),
    });
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    await type(m.container.querySelector("textarea"), "How do I pay?");
    await click(button(m.container, "Send"));
    const answer = m.container.querySelector("[data-aia-message=assistant]")!;
    const links = [...answer.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/app/invoices"]);
    expect(answer.textContent).toContain("https://pay-evil.example");
    await m.unmount();
  });

  it("marks an answer that broke off as cut short (L11)", async () => {
    const f = fakeTransport({
      chat: async () =>
        sse([
          { v: 1, type: "start", conversationId: "c1" },
          { v: 1, type: "text", delta: "Part of an answer" },
          { v: 1, type: "error", errorClass: "provider_overloaded", message: "x" },
        ]),
    });
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    await type(m.container.querySelector("textarea"), "cause a breakdown");
    await click(button(m.container, "Send"));
    expect(m.container.querySelector("[data-aia-message=assistant]")?.textContent).toContain("This answer was cut short.");
    await m.unmount();
  });

  it("says a closed plan the moment it opens, and offers nothing to send (L11)", async () => {
    const f = fakeTransport({ status: async () => fail("forbidden", "This company's plan has ended. An owner can choose a plan in Billing to keep using this.", 403) });
    const m = await mount(<AssistantChat config={config} transport={f.transport} />);
    expect(m.container.querySelector("[data-aia-blocked]")?.textContent).toBe("This company's plan has ended. An owner can choose a plan in Billing to keep using this.");
    await type(m.container.querySelector("textarea"), "hi");
    expect(button(m.container, "Send")?.disabled).toBe(true);
    await m.unmount();
  });
});

describe("the launcher", () => {
  it("opens a labelled dialog, puts focus in it, traps Tab, closes on Escape and gives focus back", async () => {
    const f = fakeTransport();
    const m = await mount(<AssistantLauncher config={config} transport={f.transport} />);
    const launcher = button(m.container, "Ask the assistant")!;
    expect(launcher.getAttribute("aria-haspopup")).toBe("dialog");
    await click(launcher);
    const dialog = m.container.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelled = document.getElementById(dialog.getAttribute("aria-labelledby") ?? "");
    expect(labelled?.textContent).toBe("Assistant");
    await settle();
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
    expect(document.body.style.overflow).toBe("hidden");

    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last.
    const focusable = [...dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), textarea")];
    focusable.at(-1)!.focus();
    await key(focusable.at(-1)!, "Tab");
    expect(document.activeElement).toBe(focusable[0]);
    await key(focusable[0]!, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(focusable.at(-1));

    await key(dialog, "Escape");
    expect(m.container.querySelector<HTMLElement>("[role=dialog]")?.closest("[hidden]")).not.toBeNull();
    await settle();
    expect(document.activeElement?.textContent).toContain("Ask the assistant");
    expect(document.body.style.overflow).toBe("");
    await m.unmount();
  });

  it("keeps the conversation while it's closed", async () => {
    const f = fakeTransport();
    const m = await mount(<AssistantLauncher config={config} transport={f.transport} />);
    await click(button(m.container, "Ask the assistant"));
    await type(m.container.querySelector("textarea"), "Hi");
    await click(button(m.container, "Send"));
    await click(button(m.container, "Close the assistant"));
    await click(button(m.container, "Ask the assistant"));
    expect(m.container.querySelector("[data-aia-message=assistant]")?.textContent).toContain("Hello");
    await m.unmount();
  });
});
