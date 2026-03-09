# Codex Session Reconnect Model

Investigation date: 2026-03-09

## Summary

Yep Anywhere should **not** blindly mirror upstream Codex Desktop resume behavior.

Our product goal is different:

- mobile-first, reconnect-prone supervision
- eager rendering when the phone wakes up
- recovery across unreliable network conditions
- eventual convergence to the durable transcript without waiting for a single authoritative sync step

That means we intentionally use multiple channels at once:

1. persisted Codex JSONL from disk
2. in-memory replay from the running process
3. live process stream updates after reconnect

The hard part is that **Codex live stream messages and persisted JSONL messages do not share a clean stable message UUID space** in our current integration, unlike Claude. So the client must reconcile semantically equivalent events across channels.

This document records:

- the contrast between the upstream Codex model and our model
- the current behavior in Yep Anywhere
- Codex API/integration limitations relevant to merging
- the intended direction for future work

## Contrast: Upstream Codex vs Yep Anywhere

### Upstream Codex model

Upstream Codex app-server handles thread resume as a **serialized server-side operation**.

Authoritative references in the Codex source tree:

- `/Users/kgraehl/code/reference/codex/codex-rs/app-server/src/thread_state.rs`
- `/Users/kgraehl/code/reference/codex/codex-rs/app-server/src/codex_message_processor.rs`
- `/Users/kgraehl/code/reference/codex/codex-rs/app-server-protocol/src/protocol/thread_history.rs`

Relevant points:

- `ThreadListenerCommand::SendThreadResumeResponse` is explicitly documented as sending history and atomically subscribing for new updates.
- `handle_pending_thread_resume_request()` composes the resume response inside the thread listener context.
- `populate_resume_turns()` rebuilds the durable history from rollout items and merges in the active in-memory turn.
- only after sending that response does the server replay pending requests and attach the connection.

In other words, upstream Codex tries to give the client a single ordered view:

1. durable history
2. active in-memory turn merged in
3. pending live updates after that point

This minimizes client-side merge ambiguity.

### Yep Anywhere model

Yep Anywhere intentionally does **not** wait for a single server-authoritative resume payload before showing data.

Current sources:

- REST session load from JSONL:
  - [packages/client/src/hooks/useSessionMessages.ts](/Users/kgraehl/code/yepanywhere/packages/client/src/hooks/useSessionMessages.ts)
- WebSocket session subscription with connected event + replay:
  - [packages/server/src/subscriptions.ts](/Users/kgraehl/code/yepanywhere/packages/server/src/subscriptions.ts)
- client reconnect catch-up logic:
  - [packages/client/src/hooks/useSession.ts](/Users/kgraehl/code/yepanywhere/packages/client/src/hooks/useSession.ts)

Current behavior:

1. client eagerly fetches persisted JSONL via REST
2. client subscribes to the live session stream
3. server emits `connected`
4. server replays recent in-memory message history
5. server continues streaming live process events
6. client may also do incremental JSONL fetches after reconnect

This is the right basic product behavior for mobile, because it optimizes for immediate visibility, not perfect resume serialization.

But it means the client is reconstructing one transcript from multiple non-identical channels.

## Why Codex is harder than Claude

Claude is easier because stream and persisted messages share stable message UUIDs.

Reference:

- [docs/research/claude-sdk-message-ids.md](/Users/kgraehl/code/yepanywhere/docs/research/claude-sdk-message-ids.md)

Codex is harder because the shapes differ:

- persisted JSONL stores `response_item`, `event_msg`, `turn_context`, etc.
- live Codex stream in our provider emits normalized SDK-style `assistant` / `user` messages with UUIDs derived from runtime item identifiers such as:
  - `item.id + turnId`
  - `call_id + turnId`
  - synthetic result suffixes like `-result`

Relevant local code:

- Codex live normalization:
  - [packages/server/src/sdk/providers/codex.ts](/Users/kgraehl/code/yepanywhere/packages/server/src/sdk/providers/codex.ts)
