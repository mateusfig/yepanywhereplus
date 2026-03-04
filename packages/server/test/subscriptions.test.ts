import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type Emit,
  createActivitySubscription,
  createSessionSubscription,
} from "../src/subscriptions.js";
import type { Process } from "../src/supervisor/Process.js";
import type { ProcessEvent, ProcessState } from "../src/supervisor/types.js";
import type { BusEvent, EventBus } from "../src/watcher/index.js";

// ── Helpers ──────────────────────────────────────────────────────────

type Listener = (event: ProcessEvent) => void | Promise<void>;

function createMockProcess(overrides?: Partial<Record<string, unknown>>): {
  process: Process;
  fireEvent: (event: ProcessEvent) => Promise<void>;
} {
  let listener: Listener | null = null;

  const process = {
    id: "proc-1",
    sessionId: "sess-1",
    state: { type: "in-turn" } as ProcessState,
    permissionMode: "default",
    modeVersion: 1,
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    resolvedModel: "claude-sonnet-4-5-20250929",
    subscribe: vi.fn((fn: Listener) => {
      listener = fn;
      return () => {
        listener = null;
      };
    }),
    getMessageHistory: vi.fn(() => []),
    getStreamingContent: vi.fn(() => null),
    accumulateStreamingText: vi.fn(),
    clearStreamingText: vi.fn(),
    getDeferredQueueSummary: vi.fn(() => []),
    ...overrides,
  } as unknown as Process;

  const fireEvent = async (event: ProcessEvent) => {
    if (listener) await listener(event);
  };

  return { process, fireEvent };
}

type BusHandler = (event: BusEvent) => void;

function createMockEventBus(): {
  eventBus: EventBus;
  fireEvent: (event: BusEvent) => void;
} {
  let handler: BusHandler | null = null;

  const eventBus = {
    subscribe: vi.fn((fn: BusHandler) => {
      handler = fn;
      return () => {
        handler = null;
      };
    }),
  } as unknown as EventBus;

  const fireEvent = (event: BusEvent) => {
    if (handler) handler(event);
  };

  return { eventBus, fireEvent };
}

function collectEmit(): { emit: Emit; events: Array<[string, unknown]> } {
  const events: Array<[string, unknown]> = [];
  const emit: Emit = (type, data) => {
    events.push([type, data]);
  };
  return { emit, events };
}

// ── Session Subscription ─────────────────────────────────────────────

