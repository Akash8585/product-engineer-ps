# Product Engineering Challenge Submission

## Candidate

- **Name:** Akash Kumar Prasad
- **Email:** akash.iit.work@gmail.com
- **GitHub:** https://github.com/Akash8585
- **Selected problem:** Problem 5 — Reliable AI Conversation Runtime
- **Demo video:** [Google Drive — caygnus demo.mp4](https://drive.google.com/file/d/1VJ4dCCJsdbJ2MbUdvS3ZKGS9lEofmXzF/view?usp=drive_link)

## Run the project

**Prerequisites:** Node.js 20+

```text
cd runtime
npm install
```

No API keys or environment variables are required. The runtime uses a deterministic `FakeProvider` only.

### Successful scenario (AC1)

```text
npm run cli -- demo success
```

You should see terminal state `completed`, streamed chunks, `assistantPersisted: true`, and both user + assistant messages in the persisted store dump. Chunk meta fields such as `apiKey` / `reasoning` appear as `[REDACTED]`.

### Failure / recovery scenarios

```text
npm run cli -- demo reject    # AC2 — provider.callCount = 0
npm run cli -- demo cancel    # AC3 — cancelled mid-stream
npm run cli -- demo timeout   # AC4 — timed_out; no assistant row
npm run cli -- demo fail      # AC5 — failed after partial output
```

Single-turn ad hoc:

```text
npm run cli -- turn start --text "Hello there"
npm run cli -- turn start --text "BLOCK: do bad things"
```

Optional persistence file (defaults to `runtime/data/store.json`):

```text
npm run cli -- turn start --text "Hello" --data ./data/demo.json
npm run cli -- messages --data ./data/demo.json
```

## Run the tests

```text
cd runtime
npm test
```

Vitest covers success, policy rejection (provider never called), cancellation,
timeout before and after partial output, provider failure, all terminal race
pairs, trace redaction, sealed traces, and file-backed persistence across a
store restart. Tests do not call paid model APIs or rely on long arbitrary
sleeps.

## Acceptance scenarios and verification

| Scenario | Status |
| --- | --- |
| AC1 Successful streamed turn | Completed |
| AC2 Pre-response rejection | Completed |
| AC3 Cancellation | Completed |
| AC4 Timeout | Completed |
| AC5 Provider failure | Completed |
| AC6 Terminal-state race | Completed (tested) |
| AC7 Safe operational trace | Completed |

### Verification benchmark

```text
cd runtime
npm run benchmark
```

**Observed result** (run on 2026-09-20 during development):

```text
Running verification benchmark: 10 iterations × 5 scenarios = 50 runs

Terminal-state counts:
  cancelled: 10
  completed: 10
  failed: 10
  rejected: 10
  timed_out: 10

BENCHMARK PASSED
Observed: {"completed":10,"rejected":10,"cancelled":10,"timed_out":10,"failed":10}
```

Invariants checked each run:

- Exactly one `terminal` trace event
- Rejected runs never invoke the provider (`callCount === 0`)
- Cancelled / timed_out / failed never persist a successful assistant message
- No events of any type appear after terminal

### Failure scenario for the demo video

Show `npm run cli -- demo fail` (partial chunks then `provider_error` → `failed`, `assistantPersisted: false`) and/or `demo timeout`. Reviewers can reproduce with the same commands above.

## Architecture and data flow

```text
CLI / benchmark
      │
      ▼
 TurnRuntime  ──► PolicyGate (deterministic accept/reject)
      │
      ├──► ModelProvider (FakeProvider)  // AbortSignal-aware stream
      ├──► TraceLog                      // ordered, redacted events
      └──► ConversationStore             // JSON file or in-memory
```

1. `TurnRuntime.run` creates a turn and persists the **user** message immediately.
2. `PolicyGate.evaluate` runs **before** any provider call. Reject → terminal `rejected`.
3. On allow, runtime enters `streaming`, starts a timeout timer, and consumes `provider.stream(..., signal)`.
4. Chunks append to `partialOutput` and the trace (with redaction), and are
   synchronously delivered to an optional `onEvent` observer so a CLI, web, or
   mobile adapter can render output before `run()` resolves.
5. `tryTerminal(state)` is the only way to leave streaming: first caller wins.
   Invalid attempts before terminal emit `terminal_ignored`; after terminal, the
   trace is sealed and later attempts return `false` without adding events.
6. **Assistant** messages are committed only when terminal state is `completed`.

State machine: `created → policy_checking → (rejected | streaming → {completed|cancelled|timed_out|failed})`.

## Technology choices

- **TypeScript + Node 20 + Vitest + tsx CLI** — native `AbortSignal` for cancel/timeout, async iterators for streaming, fast deterministic tests, ~10 minute reviewer setup.
- **File-backed JSON store** — enough to demonstrate persistence boundaries without a database.
- **Fake provider only** — required behaviour is runtime correctness, not model quality.

Alternatives considered: Python/FastAPI (also fine; AbortController is less ergonomic), SQLite (unnecessary for this scope), live OpenAI (out of scope and would make tests non-deterministic / paid).

Trade-off accepted: single-process CLI demos instead of a multi-client HTTP API. The same `TurnRuntime` could sit behind HTTP/SSE without changing the state machine.

## Important decisions

1. **Single `tryTerminal` gate** — product truth for terminal outcomes. Prevents cancel/timeout/complete races from double-committing or flipping `failed` → `completed`.
2. **Persistence boundary** — user always stored; assistant only on `completed`. Partials remain on the turn record + trace so cancel/timeout/fail stay honest. This also matches the scorecard follow-up (“keep partial after cancel without marking completed”).
3. **Redaction at append time** — sensitive keys (`apiKey`, `authorization`,
   `secret`, `systemPrompt`, `reasoning`, …) and common secret-like values in
   strings (API keys, bearer tokens, credentials, private keys) are replaced
   with `[REDACTED]` before events enter the log.

## Assumptions and limitations

- One turn at a time per `run()` invocation; no multi-agent tools.
- Policy is a deterministic marker/deny-list (`BLOCK:` and a small phrase list), not an ML classifier.
- Timeout uses real `setTimeout` with short durations in tests/benchmark (tens of ms), not a fully virtual clock.
- Store is local JSON, not concurrent multi-writer safe.
- No live model integration (deliberate).

## Production and scale

**Now:** in-process runtime, JSON file, fake provider, CLI.

**First production changes:**

1. Durable store (Postgres) with transactional commit of assistant rows only on `completed`.
2. HTTP/SSE (or WS) adapter that maps connection abort → `runtime.cancel(turnId)`.
3. Real provider adapter that forwards `AbortSignal` to the HTTP client and never writes raw reasoning/secrets into traces.
4. Metrics/alerts on terminal-state rates (timeout/fail spikes).
5. Horizontal scale: turn lease/lock so only one worker owns an active stream.

## AI usage

- **Cursor (Composer)** helped scaffold the TypeScript package, draft the state machine, tests, CLI, benchmark, and this submission document.
- I reviewed component boundaries against the Problem 5 brief, ran `npm test` and `npm run benchmark`, and manually exercised all CLI demos (`success`, `reject`, `cancel`, `timeout`, `fail`) to confirm observed terminal states and redaction.
- All behaviour in the submission is covered by deterministic tests I can explain (especially `tryTerminal`, persistence rules, and AbortSignal cancellation).

## Credibility note

- **Product:** [BuilderBridge](https://builderbridge.vercel.app/) — an
  AI-assisted construction operations workspace connecting master schedules,
  lookaheads, weekly commitments, field progress, RFIs, submittals, roadblocks,
  documents, and portfolio health.
- **My contribution:** I designed and implemented the product end to end using
  Next.js and TypeScript, Prisma and PostgreSQL, role-based project controls,
  private document storage, page-aware document search, and a project-scoped AI
  agent that prepares reviewable operational changes.
- **Operational complexity:** BuilderBridge combines critical-path scheduling,
  dependencies, project roles and permissions, private project files,
  document citations, agent streaming, and transactional schedule and project
  updates in one system.
- **Difficult decision:** I prevented the agent from silently changing project
  records. It must first produce a proposal with sources, warnings, and expected
  impact; confirmation then rechecks permissions and stale data before applying
  the change atomically and recording it in the activity history. This mirrors
  the challenge's principle that attempted execution must not be confused with
  a successful final result.
- **Evidence:** [Live product](https://builderbridge.vercel.app/) ·
  [BuilderBridge demo video](https://www.youtube.com/watch?v=MyIDR62UqKg)
