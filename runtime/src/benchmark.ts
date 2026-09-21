import { FakeProvider } from "./provider.js";
import { ConversationStore } from "./store.js";
import { TurnRuntime } from "./runtime.js";
import type { TerminalState, TurnResult } from "./types.js";
import { isTerminal } from "./types.js";

const ITERATIONS = 10;

export type ScenarioName =
  | "successful_completion"
  | "policy_rejection"
  | "cancellation"
  | "timeout"
  | "provider_failure";

interface ScenarioOutcome {
  name: ScenarioName;
  result: TurnResult;
  providerCalls: number;
  ok: boolean;
  errors: string[];
}

export function assertBenchmarkInvariants(
  name: ScenarioName,
  result: TurnResult,
  providerCalls: number,
): string[] {
  const errors: string[] = [];

  if (!isTerminal(result.state)) {
    errors.push(`${name}: expected terminal state, got ${result.state}`);
  }

  const terminals = result.trace.filter((e) => e.type === "terminal");
  if (terminals.length !== 1) {
    errors.push(`${name}: expected exactly 1 terminal event, got ${terminals.length}`);
  }

  const afterTerminal = result.trace.findIndex((e) => e.type === "terminal");
  if (afterTerminal !== -1) {
    const trailing = result.trace.slice(afterTerminal + 1);
    if (trailing.length > 0) {
      errors.push(
        `${name}: events after terminal: ${trailing.map((event) => event.type).join(",")}`,
      );
    }
  }

  if (name === "policy_rejection") {
    if (result.state !== "rejected") errors.push(`${name}: expected rejected`);
    if (providerCalls !== 0) errors.push(`${name}: provider must not be called`);
    if (result.assistantPersisted) errors.push(`${name}: assistant must not persist`);
  }

  if (name === "successful_completion") {
    if (result.state !== "completed") errors.push(`${name}: expected completed`);
    if (!result.assistantPersisted) errors.push(`${name}: assistant must persist`);
    if (providerCalls < 1) errors.push(`${name}: provider should be called`);
  }

  if (name === "cancellation") {
    if (result.state !== "cancelled") errors.push(`${name}: expected cancelled`);
    if (result.assistantPersisted) errors.push(`${name}: assistant must not persist`);
  }

  if (name === "timeout") {
    if (result.state !== "timed_out") errors.push(`${name}: expected timed_out`);
    if (result.assistantPersisted) errors.push(`${name}: assistant must not persist`);
  }

  if (name === "provider_failure") {
    if (result.state !== "failed") errors.push(`${name}: expected failed`);
    if (result.assistantPersisted) errors.push(`${name}: assistant must not persist`);
  }

  // No successful assistant for non-completed
  if (result.state !== "completed" && result.assistantPersisted) {
    errors.push(`${name}: non-completed turn persisted assistant`);
  }

  return errors;
}

async function runSuccess(): Promise<{ result: TurnResult; providerCalls: number }> {
  const provider = new FakeProvider({
    kind: "complete",
    chunks: ["a", "b", "c"],
  });
  const runtime = new TurnRuntime({ provider, store: new ConversationStore() });
  const result = await runtime.run({ input: "hello", timeoutMs: 5_000 });
  return { result, providerCalls: provider.callCount };
}

async function runReject(): Promise<{ result: TurnResult; providerCalls: number }> {
  const provider = new FakeProvider({ kind: "complete", chunks: ["should-not-run"] });
  const runtime = new TurnRuntime({ provider, store: new ConversationStore() });
  const result = await runtime.run({ input: "BLOCK: nope", timeoutMs: 5_000 });
  return { result, providerCalls: provider.callCount };
}

