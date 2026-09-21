import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider.js";
import { PolicyGate } from "../src/policy.js";
import { ConversationStore } from "../src/store.js";
import { TurnRuntime } from "../src/runtime.js";
import { redactValue } from "../src/trace.js";
import { assertBenchmarkInvariants, runBenchmark } from "../src/benchmark.js";

function createRuntime(provider: FakeProvider, store?: ConversationStore) {
  return new TurnRuntime({
    provider,
    store: store ?? new ConversationStore(),
    policy: new PolicyGate(),
  });
}

async function cancelWhenStreaming(runtime: TurnRuntime, input: string) {
  const pending = runtime.run({ input, timeoutMs: 30_000 });
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const msgs = runtime.store.listMessages();
    const last = msgs[msgs.length - 1];
    if (!last) continue;
    const turn = runtime.store.getTurn(last.turnId);
    if (turn?.state === "streaming") {
      runtime.cancel(last.turnId);
      break;
    }
  }
  return pending;
}

describe("AC1 successful streamed turn", () => {
  it("streams chunks in order, completes once, and persists assistant", async () => {
    const provider = new FakeProvider({
      kind: "complete",
      chunks: ["Hello", ", ", "world"],
    });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "hi", timeoutMs: 5_000 });

    expect(result.state).toBe("completed");
    expect(result.partialOutput).toBe("Hello, world");
    expect(result.assistantPersisted).toBe(true);
    expect(provider.callCount).toBe(1);
    expect(result.trace.filter((e) => e.type === "terminal")).toHaveLength(1);
    expect(runtime.store.assistantMessagesForTurn(result.turnId)[0]?.content).toBe(
      "Hello, world",
    );
  });

  it("publishes ordered chunk events before the run promise resolves", async () => {
    const provider = new FakeProvider({
      kind: "complete",
      chunks: ["live", " ", "output"],
      delayMs: 5,
    });
    const runtime = createRuntime(provider);
    const chunks: string[] = [];
    const observedAfterResolution: boolean[] = [];
    let resolved = false;

    const pending = runtime.run({
      input: "stream to caller",
      timeoutMs: 5_000,
      onEvent: (event) => {
        if (event.type === "chunk") {
          chunks.push(String(event.data?.text ?? ""));
          observedAfterResolution.push(resolved);
        }
      },
    });
    const result = await pending.then((value) => {
      resolved = true;
      return value;
    });

    expect(result.state).toBe("completed");
    expect(chunks).toEqual(["live", " ", "output"]);
    expect(observedAfterResolution).toEqual([false, false, false]);
  });
});

describe("AC2 pre-response rejection", () => {
  it("never calls the provider and does not persist assistant", async () => {
    const provider = new FakeProvider({ kind: "complete", chunks: ["nope"] });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "BLOCK: bad", timeoutMs: 5_000 });

    expect(result.state).toBe("rejected");
    expect(provider.callCount).toBe(0);
    expect(result.assistantPersisted).toBe(false);
    expect(result.policy?.allowed).toBe(false);
    expect(runtime.store.listMessages().every((m) => m.role === "user")).toBe(true);
  });
});

describe("AC3 cancellation", () => {
  it("stops provider consumption and ends as cancelled", async () => {
    const provider = new FakeProvider({
      kind: "infinite_until_abort",
      chunk: "x",
      delayMs: 5,
    });
    const runtime = createRuntime(provider);
    const result = await cancelWhenStreaming(runtime, "keep going");

    expect(result.state).toBe("cancelled");
    expect(result.assistantPersisted).toBe(false);
    expect(result.trace.some((e) => e.type === "cancel_requested")).toBe(true);
    // Cannot later become completed
    expect(runtime.cancel(result.turnId)).toBe(false);
    expect(runtime.store.getTurn(result.turnId)?.state).toBe("cancelled");
  });
});

describe("AC4 timeout", () => {
  it("times out without persisting a successful assistant response", async () => {
    const provider = new FakeProvider({
      kind: "slow_complete",
      chunks: ["late"],
      delayBeforeMs: 400,
    });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "slow", timeoutMs: 40 });

    expect(result.state).toBe("timed_out");
    expect(result.assistantPersisted).toBe(false);
    expect(result.trace.some((e) => e.type === "timeout_fired")).toBe(true);
  });

  it("retains partial output on the turn without persisting an assistant message", async () => {
    const provider = new FakeProvider({
      kind: "infinite_until_abort",
      chunk: "x",
      delayMs: 5,
    });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "partial timeout", timeoutMs: 25 });

    expect(result.state).toBe("timed_out");
    expect(result.partialOutput.length).toBeGreaterThan(0);
    expect(result.assistantPersisted).toBe(false);
    expect(runtime.store.getTurn(result.turnId)?.partialOutput).toBe(result.partialOutput);
    expect(runtime.store.assistantMessagesForTurn(result.turnId)).toHaveLength(0);
  });
});

