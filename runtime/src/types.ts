export type TurnState =
  | "created"
  | "policy_checking"
  | "streaming"
  | "completed"
  | "rejected"
  | "cancelled"
  | "timed_out"
  | "failed";

export type TerminalState =
  | "completed"
  | "rejected"
  | "cancelled"
  | "timed_out"
  | "failed";

export const TERMINAL_STATES: ReadonlySet<TurnState> = new Set([
  "completed",
  "rejected",
  "cancelled",
  "timed_out",
  "failed",
]);

export function isTerminal(state: TurnState): state is TerminalState {
  return TERMINAL_STATES.has(state);
}

export type TraceEventType =
  | "turn_created"
  | "policy_decision"
  | "provider_started"
  | "chunk"
  | "cancel_requested"
  | "timeout_fired"
  | "provider_error"
  | "terminal"
  | "terminal_ignored";

export interface TraceEvent {
  seq: number;
  type: TraceEventType;
  at: string;
  turnId: string;
  data?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export interface ProviderChunk {
  text: string;
  /** Optional fields that must never appear in traces if sensitive. */
  meta?: Record<string, unknown>;
}

export interface ModelProvider {
  readonly name: string;
  stream(
    input: string,
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk>;
}

export interface ConversationMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface TurnRecord {
  id: string;
  conversationId: string;
  userInput: string;
  state: TurnState;
  policy?: PolicyDecision;
  partialOutput: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export interface ConversationStoreSnapshot {
  turns: TurnRecord[];
  messages: ConversationMessage[];
}

export interface StartTurnOptions {
  conversationId?: string;
  input: string;
  /** Wall-clock timeout in ms. Use a very large value in unit tests that cancel manually. */
  timeoutMs?: number;
  /** Receives operational events synchronously as they occur, including streamed chunks. */
  onEvent?: (event: TraceEvent) => void;
  /**
   * Optional injectable "now" for traces/timeouts.
   * When `advanceTime` is used with a logical clock, prefer FakeProvider scenarios instead.
   */
  now?: () => number;
}

export interface TurnResult {
  turnId: string;
  state: TurnState;
  partialOutput: string;
  policy?: PolicyDecision;
  trace: TraceEvent[];
  assistantPersisted: boolean;
}
