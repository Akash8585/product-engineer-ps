import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ConversationMessage,
  ConversationStoreSnapshot,
  TurnRecord,
  TurnState,
} from "./types.js";

/**
 * File-backed conversation store.
 * Persistence rules:
 * - User messages are written when a turn starts.
 * - Assistant messages are written ONLY when the turn reaches `completed`.
 * - Partial output on cancel/timeout/fail stays on the TurnRecord, never as assistant success.
 */
export class ConversationStore {
  private turns = new Map<string, TurnRecord>();
  private messages: ConversationMessage[] = [];

  constructor(private readonly filePath?: string) {
    if (filePath) {
      this.load();
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, "utf8");
    if (!raw.trim()) return;
    const snap = JSON.parse(raw) as ConversationStoreSnapshot;
    this.turns = new Map(snap.turns.map((t) => [t.id, t]));
    this.messages = snap.messages ?? [];
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const snap: ConversationStoreSnapshot = {
      turns: [...this.turns.values()],
      messages: this.messages,
    };
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  createTurn(conversationId: string, userInput: string, now = new Date()): TurnRecord {
    const id = randomUUID();
    const createdAt = now.toISOString();
    const turn: TurnRecord = {
      id,
      conversationId,
      userInput,
      state: "created",
      partialOutput: "",
      createdAt,
      updatedAt: createdAt,
    };
    this.turns.set(id, turn);
    this.messages.push({
      id: randomUUID(),
      turnId: id,
      role: "user",
      content: userInput,
      createdAt,
    });
    this.persist();
    return structuredClone(turn);
  }

  updateTurn(
    turnId: string,
    patch: Partial<Pick<TurnRecord, "state" | "policy" | "partialOutput" | "terminalAt">>,
  ): TurnRecord {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`unknown turn: ${turnId}`);
    Object.assign(turn, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    return structuredClone(turn);
  }

  /**
   * Persist a successful assistant response. Only valid for completed turns.
   */
  commitAssistant(turnId: string, content: string, now = new Date()): ConversationMessage {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`unknown turn: ${turnId}`);
    if (turn.state !== "completed") {
      throw new Error(
        `refuse assistant commit for turn ${turnId} in state ${turn.state}; only completed turns persist assistant messages`,
      );
    }
    const msg: ConversationMessage = {
      id: randomUUID(),
      turnId,
      role: "assistant",
      content,
      createdAt: now.toISOString(),
    };
    this.messages.push(msg);
    this.persist();
    return structuredClone(msg);
  }

  getTurn(turnId: string): TurnRecord | undefined {
    const t = this.turns.get(turnId);
    return t ? structuredClone(t) : undefined;
  }

  listMessages(conversationId?: string): ConversationMessage[] {
    if (!conversationId) return this.messages.map((m) => structuredClone(m));
    const turnIds = new Set(
      [...this.turns.values()]
        .filter((t) => t.conversationId === conversationId)
        .map((t) => t.id),
    );
    return this.messages
      .filter((m) => turnIds.has(m.turnId))
      .map((m) => structuredClone(m));
  }

  assistantMessagesForTurn(turnId: string): ConversationMessage[] {
    return this.messages
      .filter((m) => m.turnId === turnId && m.role === "assistant")
      .map((m) => structuredClone(m));
  }

  /** Test helper: set state without going through runtime (for negative commit tests). */
  forceState(turnId: string, state: TurnState): void {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`unknown turn: ${turnId}`);
    turn.state = state;
    turn.updatedAt = new Date().toISOString();
  }
}