describe("AC5 provider failure", () => {
  it("records failure after partial output without completed assistant", async () => {
    const provider = new FakeProvider({
      kind: "fail_after_n",
      chunks: ["Partial "],
      errorMessage: "upstream_down",
    });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "go", timeoutMs: 5_000 });

    expect(result.state).toBe("failed");
    expect(result.partialOutput).toBe("Partial ");
    expect(result.assistantPersisted).toBe(false);
    expect(result.trace.some((e) => e.type === "provider_error")).toBe(true);
    expect(
      result.trace.find((e) => e.type === "provider_error")?.data?.message,
    ).toBe("upstream_down");
  });
});

describe("AC6 terminal-state race", () => {
  it("keeps exactly one terminal when cancel and complete compete", async () => {
    const provider = new FakeProvider({
      kind: "complete",
      chunks: ["a", "b", "c", "d", "e"],
      delayMs: 15,
    });
    const runtime = createRuntime(provider);
    const pending = runtime.run({ input: "race", timeoutMs: 10_000 });

    // Cancel mid-stream so cancel wins over completion.
    let cancelled = false;
    for (let i = 0; i < 200 && !cancelled; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const msgs = runtime.store.listMessages();
      const last = msgs[msgs.length - 1];
      if (!last) continue;
      const turn = runtime.store.getTurn(last.turnId);
      if (turn?.state === "streaming" && turn.partialOutput.length > 0) {
        runtime.cancel(last.turnId);
        // Second terminal attempt should be ignored
        expect(runtime.tryTerminal(last.turnId, "completed")).toBe(false);
        cancelled = true;
      }
    }

    const result = await pending;
    expect(result.state).toBe("cancelled");
    expect(result.trace.filter((e) => e.type === "terminal")).toHaveLength(1);
    expect(result.trace.at(-1)?.type).toBe("terminal");
    expect(result.assistantPersisted).toBe(false);
  });

  it("rejects a terminal transition that is invalid for the current state", async () => {
    const provider = new FakeProvider({
      kind: "complete",
      chunks: ["valid"],
      delayMs: 10,
    });
    const runtime = createRuntime(provider);
    const pending = runtime.run({ input: "allowed", timeoutMs: 5_000 });
    const turnId = runtime.store.listMessages()[0]!.turnId;

    expect(runtime.tryTerminal(turnId, "rejected")).toBe(false);

    const result = await pending;
    expect(result.state).toBe("completed");
    expect(
      result.trace.some(
        (event) =>
          event.type === "terminal_ignored" &&
          event.data?.attempted === "rejected" &&
          event.data?.current === "streaming" &&
          event.data?.reason === "invalid_transition",
      ),
    ).toBe(true);
  });

  it("keeps the trace sealed when terminal transitions are attempted after completion", async () => {
    const provider = new FakeProvider({ kind: "complete", chunks: ["ok"] });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "done", timeoutMs: 5_000 });
    expect(result.state).toBe("completed");
    const traceAtCompletion = runtime.getTrace(result.turnId);

    expect(runtime.tryTerminal(result.turnId, "failed")).toBe(false);
    expect(runtime.cancel(result.turnId)).toBe(false);
    expect(runtime.store.getTurn(result.turnId)?.state).toBe("completed");
    expect(runtime.getTrace(result.turnId)).toEqual(traceAtCompletion);
    expect(runtime.getTrace(result.turnId).at(-1)?.type).toBe("terminal");
  });

  it("keeps timed_out when completion is attempted after the deadline wins", async () => {
    const provider = new FakeProvider({
      kind: "slow_complete",
      chunks: ["late"],
      delayBeforeMs: 100,
    });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "timeout wins", timeoutMs: 10 });
    const terminalTrace = runtime.getTrace(result.turnId);

    expect(result.state).toBe("timed_out");
    expect(runtime.tryTerminal(result.turnId, "completed")).toBe(false);
    expect(runtime.store.getTurn(result.turnId)?.state).toBe("timed_out");
    expect(runtime.getTrace(result.turnId)).toEqual(terminalTrace);
  });

  it("keeps cancelled when timeout is attempted after cancellation wins", async () => {
    const provider = new FakeProvider({
      kind: "infinite_until_abort",
      chunk: "x",
      delayMs: 5,
    });
    const runtime = createRuntime(provider);
    const pending = runtime.run({ input: "cancel wins", timeoutMs: 5_000 });
    const turnId = runtime.store.listMessages()[0]!.turnId;

    expect(runtime.cancel(turnId)).toBe(true);
    const result = await pending;
    const terminalTrace = runtime.getTrace(turnId);

    expect(result.state).toBe("cancelled");
    expect(runtime.tryTerminal(turnId, "timed_out")).toBe(false);
    expect(runtime.store.getTurn(turnId)?.state).toBe("cancelled");
    expect(runtime.getTrace(turnId)).toEqual(terminalTrace);
  });

  it("keeps completed when timeout is attempted after completion wins", async () => {
    const provider = new FakeProvider({ kind: "complete", chunks: ["fast"] });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "completion wins", timeoutMs: 5_000 });
    const terminalTrace = runtime.getTrace(result.turnId);

    expect(result.state).toBe("completed");
    expect(runtime.tryTerminal(result.turnId, "timed_out")).toBe(false);
    expect(runtime.store.getTurn(result.turnId)?.state).toBe("completed");
    expect(runtime.getTrace(result.turnId)).toEqual(terminalTrace);
  });
});

