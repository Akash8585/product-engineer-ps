import { randomUUID } from "node:crypto";
import { PolicyGate } from "./policy.js";
import type { FakeProvider } from "./provider.js";
import type { ModelProvider } from "./types.js";
import { ConversationStore } from "./store.js";
import { TraceLog } from "./trace.js";
import {
  isTerminal,
  type PolicyDecision,
  type StartTurnOptions,
  type TerminalState,
  type TurnResult,
  type TurnState,
} from "./types.js";

export interface TurnRuntimeDeps {
  policy?: PolicyGate;
  provider: ModelProvider;
  store?: ConversationStore;
}

interface ActiveTurn {
  abortController: AbortController;
  trace: TraceLog;
  state: TurnState;
  partialOutput: string;
  policy?: PolicyDecision;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

function canEnterTerminalState(current: TurnState, next: TerminalState): boolean {
  if (next === "rejected") {
    return current === "policy_checking";
  }
  return current === "streaming";
}

/**
 * Bounded runtime that manages one streamed conversational turn.
 * Owns the state machine, timeout/cancel races, and persistence boundary.
 */
export class TurnRuntime {
  private readonly policy: PolicyGate;
  private readonly provider: ModelProvider;
  readonly store: ConversationStore;
  private readonly active = new Map<string, ActiveTurn>();
  /** Traces retained after terminal for inspection (demo / tests). */
  private readonly traces = new Map<string, TraceLog>();

  constructor(deps: TurnRuntimeDeps) {
    this.policy = deps.policy ?? new PolicyGate();
    this.provider = deps.provider;
    this.store = deps.store ?? new ConversationStore();
  }

  getTrace(turnId: string) {
    return this.traces.get(turnId)?.list() ?? this.active.get(turnId)?.trace.list() ?? [];
  }

  getProviderCallCount(): number {
    const p = this.provider as FakeProvider;
    return typeof p.callCount === "number" ? p.callCount : -1;
  }

  /**
   * Request cancellation for an in-flight turn.
   * Safe to call after terminal — returns false without changing the sealed trace.
   */
  cancel(turnId: string): boolean {
    const active = this.active.get(turnId);
    if (!active) {
      const turn = this.store.getTurn(turnId);
      if (turn && isTerminal(turn.state)) {
        this.traces.get(turnId)?.append("terminal_ignored", {
          attempted: "cancelled",
          current: turn.state,
        });
        return false;
      }
      return false;
    }
    active.trace.append("cancel_requested", {});
    active.abortController.abort("user_cancel");
    return this.tryTerminal(turnId, "cancelled");
  }

  async run(options: StartTurnOptions): Promise<TurnResult> {
    const conversationId = options.conversationId ?? randomUUID();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const turn = this.store.createTurn(conversationId, options.input);
    const turnId = turn.id;
    const trace = new TraceLog(
      turnId,
      options.now ? () => new Date(options.now!()) : () => new Date(),
      options.onEvent,
    );
    const abortController = new AbortController();

    const active: ActiveTurn = {
      abortController,
      trace,
      state: "created",
      partialOutput: "",
    };
    this.active.set(turnId, active);
    this.traces.set(turnId, trace);
    trace.append("turn_created", { conversationId, inputLength: options.input.length });

    active.state = "policy_checking";
    this.store.updateTurn(turnId, { state: "policy_checking" });
    const decision = this.policy.evaluate(options.input);
    active.policy = decision;
    this.store.updateTurn(turnId, { policy: decision });
    trace.append("policy_decision", { ...decision });

    if (!decision.allowed) {
      this.tryTerminal(turnId, "rejected");
      return this.toResult(turnId);
    }

    active.state = "streaming";
    this.store.updateTurn(turnId, { state: "streaming" });
    trace.append("provider_started", { provider: this.provider.name });

    // Timeout races with provider completion / cancel.
    active.timeoutHandle = setTimeout(() => {
      if (!this.active.has(turnId)) return;
      trace.append("timeout_fired", { timeoutMs });
      abortController.abort("timeout");
      this.tryTerminal(turnId, "timed_out");
    }, timeoutMs);

    try {
      for await (const chunk of this.provider.stream(options.input, abortController.signal)) {
        if (!this.active.has(turnId)) break;
        active.partialOutput += chunk.text;
        this.store.updateTurn(turnId, { partialOutput: active.partialOutput });
        trace.append("chunk", {
          text: chunk.text,
          meta: chunk.meta,
        });
      }

      // Provider finished cleanly — only complete if we still own the turn.
      if (this.active.has(turnId)) {
        this.tryTerminal(turnId, "completed");
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const message = err instanceof Error ? err.message : String(err);
      if (name === "AbortError" || abortController.signal.aborted) {
        // cancel() or timeout already attempted terminal; ensure one exists.
        if (this.active.has(turnId)) {
          const reason = String(abortController.signal.reason ?? "");
          if (reason === "timeout") {
            this.tryTerminal(turnId, "timed_out");
          } else {
            this.tryTerminal(turnId, "cancelled");
          }
        }
      } else {
        trace.append("provider_error", { message, name });
        if (this.active.has(turnId)) {
          this.tryTerminal(turnId, "failed");
        }
      }
    } finally {
      if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
    }

    return this.toResult(turnId);
  }

  /**
   * First successful terminal transition wins.
   * Later attempts return false without changing the sealed trace.
   * Invalid attempts made before terminal append `terminal_ignored`.
   */
  tryTerminal(turnId: string, next: TerminalState): boolean {
    const active = this.active.get(turnId);
    const trace = active?.trace ?? this.traces.get(turnId);
    if (!active) {
      const existing = this.store.getTurn(turnId);
      if (existing && isTerminal(existing.state)) {
        trace?.append("terminal_ignored", { attempted: next, current: existing.state });
      }
      return false;
    }

    if (isTerminal(active.state)) {
      trace?.append("terminal_ignored", { attempted: next, current: active.state });
      return false;
    }

    if (!canEnterTerminalState(active.state, next)) {
      trace?.append("terminal_ignored", {
        attempted: next,
        current: active.state,
        reason: "invalid_transition",
      });
      return false;
    }

    active.state = next;
    if (active.timeoutHandle) {
      clearTimeout(active.timeoutHandle);
      active.timeoutHandle = undefined;
    }

    const terminalAt = new Date().toISOString();
    this.store.updateTurn(turnId, {
      state: next,
      partialOutput: active.partialOutput,
      terminalAt,
      policy: active.policy,
    });
    trace?.append("terminal", { state: next, partialLength: active.partialOutput.length });

    if (next === "completed") {
      this.store.commitAssistant(turnId, active.partialOutput);
    }

    // Abort provider if we won via timeout/cancel path that didn't abort yet.
    if (!active.abortController.signal.aborted && (next === "cancelled" || next === "timed_out")) {
      active.abortController.abort(next === "timed_out" ? "timeout" : "user_cancel");
    }

    this.active.delete(turnId);
    return true;
  }

  private toResult(turnId: string): TurnResult {
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new Error(`missing turn ${turnId}`);
    const assistantPersisted = this.store.assistantMessagesForTurn(turnId).length > 0;
    return {
      turnId,
      state: turn.state,
      partialOutput: turn.partialOutput,
      policy: turn.policy,
      trace: this.getTrace(turnId),
      assistantPersisted,
    };
  }
}