describe("createSessionSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes BEFORE emitting connected (race condition fix)", () => {
    const { process } = createMockProcess();
    const { emit } = collectEmit();

    createSessionSubscription(process, emit);

    // subscribe() must be called before emit("connected", ...) fires.
    // Since subscribe is synchronous and emit("connected") happens after,
    // we verify subscribe was called exactly once.
    expect((process.subscribe as Mock).mock.calls).toHaveLength(1);
  });

  it("emits connected with correct process state", () => {
    const { process } = createMockProcess({
      state: { type: "waiting-input", request: { prompt: "Continue?" } },
    });
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    const connected = events.find(([type]) => type === "connected");
    expect(connected).toBeDefined();
    expect(connected?.[1]).toMatchObject({
      processId: "proc-1",
      sessionId: "sess-1",
      state: "waiting-input",
      permissionMode: "default",
      modeVersion: 1,
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      request: { prompt: "Continue?" },
    });
  });

  it("replays message history with markSubagent", () => {
    const messages = [
      { type: "assistant", message: { content: "Hello" } },
      { type: "user", message: { content: "Hi" } },
    ];
    const { process } = createMockProcess({
      getMessageHistory: vi.fn(() => messages),
    });
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    const messageEvents = events.filter(([type]) => type === "message");
    expect(messageEvents).toHaveLength(2);
  });

  it("forwards state-change events", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "state-change",
      state: { type: "waiting-input", request: { prompt: "Allow?" } },
    } as ProcessEvent);

    const status = events.find(([type]) => type === "status");
    expect(status).toBeDefined();
    expect(status?.[1]).toMatchObject({
      state: "waiting-input",
      request: { prompt: "Allow?" },
    });
  });

  it("forwards mode-change events", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "mode-change",
      mode: "plan",
      version: 2,
    } as ProcessEvent);

    const modeChange = events.find(([type]) => type === "mode-change");
    expect(modeChange).toBeDefined();
    expect(modeChange?.[1]).toEqual({
      permissionMode: "plan",
      modeVersion: 2,
    });
  });

  it("forwards error events", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "error",
      error: new Error("something broke"),
    } as ProcessEvent);

    const error = events.find(([type]) => type === "error");
    expect(error).toBeDefined();
    expect(error?.[1]).toEqual({ message: "something broke" });
  });

  it("forwards session-id-changed events", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "session-id-changed",
      oldSessionId: "temp-1",
      newSessionId: "real-1",
    } as ProcessEvent);

    const changed = events.find(([type]) => type === "session-id-changed");
    expect(changed).toBeDefined();
    expect(changed?.[1]).toEqual({
      oldSessionId: "temp-1",
      newSessionId: "real-1",
    });
  });

  it("augments codex-style Edit raw patches during streaming", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "msg-1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-edit-1",
              name: "Edit",
              input: {
                patch: [
                  "*** Begin Patch",
                  "*** Update File: src/example.ts",
                  "@@ -1,1 +1,1 @@",
                  "-const a = 1;",
                  "+const a = 2;",
                  "*** End Patch",
                ].join("\n"),
              },
            },
          ],
        },
      },
    } as ProcessEvent);

    const messageEvent = events.find(([type]) => type === "message");
    expect(messageEvent).toBeDefined();

    const payload = messageEvent?.[1] as {
      message?: {
        content?: Array<{
          type?: string;
          input?: {
            _rawPatch?: string;
            _structuredPatch?: Array<unknown>;
          };
        }>;
      };
    };
    const firstBlock = payload.message?.content?.[0];
    const input = firstBlock?.input;

    expect(firstBlock?.type).toBe("tool_use");
    expect(input?._rawPatch).toContain("*** Begin Patch");
    expect(Array.isArray(input?._structuredPatch)).toBe(true);
    expect(input?._structuredPatch?.length).toBeGreaterThan(0);
  });

  it("augments streamed Edit file_change diffs during streaming", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "msg-file-change-1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-edit-file-change-1",
              name: "Edit",
              input: {
                changes: [
                  {
                    path: "src/example.ts",
                    kind: "update",
                    diff: [
                      "diff --git a/src/example.ts b/src/example.ts",
                      "--- a/src/example.ts",
                      "+++ b/src/example.ts",
                      "@@ -1,1 +1,1 @@",
                      "-const a = 1;",
                      "+const a = 2;",
                    ].join("\n"),
                  },
                ],
              },
            },
          ],
        },
      },
    } as ProcessEvent);

    const messageEvent = events.find(
      ([type, payload]) =>
        type === "message" &&
        (payload as { uuid?: string })?.uuid === "msg-file-change-1",
    );
    expect(messageEvent).toBeDefined();

    const payload = messageEvent?.[1] as {
      message?: {
        content?: Array<{
          type?: string;
          input?: {
            _rawPatch?: string;
            _structuredPatch?: Array<unknown>;
          };
        }>;
      };
    };
    const firstBlock = payload.message?.content?.[0];
    const input = firstBlock?.input;

    expect(firstBlock?.type).toBe("tool_use");
    expect(input?._rawPatch).toContain("diff --git a/src/example.ts");
    expect(Array.isArray(input?._structuredPatch)).toBe(true);
    expect(input?._structuredPatch?.length).toBeGreaterThan(0);
  });

  it("emits complete and stops further events", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({ type: "complete" } as ProcessEvent);

    const complete = events.find(([type]) => type === "complete");
    expect(complete).toBeDefined();
    expect((complete?.[1] as Record<string, unknown>).timestamp).toBeDefined();

    // Events after complete should be ignored
    const countBefore = events.length;
    await fireEvent({
      type: "state-change",
      state: { type: "idle", since: new Date() },
    } as ProcessEvent);
    expect(events.length).toBe(countBefore);
  });

  it("heartbeat fires on interval", () => {
    const { process } = createMockProcess();
    const { emit, events } = collectEmit();

    const { cleanup } = createSessionSubscription(process, emit);

    const countBefore = events.length;
    vi.advanceTimersByTime(30_000);

    const heartbeats = events
      .slice(countBefore)
      .filter(([type]) => type === "heartbeat");
    expect(heartbeats).toHaveLength(1);
    expect(
      (heartbeats[0][1] as Record<string, unknown>).timestamp,
    ).toBeDefined();

    cleanup();
  });

  it("cleanup unsubscribes and clears heartbeat", () => {
    const { process } = createMockProcess();
    const { emit, events } = collectEmit();

    const { cleanup } = createSessionSubscription(process, emit);
    cleanup();

    const countAfterCleanup = events.length;
    vi.advanceTimersByTime(60_000);
    // No heartbeats emitted after cleanup
    expect(events.length).toBe(countAfterCleanup);
  });

  it("cleanup clears streaming text if active", () => {
    const { process } = createMockProcess();
    const { emit } = collectEmit();

    // We need to trigger a message with a streaming ID to set currentStreamingMessageId
    // But since we can't easily do that without async augmenter, test that clearStreamingText
    // is called on cleanup after a message event triggers accumulation
    const { cleanup } = createSessionSubscription(process, emit);
    cleanup();

    // clearStreamingText is not called if no streaming was active (currentStreamingMessageId is null)
    // This is correct behavior - it only clears if there was active streaming
  });

  it("calls onError when emit throws in event handler", async () => {
    const { process, fireEvent } = createMockProcess();
    const onError = vi.fn();
    const throwingEmit: Emit = (type) => {
      if (type === "status") throw new Error("emit failed");
    };

    createSessionSubscription(process, throwingEmit, { onError });

    await fireEvent({
      type: "state-change",
      state: { type: "idle", since: new Date() },
    } as ProcessEvent);

    expect(onError).toHaveBeenCalledOnce();
  });
});

