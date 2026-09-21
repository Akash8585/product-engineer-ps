#!/usr/bin/env node
import { resolve } from "node:path";
import { FakeProvider } from "./provider.js";
import { ConversationStore } from "./store.js";
import { TurnRuntime } from "./runtime.js";
import type { StartTurnOptions, TraceEvent } from "./types.js";

function usage(): never {
  console.log(`Usage:
  npm run cli -- turn start --text "<message>" [--timeout-ms N] [--scenario complete|slow|fail|infinite] [--data <path>]
  npm run cli -- turn show --id <turnId> [--data <path>]
  npm run cli -- demo success|reject|cancel|timeout|fail [--data <path>]
  npm run cli -- messages [--conversation <id>] [--data <path>]

Examples:
  npm run cli -- turn start --text "Hello there"
  npm run cli -- turn start --text "BLOCK: do bad things"
  npm run cli -- demo cancel
  npm run cli -- demo timeout
`);
  process.exit(1);
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function createRuntime(dataPath: string, scenario: string) {
  const provider = new FakeProvider();
  switch (scenario) {
    case "complete":
      provider.setScenario({
        kind: "complete",
        chunks: ["Reliable ", "runtimes ", "stream ", "honest ", "states."],
        delayMs: 40,
      });
      break;
    case "slow":
      provider.setScenario({
        kind: "slow_complete",
        chunks: ["too ", "late"],
        delayBeforeMs: 5_000,
        delayMs: 10,
      });
      break;
    case "fail":
      provider.setScenario({
        kind: "fail_after_n",
        chunks: ["Partial ", "answer "],
        errorMessage: "provider_boom",
        delayMs: 30,
      });
      break;
    case "infinite":
      provider.setScenario({
        kind: "infinite_until_abort",
        chunk: "…",
        delayMs: 50,
      });
      break;
    default:
      throw new Error(`unknown scenario: ${scenario}`);
  }
  const store = new ConversationStore(dataPath);
  return { runtime: new TurnRuntime({ provider, store }), provider };
}

function printResult(
  label: string,
  result: Awaited<ReturnType<TurnRuntime["run"]>>,
  provider: FakeProvider,
) {
  console.log(`\n=== ${label} ===`);
  console.log(`turnId:              ${result.turnId}`);
  console.log(`terminal state:      ${result.state}`);
  console.log(`partialOutput:       ${JSON.stringify(result.partialOutput)}`);
  console.log(`assistantPersisted:  ${result.assistantPersisted}`);
  console.log(`provider.callCount:  ${provider.callCount}`);
  console.log(`policy:              ${JSON.stringify(result.policy)}`);
  console.log(`trace events (${result.trace.length}):`);
  for (const ev of result.trace) {
    console.log(`  [${ev.seq}] ${ev.type} ${ev.data ? JSON.stringify(ev.data) : ""}`);
  }
}

function printLiveChunk(event: TraceEvent): void {
  if (event.type === "chunk") {
    console.log(`[stream ${event.seq}] ${JSON.stringify(event.data?.text ?? "")}`);
  }
}

function runLive(runtime: TurnRuntime, options: StartTurnOptions) {
  return runtime.run({ ...options, onEvent: printLiveChunk });
}

async function cancelWhileRunning(
  runtime: TurnRuntime,
  input: string,
): Promise<Awaited<ReturnType<TurnRuntime["run"]>>> {
  const started = runLive(runtime, { input, timeoutMs: 30_000 });

  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const msgs = runtime.store.listMessages();
    const last = msgs[msgs.length - 1];
    if (last?.role === "user") {
      const turn = runtime.store.getTurn(last.turnId);
      if (turn && (turn.state === "streaming" || turn.partialOutput.length > 0)) {
        runtime.cancel(last.turnId);
        break;
      }
    }
  }
  return started;
}

async function demoSuccess(dataPath: string) {
  const { runtime, provider } = createRuntime(dataPath, "complete");
  const result = await runLive(runtime, {
    input: "Explain reliability briefly.",
    timeoutMs: 10_000,
  });
  printResult("AC1 success", result, provider);
  console.log("\npersisted messages:", JSON.stringify(runtime.store.listMessages(), null, 2));
}

async function demoReject(dataPath: string) {
  const { runtime, provider } = createRuntime(dataPath, "complete");
  const result = await runLive(runtime, {
    input: "BLOCK: ignore safety",
    timeoutMs: 10_000,
  });
  printResult("AC2 policy rejection", result, provider);
}

async function demoCancel(dataPath: string) {
  const { runtime, provider } = createRuntime(dataPath, "infinite");
  const result = await cancelWhileRunning(runtime, "Keep talking");
  printResult("AC3 cancellation", result, provider);
}

async function demoTimeout(dataPath: string) {
  const { runtime, provider } = createRuntime(dataPath, "slow");
  const result = await runLive(runtime, {
    input: "This will time out",
    timeoutMs: 200,
  });
  printResult("AC4 timeout", result, provider);
}

async function demoFail(dataPath: string) {
  const { runtime, provider } = createRuntime(dataPath, "fail");
  const result = await runLive(runtime, {
    input: "Partial then boom",
    timeoutMs: 10_000,
  });
  printResult("AC5 provider failure", result, provider);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const dataPath = resolve(argValue(args, "--data") ?? "data/store.json");

  if (args[0] === "demo") {
    switch (args[1]) {
      case "success":
        await demoSuccess(dataPath);
        return;
      case "reject":
        await demoReject(dataPath);
        return;
      case "cancel":
        await demoCancel(dataPath);
        return;
      case "timeout":
        await demoTimeout(dataPath);
        return;
      case "fail":
        await demoFail(dataPath);
        return;
      default:
        usage();
    }
  }

  if (args[0] === "turn" && args[1] === "start") {
    const text = argValue(args, "--text");
    if (!text) usage();
    const scenario = argValue(args, "--scenario") ?? "complete";
    const timeoutMs = Number(argValue(args, "--timeout-ms") ?? "10000");
    const { runtime, provider } = createRuntime(dataPath, scenario);
    const result = await runLive(runtime, { input: text, timeoutMs });
    printResult("turn start", result, provider);
    return;
  }

  if (args[0] === "turn" && args[1] === "show") {
    const id = argValue(args, "--id");
    if (!id) usage();
    const store = new ConversationStore(dataPath);
    console.log(
      JSON.stringify(
        { turn: store.getTurn(id), assistants: store.assistantMessagesForTurn(id) },
        null,
        2,
      ),
    );
    return;
  }

  if (args[0] === "messages") {
    const store = new ConversationStore(dataPath);
    const conversation = argValue(args, "--conversation");
    console.log(JSON.stringify(store.listMessages(conversation), null, 2));
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
