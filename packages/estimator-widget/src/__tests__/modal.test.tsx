// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { EstimatorPublicTransport } from "../client.js";
import { EstimatorButton, EstimatorModal, EstimatorProvider, useEstimator } from "../widget.js";
import { button, CONFIG, fakePublic, key, mount, ok, RAMP, settle, text } from "./fakes.js";

/**
 * 0.1's button + modal, now a real dialog (contract 9.5, ES-14): labelled,
 * Escape and a click on the backdrop close it, Tab stays inside it, focus goes
 * back to the button, and the page doesn't scroll behind it.
 */

afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

function App({ transport }: { transport: EstimatorPublicTransport }) {
  return (
    <EstimatorProvider config={{ baseUrl: "https://summitramps.test/api/estimator", clientKey: "esk_test", title: "Price your ramp" }} transport={transport}>
      <p>The business's page.</p>
      <EstimatorButton />
      <EstimatorModal />
    </EstimatorProvider>
  );
}

const transport = () => fakePublic({ config: () => ok({ ...CONFIG, products: [RAMP] }) }).transport;

async function open(container: HTMLElement) {
  const fab = container.querySelector<HTMLButtonElement>(".aiew-fab")!;
  fab.focus();
  await act(async () => fab.click());
  await settle();
  return fab;
}

describe("<EstimatorModal>", () => {
  it("is a labelled modal dialog with the estimate inside; the page stops scrolling behind it", async () => {
    const { container, unmount } = await mount(<App transport={transport()} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const fab = await open(container);
    expect(fab.getAttribute("aria-haspopup")).toBe("dialog");
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelId = dialog.getAttribute("aria-labelledby")!;
    expect(text(document.getElementById(labelId))).toBe("Price your ramp");
    expect(text(dialog)).toContain("How many steps go up to the door?");
    expect(document.body.style.overflow).toBe("hidden");
    // Focus moved inside the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);
    await unmount();
  });

  it("Escape closes it and focus goes back to the button", async () => {
    const { container, unmount } = await mount(<App transport={transport()} />);
    const fab = await open(container);
    await key(document.activeElement, "Escape");
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(fab);
    expect(document.body.style.overflow).toBe("");
    await unmount();
  });

  it("a click on the backdrop closes it; a click inside doesn't", async () => {
    const { container, unmount } = await mount(<App transport={transport()} />);
    await open(container);
    const dialog = container.querySelector('[role="dialog"]')!;
    await act(async () => {
      dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const backdrop = container.querySelector("[data-aiew-backdrop]")!;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await unmount();
  });

  it("Tab and Shift+Tab stay inside the dialog", async () => {
    const { container, unmount } = await mount(<App transport={transport()} />);
    await open(container);
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]):not([tabindex='-1'])")].filter(
      (el) => !el.closest(".aiew-hp") && !el.closest("[hidden]"),
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    last.focus();
    await key(last, "Tab");
    expect(document.activeElement).toBe(first);
    first.focus();
    await key(first, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);
    await unmount();
  });

  it("the close button closes it, under StrictMode too, leaving the page scrollable", async () => {
    const { container, unmount } = await mount(
      <StrictMode>
        <App transport={transport()} />
      </StrictMode>,
    );
    await open(container);
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => button(container, "Close")!.click());
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe("");
    await unmount();
  });

  it("useEstimator() still hands out 0.1's transport and the open state", async () => {
    let seen: ReturnType<typeof useEstimator> | null = null;
    function Probe() {
      seen = useEstimator();
      return null;
    }
    const { unmount } = await mount(
      <EstimatorProvider config={{ baseUrl: "/api/estimator", clientKey: "esk_test" }}>
        <Probe />
      </EstimatorProvider>,
    );
    expect(seen!.open).toBe(false);
    expect(typeof seen!.transport.config).toBe("function");
    expect(typeof seen!.transport.calculate).toBe("function");
    expect(seen!.config.clientKey).toBe("esk_test");
    await unmount();
  });

  it("useEstimator() outside a provider says so", async () => {
    function Bad() {
      useEstimator();
      return null;
    }
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    await expect(mount(<Bad />)).rejects.toThrow(/inside <EstimatorProvider>/);
    console.error = original;
  });
});
