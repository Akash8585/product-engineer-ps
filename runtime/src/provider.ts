import type { ModelProvider, ProviderChunk } from "./types.js";

export type FakeScenario =
  | { kind: "complete"; chunks: string[]; delayMs?: number }
  | { kind: "fail_after_n"; chunks: string[]; errorMessage: string; delayMs?: number }
  | { kind: "infinite_until_abort"; chunk?: string; delayMs?: number }
  | {
      kind: "slow_complete";
      chunks: string[];
      /** Delay before first chunk — used with real short timeouts in demos. */
      delayBeforeMs: number;
      delayMs?: number;
    };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Controllable fake model provider for tests, demos, and the benchmark.
 * Honors AbortSignal and never calls a paid API.
 */
export class FakeProvider implements ModelProvider {
  readonly name = "fake";
  callCount = 0;
  lastInput: string | null = null;

  constructor(
    private scenario: FakeScenario = {
      kind: "complete",
      chunks: ["Hello", ", ", "world", "!"],
    },
    /** Extra fields attached to each chunk meta — used to prove redaction. */
    private readonly chunkMeta: Record<string, unknown> = {},
  ) {}

  setScenario(scenario: FakeScenario): void {
    this.scenario = scenario;
  }

  async *stream(input: string, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    this.callCount += 1;
    this.lastInput = input;
    const scenario = this.scenario;
    const delayMs = "delayMs" in scenario && scenario.delayMs != null ? scenario.delayMs : 0;

    if (scenario.kind === "slow_complete") {
      await sleep(scenario.delayBeforeMs, signal);
    }

    if (scenario.kind === "infinite_until_abort") {
      const text = scenario.chunk ?? ".";
      while (!signal.aborted) {
        yield {
          text,
          meta: {
            ...this.chunkMeta,
            apiKey: "sk-secret-should-never-appear",
            reasoning: "hidden chain-of-thought",
          },
        };
        await sleep(delayMs || 1, signal);
      }
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }

    const chunks =
      scenario.kind === "complete" ||
      scenario.kind === "fail_after_n" ||
      scenario.kind === "slow_complete"
        ? scenario.chunks
        : [];

    for (let i = 0; i < chunks.length; i++) {
      if (signal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      if (delayMs > 0) {
        await sleep(delayMs, signal);
      }
      yield {
        text: chunks[i]!,
        meta: {
          ...this.chunkMeta,
          apiKey: "sk-secret-should-never-appear",
          reasoning: "hidden chain-of-thought",
          systemPrompt: "you are a secret system prompt",
        },
      };
    }

    if (scenario.kind === "fail_after_n") {
      throw new Error(scenario.errorMessage);
    }
  }
}