- persisted Codex normalization:
  - [packages/server/src/sessions/normalization.ts](/Users/kgraehl/code/yepanywhere/packages/server/src/sessions/normalization.ts)
- Codex session schema:
  - [packages/shared/src/codex-schema/session.ts](/Users/kgraehl/code/yepanywhere/packages/shared/src/codex-schema/session.ts)

Important consequence:

- persisted and live Codex messages often describe the same semantic event
- but they do not necessarily have the same ID
- so naive ID-based merge is insufficient

## Current Yep Anywhere state

### Server-side subscription behavior

Current subscription behavior is correct for the in-memory process stream, but not globally authoritative across disk + stream.

Reference:

- [packages/server/src/subscriptions.ts](/Users/kgraehl/code/yepanywhere/packages/server/src/subscriptions.ts)

Important details:

- subscription is installed before state snapshot to avoid missing in-memory process events
- server emits `connected`
- server replays `process.getMessageHistory()`
- server then streams new process events

This is atomic only with respect to the process event stream itself.

It is **not** atomic with respect to persisted JSONL loading.

### Client-side session reconstruction

Reference:

- [packages/client/src/hooks/useSessionMessages.ts](/Users/kgraehl/code/yepanywhere/packages/client/src/hooks/useSessionMessages.ts)
- [packages/client/src/hooks/useSession.ts](/Users/kgraehl/code/yepanywhere/packages/client/src/hooks/useSession.ts)

Important details:

- initial REST load eagerly fetches JSONL-backed messages
- stream events are buffered until initial load completes
- on `connected`, the client may fetch additional JSONL messages
- Codex reconnect logic historically had duplicate/interleaving risk because replayed live events and JSONL entries did not correlate by ID

### Current mitigation added on 2026-03-09

Reference:

- [packages/client/src/lib/codexLinearMessages.ts](/Users/kgraehl/code/yepanywhere/packages/client/src/lib/codexLinearMessages.ts)
- [packages/client/src/lib/__tests__/codexLinearMessages.test.ts](/Users/kgraehl/code/yepanywhere/packages/client/src/lib/__tests__/codexLinearMessages.test.ts)

Current Codex-only strategy:

- preserve eager multi-channel rendering
- treat Codex history as linear, not DAG-based
- order Codex messages by timestamp
- dedupe only when:
  - one message is from `sdk`
  - one message is from `jsonl`
  - semantic content matches
  - timestamps are close
- prefer JSONL when a stream/disk duplicate is detected

This is an intentionally conservative heuristic. It is not a perfect correlation model.

## Codex integration limitations relevant to merging

### 1. Missing stable cross-channel UUID contract

For our Codex integration, there is currently no equivalent of Claude's:

- `stream uuid == persisted uuid`

This is the core limitation.

### 2. Persisted transcript uses multiple record kinds

Codex persisted sessions are not just a stream of conversation messages.

They include:

- `response_item`
- `event_msg`
- `turn_context`
- `compacted`
- `session_meta`

So the durable timeline is partly transcript and partly execution metadata.

### 3. Runtime stream and persisted history are different projections

Our live provider emits normalized SDK-style messages for the UI.

Persisted JSONL is normalized later by a different code path.

Those two projections are similar, but not identical in identity or shape.

### 4. Mobile reconnect means ambiguous observation windows

When a phone wakes up:

- stream replay may include messages already persisted to disk
- JSONL may lag or lead relative to in-memory replay
- network may drop part of the replay or delay `connected`
- multiple catch-up paths may overlap

This is normal for our product model and should be designed for directly.

## Real-data validation

Local evidence exists in:

- `~/.yep-anywhere/logs/sdk-raw.jsonl`
- `~/.codex/sessions/.../*.jsonl`

Observed pattern:

- persisted rollout files have stable per-entry timestamps
- live SDK log lines for Codex contain runtime UUIDs for normalized messages
- the two can describe the same semantic event without sharing identifiers

This validates that the problem is real data, not just a theoretical schema mismatch.

## Design intent

We want the client to be:

