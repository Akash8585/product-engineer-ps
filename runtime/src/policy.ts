import type { PolicyDecision } from "./types.js";

/**
 * Deterministic pre-response policy gate.
 * Rejects inputs that contain the marker `BLOCK:` (case-sensitive) or match a deny-list.
 */
export class PolicyGate {
  constructor(private readonly denyList: string[] = ["bomb making", "steal credentials"]) {}

  evaluate(input: string): PolicyDecision {
    const trimmed = input.trim();
    if (!trimmed) {
      return { allowed: false, reason: "empty_input" };
    }
    if (trimmed.includes("BLOCK:")) {
      return { allowed: false, reason: "blocked_marker" };
    }
    const lower = trimmed.toLowerCase();
    for (const phrase of this.denyList) {
      if (lower.includes(phrase.toLowerCase())) {
        return { allowed: false, reason: `deny_list:${phrase}` };
      }
    }
    return { allowed: true, reason: "ok" };
  }
}
