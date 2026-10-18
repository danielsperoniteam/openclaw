import { describe, expect, it, vi } from "vitest";
import { createHarness, sentEvents } from "./realtime-quicksilver-bridge.test-support.js";

describe("GPT-Live bridge delegation admission", () => {
  it("claims subscription tasks and controls before callbacks without consuming fresh context", async () => {
    const classify = vi.fn(() => "consult" as const);
    const harness = createHarness({ model: "gpt-live-1-codex", handleDelegationInput: classify });
    const delegate = (id: string) =>
      harness.socket.serverEvent({
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id,
          content: [{ type: "input_text", text: "Run the same action." }],
        },
      });
    await harness.bridge.connect();
    try {
      harness.onToolCall.mockImplementationOnce(() => delegate("first"));
      delegate("first");
      expect(harness.onToolCall).toHaveBeenCalledOnce();
      harness.bridge.submitToolResult("first", "Done.");
      harness.socket.serverEvent({
        type: "turn.done",
        turn: { role: "user", transcript: "Fresh context." },
      });
      delegate("first");
      expect(classify).toHaveBeenCalledOnce();
      delegate("second");
      expect(harness.onToolCall).toHaveBeenCalledTimes(2);
      expect(harness.onTranscript).toHaveBeenCalledWith("user", "Fresh context.", true);
      harness.bridge.submitToolResult("second", "Done.");
      expect(harness.onError).not.toHaveBeenCalled();
    } finally {
      await harness.bridge.close();
    }
    delegate("third");
    expect(harness.onToolCall).toHaveBeenCalledTimes(2);

    // Provider IDs belong to a connection, never a process-global replay cache.
    const fresh = createHarness({ model: "gpt-live-1-codex" });
    await fresh.bridge.connect();
    try {
      fresh.socket.serverEvent({
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "first",
          content: [{ type: "input_text", text: "Run the same action." }],
        },
      });
      expect(fresh.onToolCall).toHaveBeenCalledOnce();
    } finally {
      await fresh.bridge.close();
    }
  });

  it("does not reclassify a completed native control notice against later work", async () => {
    const classify = vi.fn(() => "control" as const);
    const harness = createHarness({ model: "gpt-live-1-codex", handleDelegationInput: classify });
    await harness.bridge.connect();
    const event = {
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "cancel-one",
        content: [{ type: "input_text", text: "Cancel it." }],
      },
    };
    try {
      harness.socket.serverEvent(event);
      harness.socket.serverEvent(event);
      expect(classify).toHaveBeenCalledOnce();
      expect(harness.onToolCall).not.toHaveBeenCalled();
    } finally {
      await harness.bridge.close();
    }
  });

  it("waits for public transcript input and ignores duplicate notices after tool completion", async () => {
    const harness = createHarness({ model: "gpt-live-1" });
    await harness.bridge.connect();
    const delegate = (id: string) =>
      harness.socket.serverEvent({
        type: "session.delegation.created",
        offset_ms: 100,
        delegation: { type: "delegation", target: "client", id },
      });
    const transcript = (delta: string) =>
      harness.socket.serverEvent({
        type: "session.input_transcript.delta",
        delta,
        start_ms: 0,
        end_ms: 100,
      });
    delegate("early");
    delegate("early");
    expect(
      sentEvents(harness.socket).filter((event) => event.type === "session.commentary.append"),
    ).toEqual([]);
    transcript("Find a train.");
    expect(harness.onToolCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        callId: "early",
        args: { question: expect.stringContaining("Find a train.") },
      }),
    );
    harness.bridge.submitToolResult("early", "Done.");
    transcript("Check a flight.");
    delegate("early");
    expect(harness.onToolCall).toHaveBeenCalledOnce();
    delegate("next");
    expect(harness.onToolCall).toHaveBeenCalledTimes(2);
    expect(harness.onToolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        callId: "next",
        args: { question: expect.stringContaining("Check a flight.") },
      }),
    );
    const closing = harness.bridge.close();
    harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
    await closing;
  });

  it.each(["session.delegation.created", "realtime.delegation.waiting-input"])(
    "rechecks delayed delegation authority after a %s observer closes the call",
    async (eventType) => {
      const harness = createHarness({ model: "gpt-live-1" });
      await harness.bridge.connect();
      harness.onEvent.mockImplementation((event) => {
        if (event.type === eventType) {
          void harness.bridge.close();
        }
      });
      harness.socket.serverEvent({
        type: "session.delegation.created",
        offset_ms: 0,
        delegation: { type: "delegation", target: "client", id: "pending" },
      });
      harness.socket.serverEvent({
        type: "session.input_transcript.delta",
        delta: "Check a flight.",
        start_ms: 0,
        end_ms: 100,
      });
      expect(harness.onToolCall).not.toHaveBeenCalled();
      harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
      await harness.bridge.close();
    },
  );

  it.each(["local-close", "remote-close", "error"] as const)(
    "revokes delayed public delegation on %s before late captions or timeout",
    async (boundary) => {
      const harness = createHarness({ model: "gpt-live-1" });
      await harness.bridge.connect();
      vi.useFakeTimers();
      try {
        harness.socket.serverEvent({
          type: "session.delegation.created",
          offset_ms: 0,
          delegation: { type: "delegation", target: "client", id: "pending" },
        });
        const closing = boundary === "local-close" ? harness.bridge.close() : undefined;
        if (boundary === "remote-close") {
          harness.socket.serverEvent({ type: "session.closed", reason: "remote_hangup" });
        }
        if (boundary === "error") {
          harness.socket.emit("error", new Error("disconnected"));
        }
        harness.socket.serverEvent({
          type: "session.input_transcript.delta",
          delta: "Late request.",
          start_ms: 0,
          end_ms: 100,
        });
        if (boundary === "local-close") {
          harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
        }
        await closing;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.onToolCall).not.toHaveBeenCalled();
        expect(
          sentEvents(harness.socket).filter((event) => event.type === "session.commentary.append"),
        ).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["gpt-live-1", "gpt-live-1-codex"])(
    "dispatches identical follow-ups with fresh delegation IDs on %s",
    async (model) => {
      const harness = createHarness({ model });
      await harness.bridge.connect();
      const publicApi = model === "gpt-live-1";
      for (const id of ["first", "followup", "repeat-again"]) {
        harness.socket.serverEvent(
          publicApi
            ? {
                type: "session.input_transcript.delta",
                delta: "Check my status.",
                start_ms: 0,
                end_ms: 100,
              }
            : { type: "turn.done", turn: { role: "user", transcript: "Check my status." } },
        );
        const notice = publicApi
          ? {
              type: "session.delegation.created",
              offset_ms: 100,
              delegation: { type: "delegation", target: "client", id },
            }
          : {
              type: "delegation.created",
              item: {
                type: "delegation",
                target: "client",
                id,
                content: [{ type: "input_text", text: "Check my status." }],
              },
            };
        harness.socket.serverEvent(notice);
        expect(harness.onToolCall).toHaveBeenLastCalledWith(
          expect.objectContaining({
            callId: id,
            args: { question: expect.stringContaining("Check my status.") },
          }),
        );
        harness.bridge.submitToolResult(id, "Status checked.");
        // Replay of a completed notice must not repeat its action.
        harness.socket.serverEvent(notice);
      }
      expect(harness.onToolCall).toHaveBeenCalledTimes(3);
      expect(harness.onError).not.toHaveBeenCalled();
      const closing = harness.bridge.close();
      if (publicApi) {
        harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
      }
      await closing;
    },
  );

  it("reports missing transcript timeout, requests repetition once, then accepts fresh work", async () => {
    const harness = createHarness({ model: "gpt-live-1" });
    await harness.bridge.connect();
    vi.useFakeTimers();
    try {
      const notice = (id: string) =>
        harness.socket.serverEvent({
          type: "session.delegation.created",
          offset_ms: 100,
          delegation: { type: "delegation", target: "client", id },
        });
      notice("missing");
      expect(harness.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "realtime.delegation.waiting-input",
          itemId: "missing",
        }),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(harness.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "realtime.delegation.input-timeout",
          itemId: "missing",
        }),
      );
      notice("missing");
      expect(
        sentEvents(harness.socket).filter((event) => event.type === "session.commentary.append"),
      ).toHaveLength(1);
      expect(harness.onToolCall).not.toHaveBeenCalled();
      notice("fresh");
      harness.socket.serverEvent({
        type: "session.input_transcript.delta",
        delta: "Try again.",
        start_ms: 200,
        end_ms: 300,
      });
      expect(harness.onToolCall).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ callId: "fresh" }),
      );
      expect(harness.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "realtime.delegation.dispatched",
          itemId: "fresh",
        }),
      );
      const closing = harness.bridge.close();
      harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports malformed and unknown provider events without forwarding their payloads", async () => {
    const harness = createHarness({ model: "gpt-live-1" });
    await harness.bridge.connect();
    harness.onEvent.mockClear();
    harness.socket.serverEvent({
      type: "session.input_transcript.delta",
      delta: "private transcript",
    });
    harness.socket.serverEvent({ type: "unrecognized-private-event", content: "private contents" });
    harness.socket.serverEvent({ type: "session.updated" });
    expect(harness.onEvent.mock.calls).toEqual([
      [{ direction: "server", type: "realtime.provider.event-ignored" }],
      [{ direction: "server", type: "realtime.provider.event-unknown" }],
    ]);
    const closing = harness.bridge.close();
    harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
    await closing;
  });
});
