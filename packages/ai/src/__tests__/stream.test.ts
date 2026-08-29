import { describe, expect, it, vi } from "vitest";
import { meterStream } from "../stream.js";
import type { StreamUsage } from "../stream.js";

/** A source that yields `chunks` and then closes. */
function sourceOf(chunks: readonly string[]): ReadableStream<string> {
  let index = 0;
  return new ReadableStream<string>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) controller.close();
      else {
        index += 1;
        controller.enqueue(chunk);
      }
    },
  });
}

async function drain(stream: ReadableStream<string>): Promise<string[]> {
  const received: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) return received;
    received.push(result.value);
  }
}

describe("meterStream", () => {
  it("passes every chunk through untouched", async () => {
    const reports: StreamUsage[] = [];
    const metered = meterStream(sourceOf(["a", "b", "c"]), {
      onUsage: (usage) => void reports.push(usage),
    });
    expect(await drain(metered)).toEqual(["a", "b", "c"]);
  });

  it("reports completed with the number of chunks delivered", async () => {
    const reports: StreamUsage[] = [];
    const metered = meterStream(sourceOf(["a", "b", "c"]), {
      onUsage: (usage) => void reports.push(usage),
    });
    await drain(metered);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome).toBe("completed");
    expect(reports[0]?.chunks).toBe(3);
  });

  it("reports for a stream that produced nothing", async () => {
    // An empty response still consumed input tokens. No report here means the
    // prompt that produced a refusal is free according to the table.
    const reports: StreamUsage[] = [];
    await drain(
      meterStream(sourceOf([]), { onUsage: (usage) => void reports.push(usage) }),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "completed", chunks: 0 });
  });

  it("reports BEFORE the consumer observes the close", async () => {
    // On a serverless platform the instance can be frozen the instant the
    // response finishes. A report started after the close is a write racing a
    // process that is about to stop existing, and it loses under exactly the
    // load that makes the numbers matter.
    const reports: StreamUsage[] = [];
    const reader = meterStream(sourceOf(["a"]), {
      onUsage: async (usage) => {
        await Promise.resolve();
        reports.push(usage);
      },
    }).getReader();

    await reader.read();
    const end = await reader.read();

    expect(end.done).toBe(true);
    expect(reports).toHaveLength(1);
  });

  it("measures duration from the injected clock", async () => {
    const reports: StreamUsage[] = [];
    let clock = 1_000;
    const metered = meterStream(sourceOf(["a", "b"]), {
      onUsage: (usage) => void reports.push(usage),
      now: () => {
        clock += 250;
        return clock;
      },
    });
    await drain(metered);
    // Two ticks of the injected clock: one when the stream opened, one when it
    // settled. Nothing here reads the wall clock, so the assertion is exact.
    expect(reports[0]?.durationMs).toBe(250);
  });
});

describe("meterStream - cancellation", () => {
  it("reports the tokens spent by a user who closed the tab", async () => {
    // THE CASE PEOPLE FORGET. The provider generated and billed for everything
    // it streamed; the request simply never reached the code after the loop.
    // Recording only clean completions under-reports every abandoned request,
    // and abandonment spikes when the model is slow, which is when spend is
    // highest.
    const reports: StreamUsage[] = [];
    const metered = meterStream(sourceOf(["a", "b", "c", "d"]), {
      onUsage: (usage) => void reports.push(usage),
    });

    const reader = metered.getReader();
    await reader.read();
    await reader.cancel("client disconnected");

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "cancelled", chunks: 1 });
  });

  it("propagates the cancellation to the source, so the provider call stops", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
      },
      pull: () => new Promise<void>(() => {}),
      cancel,
    });

    const reader = meterStream(source, { onUsage: () => {} }).getReader();
    await reader.read();
    await reader.cancel("client disconnected");

    expect(cancel).toHaveBeenCalledWith("client disconnected");
  });

  it("still reports when the source's own cancel rejects", async () => {
    // The teardown failing does not un-spend the tokens. Settling first is what
    // makes the row survive a provider that hangs up badly.
    const reports: StreamUsage[] = [];
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
      },
      pull: () => new Promise<void>(() => {}),
      cancel: () => Promise.reject(new Error("provider hung up")),
    });

    const reader = meterStream(source, {
      onUsage: (usage) => void reports.push(usage),
    }).getReader();
    await reader.read();
    await expect(reader.cancel()).rejects.toThrow("provider hung up");

    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome).toBe("cancelled");
  });

  it("reports exactly once when a cancel races a read that is in flight", async () => {
    // Cancelling the source resolves the pending read as done, so the pull path
    // arrives at "completed" a tick after the cancel path reported. Two rows
    // for one request double-count spend, and a number that is sometimes
    // doubled is worse than one that is missing.
    const reports: StreamUsage[] = [];
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
      },
      pull: () => new Promise<void>(() => {}),
    });

    const reader = meterStream(source, {
      onUsage: (usage) => void reports.push(usage),
    }).getReader();
    await reader.read();
    await reader.cancel("client disconnected");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome).toBe("cancelled");
  });

  it("does not report a second time when a cancel arrives after completion", async () => {
    const reports: StreamUsage[] = [];
    const metered = meterStream(sourceOf(["a"]), {
      onUsage: (usage) => void reports.push(usage),
    });
    const reader = metered.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();

    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome).toBe("completed");
  });
});

describe("meterStream - failures", () => {
  it("reports errored, carries the cause, and still fails the consumer", async () => {
    const reports: StreamUsage[] = [];
    const boom = new Error("upstream 529");
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
      },
      pull(controller) {
        controller.error(boom);
      },
    });

    const metered = meterStream(source, {
      onUsage: (usage) => void reports.push(usage),
    });

    await expect(drain(metered)).rejects.toThrow("upstream 529");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "errored", chunks: 1 });
    expect(reports[0]?.error).toBe(boom);
  });

  it("attaches no error to the outcomes that had none", async () => {
    const reports: StreamUsage[] = [];
    await drain(
      meterStream(sourceOf(["a"]), { onUsage: (usage) => void reports.push(usage) }),
    );
    expect(reports[0]?.error).toBeUndefined();
  });

  it("survives a usage reporter that throws", async () => {
    // A metrics write that can reject the stream turns a slow insert into a
    // truncated answer. The user loses the response because we failed to write
    // down what it cost, which is the wrong thing to protect.
    const metered = meterStream(sourceOf(["a", "b"]), {
      onUsage: () => {
        throw new Error("usage table is full");
      },
    });
    expect(await drain(metered)).toEqual(["a", "b"]);
  });

  it("survives a usage reporter that rejects", async () => {
    const metered = meterStream(sourceOf(["a", "b"]), {
      onUsage: () => Promise.reject(new Error("pool exhausted")),
    });
    expect(await drain(metered)).toEqual(["a", "b"]);
  });

  it("survives a reporter that throws on the cancellation path too", async () => {
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
      },
      pull: () => new Promise<void>(() => {}),
    });
    const reader = meterStream(source, {
      onUsage: () => {
        throw new Error("usage table is full");
      },
    }).getReader();

    await reader.read();
    await expect(reader.cancel()).resolves.toBeUndefined();
  });
});