async function runCancel(): Promise<{ result: TurnResult; providerCalls: number }> {
  const provider = new FakeProvider({
    kind: "infinite_until_abort",
    chunk: ".",
    delayMs: 5,
  });
  const runtime = new TurnRuntime({ provider, store: new ConversationStore() });
  const pending = runtime.run({ input: "stream forever", timeoutMs: 30_000 });

  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const msgs = runtime.store.listMessages();
    const last = msgs[msgs.length - 1];
    if (!last) continue;
    const turn = runtime.store.getTurn(last.turnId);
    if (turn && turn.state === "streaming") {
      runtime.cancel(last.turnId);
      break;
    }
  }

  const result = await pending;
  return { result, providerCalls: provider.callCount };
}

async function runTimeout(): Promise<{ result: TurnResult; providerCalls: number }> {
  const provider = new FakeProvider({
    kind: "slow_complete",
    chunks: ["late"],
    delayBeforeMs: 500,
  });
  const runtime = new TurnRuntime({ provider, store: new ConversationStore() });
  const result = await runtime.run({ input: "timeout me", timeoutMs: 30 });
  return { result, providerCalls: provider.callCount };
}

async function runFail(): Promise<{ result: TurnResult; providerCalls: number }> {
  const provider = new FakeProvider({
    kind: "fail_after_n",
    chunks: ["part"],
    errorMessage: "boom",
  });
  const runtime = new TurnRuntime({ provider, store: new ConversationStore() });
  const result = await runtime.run({ input: "fail please", timeoutMs: 5_000 });
  return { result, providerCalls: provider.callCount };
}

const runners: Record<ScenarioName, () => Promise<{ result: TurnResult; providerCalls: number }>> = {
  successful_completion: runSuccess,
  policy_rejection: runReject,
  cancellation: runCancel,
  timeout: runTimeout,
  provider_failure: runFail,
};

export async function runBenchmark(iterations = ITERATIONS): Promise<{
  ok: boolean;
  counts: Record<string, number>;
  failures: string[];
}> {
  const counts: Record<string, number> = {};
  const failures: string[] = [];
  const outcomes: ScenarioOutcome[] = [];

  for (const name of Object.keys(runners) as ScenarioName[]) {
    for (let i = 0; i < iterations; i++) {
      const { result, providerCalls } = await runners[name]();
      const errors = assertBenchmarkInvariants(name, result, providerCalls);
      counts[result.state] = (counts[result.state] ?? 0) + 1;
      outcomes.push({
        name,
        result,
        providerCalls,
        ok: errors.length === 0,
        errors,
      });
      if (errors.length) {
        failures.push(...errors.map((e) => `[${name}#${i}] ${e}`));
      }
    }
  }

  return { ok: failures.length === 0, counts, failures };
}

async function main() {
  console.log(`Running verification benchmark: ${ITERATIONS} iterations × 5 scenarios = ${ITERATIONS * 5} runs\n`);
  const { ok, counts, failures } = await runBenchmark(ITERATIONS);

  console.log("Terminal-state counts:");
  for (const [state, n] of Object.entries(counts).sort()) {
    console.log(`  ${state}: ${n}`);
  }

  console.log("\nInvariant checks:");
  console.log("  - each run has exactly one terminal event");
  console.log("  - rejected runs never invoke the provider");
  console.log("  - cancelled / timed_out / failed never persist a successful assistant response");
  console.log("  - no events appear after terminal");

  if (!ok) {
    console.error("\nBENCHMARK FAILED");
    for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
    if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`);
    process.exit(1);
  }

  const expected: Record<TerminalState, number> = {
    completed: ITERATIONS,
    rejected: ITERATIONS,
    cancelled: ITERATIONS,
    timed_out: ITERATIONS,
    failed: ITERATIONS,
  };
  for (const [state, n] of Object.entries(expected)) {
    if ((counts[state] ?? 0) !== n) {
      console.error(`Unexpected count for ${state}: got ${counts[state] ?? 0}, want ${n}`);
      process.exit(1);
    }
  }

  console.log("\nBENCHMARK PASSED");
  console.log(`Observed: ${JSON.stringify(counts)}`);
}

const isMain = process.argv[1]?.includes("benchmark");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