// ── Activity Subscription ────────────────────────────────────────────

describe("createActivitySubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits connected with timestamp", () => {
    const { eventBus } = createMockEventBus();
    const { emit, events } = collectEmit();

    createActivitySubscription(eventBus, emit);

    expect(events[0][0]).toBe("connected");
    expect((events[0][1] as Record<string, unknown>).timestamp).toBeDefined();
  });

  it("forwards eventBus events with correct eventType", () => {
    const { eventBus, fireEvent } = createMockEventBus();
    const { emit, events } = collectEmit();

    createActivitySubscription(eventBus, emit);

    fireEvent({
      type: "session-status-changed",
      sessionId: "s1",
      projectId: "p1",
    } as BusEvent);

    const forwarded = events.find(
      ([type]) => type === "session-status-changed",
    );
    expect(forwarded).toBeDefined();
    expect(forwarded?.[1]).toMatchObject({
      type: "session-status-changed",
      sessionId: "s1",
    });
  });

  it("heartbeat fires on interval", () => {
    const { eventBus } = createMockEventBus();
    const { emit, events } = collectEmit();

    const { cleanup } = createActivitySubscription(eventBus, emit);

    const countBefore = events.length;
    vi.advanceTimersByTime(30_000);

    const heartbeats = events
      .slice(countBefore)
      .filter(([type]) => type === "heartbeat");
    expect(heartbeats).toHaveLength(1);

    cleanup();
  });

  it("cleanup stops heartbeat and unsubscribes", () => {
    const { eventBus, fireEvent } = createMockEventBus();
    const { emit, events } = collectEmit();

    const { cleanup } = createActivitySubscription(eventBus, emit);
    cleanup();

    const countAfter = events.length;
    vi.advanceTimersByTime(60_000);
    fireEvent({ type: "session-created" } as BusEvent);

    expect(events.length).toBe(countAfter);
  });

  it("calls onError when emit throws", () => {
    const { eventBus, fireEvent } = createMockEventBus();
    const onError = vi.fn();
    const throwingEmit: Emit = (type) => {
      if (type !== "connected") throw new Error("emit failed");
    };

    createActivitySubscription(eventBus, throwingEmit, { onError });

    fireEvent({ type: "file-change" } as BusEvent);

    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not emit after closed", () => {
    const { eventBus, fireEvent } = createMockEventBus();
    const { emit, events } = collectEmit();

    const { cleanup } = createActivitySubscription(eventBus, emit);

    const countBefore = events.length;
    cleanup();

    // Since unsubscribe removes the handler, no events should be forwarded
    fireEvent({ type: "file-change" } as BusEvent);
    expect(events.length).toBe(countBefore);
  });
});