describe("AC7 safe operational trace", () => {
  it("redacts secrets and hidden reasoning from chunk meta", async () => {
    const provider = new FakeProvider({ kind: "complete", chunks: ["hi"] });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "hello", timeoutMs: 5_000 });

    const blob = JSON.stringify(result.trace);
    expect(blob).not.toContain("sk-secret-should-never-appear");
    expect(blob).not.toContain("hidden chain-of-thought");
    expect(blob).toContain("[REDACTED]");

    const chunk = result.trace.find((e) => e.type === "chunk");
    expect(chunk?.data?.meta).toMatchObject({
      apiKey: "[REDACTED]",
      reasoning: "[REDACTED]",
      systemPrompt: "[REDACTED]",
    });
  });

  it("redactValue covers nested sensitive keys", () => {
    const out = redactValue({
      ok: 1,
      nested: { apiKey: "secret", text: "visible" },
    }) as { nested: { apiKey: string; text: string } };
    expect(out.nested.apiKey).toBe("[REDACTED]");
    expect(out.nested.text).toBe("visible");
  });

  it("redacts secret-like values embedded in provider error messages", async () => {
    const secret = "sk-review-secret-1234567890";
    const provider = new FakeProvider({
      kind: "fail_after_n",
      chunks: ["partial"],
      errorMessage: `provider failed with ${secret}`,
    });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "fail safely", timeoutMs: 5_000 });

    const blob = JSON.stringify(result.trace);
    expect(result.state).toBe("failed");
    expect(blob).not.toContain(secret);
    expect(
      result.trace.find((event) => event.type === "provider_error")?.data?.message,
    ).toBe("provider failed with [REDACTED]");
  });
});

describe("persistence boundary", () => {
  it("refuses assistant commit unless turn is completed", () => {
    const store = new ConversationStore();
    const turn = store.createTurn("c1", "user says hi");
    store.forceState(turn.id, "cancelled");
    expect(() => store.commitAssistant(turn.id, "partial")).toThrow(/refuse assistant commit/);
  });

  it("reloads a completed turn and its messages from the file-backed store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caygnus-store-test-"));
    const filePath = join(directory, "conversation.json");

    try {
      const provider = new FakeProvider({ kind: "complete", chunks: ["saved"] });
      const runtime = createRuntime(provider, new ConversationStore(filePath));
      const result = await runtime.run({
        conversationId: "restart-test",
        input: "persist me",
        timeoutMs: 5_000,
      });

      const reloaded = new ConversationStore(filePath);
      expect(reloaded.getTurn(result.turnId)?.state).toBe("completed");
      expect(reloaded.listMessages("restart-test").map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(reloaded.assistantMessagesForTurn(result.turnId)[0]?.content).toBe("saved");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("verification benchmark", () => {
  it("passes 3 iterations of each scenario (smoke)", async () => {
    const { ok, failures, counts } = await runBenchmark(3);
    expect(ok, failures.join("\n")).toBe(true);
    expect(counts.completed).toBe(3);
    expect(counts.rejected).toBe(3);
    expect(counts.cancelled).toBe(3);
    expect(counts.timed_out).toBe(3);
    expect(counts.failed).toBe(3);
  }, 60_000);

  it("rejects every event that appears after a terminal event", async () => {
    const provider = new FakeProvider({ kind: "complete", chunks: ["ok"] });
    const runtime = createRuntime(provider);
    const result = await runtime.run({ input: "benchmark invariant", timeoutMs: 5_000 });
    const contaminated = {
      ...result,
      trace: [
        ...result.trace,
        {
          seq: result.trace.length + 1,
          type: "provider_error" as const,
          at: new Date().toISOString(),
          turnId: result.turnId,
          data: { message: "late error" },
        },
      ],
    };

    expect(
      assertBenchmarkInvariants("successful_completion", contaminated, 1),
    ).toContain("successful_completion: events after terminal: provider_error");
  });
});
