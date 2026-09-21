# Reliable Conversation Runtime (Problem 5)

Bounded TypeScript runtime that manages one streamed conversational turn: policy gate → provider stream → single terminal state, with an honest persistence boundary and redacted operational traces.

## Prerequisites

- Node.js 20+

## Setup

```bash
cd runtime
npm install
```

## Tests

```bash
npm test
```

## Verification benchmark

```bash
npm run benchmark
```

Runs 10 iterations of each scenario (success, reject, cancel, timeout, provider failure) and checks invariants.

## Demo CLI

```bash
npm run cli -- demo success
npm run cli -- demo reject
npm run cli -- demo cancel
npm run cli -- demo timeout
npm run cli -- demo fail

npm run cli -- turn start --text "Hello there"
npm run cli -- turn start --text "BLOCK: do bad things"
```

The CLI prints each `[stream N]` chunk as it arrives. Programmatic callers can
provide `StartTurnOptions.onEvent` to receive the same ordered operational
events before `run()` resolves.

See the repository root `SUBMISSION.md` for architecture notes and acceptance mapping.
