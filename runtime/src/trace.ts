import type { TraceEvent, TraceEventType } from "./types.js";

const SENSITIVE_KEY =
  /^(api[_-]?key|authorization|secret|password|token|systemprompt|reasoning|chain[_-]?of[_-]?thought)$/i;

const SENSITIVE_STRING_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED]"],
  [
    /(\b(?:api[_-]?key|authorization|password|secret|token)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1[REDACTED]",
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED]",
  ],
];

function redactString(value: string): string {
  return SENSITIVE_STRING_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value,
  );
}

export function redactValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Ordered operational event log for a single turn.
 * Never stores secrets or hidden model reasoning in clear text.
 */
export class TraceLog {
  private events: TraceEvent[] = [];
  private seq = 0;
  private sealed = false;

  constructor(
    private readonly turnId: string,
    private readonly now: () => Date = () => new Date(),
    private readonly onEvent?: (event: TraceEvent) => void,
  ) {}

  append(type: TraceEventType, data?: Record<string, unknown>): TraceEvent | undefined {
    if (this.sealed) {
      return undefined;
    }
    const event: TraceEvent = {
      seq: ++this.seq,
      type,
      at: this.now().toISOString(),
      turnId: this.turnId,
      data: data ? (redactValue(data) as Record<string, unknown>) : undefined,
    };
    this.events.push(event);
    if (type === "terminal") {
      this.sealed = true;
    }
    try {
      this.onEvent?.(structuredClone(event));
    } catch {
      // Presentation observers must not change the runtime outcome.
    }
    return event;
  }

  list(): TraceEvent[] {
    return [...this.events];
  }

  /** True if any event data still contains an unredacted sensitive-looking secret sample. */
  containsCleartextSecret(sample = "sk-secret-should-never-appear"): boolean {
    const blob = JSON.stringify(this.events);
    return blob.includes(sample);
  }
}