- low latency
- recoverable
- monotonic in visible transcript behavior
- eventually convergent to durable disk state

We do **not** want:

- to block rendering on a single authoritative synchronization step
- to assume the network is reliable enough for one perfect resume path
- to import upstream Codex Desktop assumptions unchanged

So the intended model is:

1. render eagerly from whatever reliable source arrives first
2. merge replay/live/persisted channels deterministically
3. prefer durable JSONL once available
4. avoid transcript churn, duplication, and unstable ordering during convergence

## Desired direction

The current timestamp-plus-semantic-dedupe patch is a stopgap, not the end state.

The preferred next direction is to define an explicit Codex merge contract between server and client.

### Desired properties

- eager render remains possible
- convergence rules are explicit, not accidental
- server sends enough metadata that the client does less guessing
- duplicates become idempotent by construction

### Likely improvements

1. Add Codex-specific correlation metadata on the server

- candidate components:
  - normalized event kind
  - turn id
  - item id or call id
  - persisted timestamp
- this does not need to equal upstream Codex IDs exactly
- it just needs to be stable across our live and persisted normalization paths

2. Add source watermarks

- examples:
  - replay covers in-memory history through timestamp `T`
  - JSONL fetch reflects disk through timestamp `T`
- lets the client reason about overlap more explicitly

3. Add connection-generation or replay-epoch markers

- lets the client distinguish current replay from stale replay after reconnect churn

4. Move more merge logic server-side without delaying first paint

- the server can emit a richer normalized resume snapshot
- the client can still render immediately from any early source
- but later convergence can anchor against one server-normalized view

5. Replace heuristic semantic dedupe with explicit correlation where possible

- content+timestamp should remain fallback behavior, not the primary identity mechanism

## Non-goal

It is a non-goal to exactly mimic upstream Codex Desktop resume semantics if doing so would:

- delay render on mobile reconnect
- reduce resilience under unreliable connectivity
- remove our ability to combine multiple partial channels into a better low-latency view

The right target is not "Desktop parity at all costs."

The right target is:

- a mobile-first, multi-channel, eventually consistent transcript model with deterministic convergence.

## References

### Yep Anywhere

- [packages/server/src/subscriptions.ts](/Users/kgraehl/code/yepanywhere/packages/server/src/subscriptions.ts)
- [packages/client/src/hooks/useSession.ts](/Users/kgraehl/code/yepanywhere/packages/client/src/hooks/useSession.ts)
- [packages/client/src/hooks/useSessionMessages.ts](/Users/kgraehl/code/yepanywhere/packages/client/src/hooks/useSessionMessages.ts)
- [packages/client/src/lib/codexLinearMessages.ts](/Users/kgraehl/code/yepanywhere/packages/client/src/lib/codexLinearMessages.ts)
- [packages/server/src/sdk/providers/codex.ts](/Users/kgraehl/code/yepanywhere/packages/server/src/sdk/providers/codex.ts)
- [packages/server/src/sessions/normalization.ts](/Users/kgraehl/code/yepanywhere/packages/server/src/sessions/normalization.ts)
- [packages/shared/src/codex-schema/session.ts](/Users/kgraehl/code/yepanywhere/packages/shared/src/codex-schema/session.ts)
- [docs/research/claude-sdk-message-ids.md](/Users/kgraehl/code/yepanywhere/docs/research/claude-sdk-message-ids.md)

### Reference Codex repo

- `/Users/kgraehl/code/reference/codex/codex-rs/app-server/src/thread_state.rs`
- `/Users/kgraehl/code/reference/codex/codex-rs/app-server/src/codex_message_processor.rs`
- `/Users/kgraehl/code/reference/codex/codex-rs/app-server-protocol/src/protocol/thread_history.rs`
- `/Users/kgraehl/code/reference/codex/sdk/typescript/src/thread.ts`
- `/Users/kgraehl/code/reference/codex/sdk/typescript/src/events.ts`
- `/Users/kgraehl/code/reference/codex/sdk/typescript/src/items.ts`
