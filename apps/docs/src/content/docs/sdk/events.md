---
title: Events and records
description: SDK event, workflow-run record, and normalized model-turn types.
lastReviewedAt: 2026-06-12
---

## `FlueEvent`

`FlueEvent` is the observable runtime-event union. It includes run lifecycle, agent lifecycle, model turn, message, tool, task, compaction, operation, log, and idle events. Events are durably stored in an event stream and can be replayed from any offset via the Durable Streams protocol. Dispatched activity uses `dispatchId` as its delivery identity rather than becoming a workflow run.

Every delivered event carries the durable event-format version `v: 1`, a per-context `eventIndex`, and a `timestamp`. The SDK union mirrors the wire format: `turn_request` is in-process only on the server (`observe()` subscribers and exporters) and never appears on streams the SDK reads.

## `AttachedAgentEvent`

`AttachedAgentEvent` is emitted by direct interactions with persistent agent instances. It excludes workflow-run lifecycle events, requires `instanceId`, and does not include `runId`.

## Run types

| Type                 | Description                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `RunRecord`          | Persisted workflow-run record, including the workflow name, status, timestamps, payload, result, and error fields. |
| `RunStatus`          | Workflow-run status: `'active'`, `'completed'`, or `'errored'`.                                 |

## Normalized model-turn types

`turn` events expose normalized model data through these exported types:

| Type                   | Description                                                              |
| ---------------------- | ------------------------------------------------------------------------ |
| `LlmAssistantMessage`  | Normalized assistant message.                                            |
| `LlmTextContent`       | Text content.                                                            |
| `LlmThinkingContent`   | Reasoning content.                                                       |
| `LlmToolCall`          | Tool call content.                                                       |
| `LlmTurnPurpose`       | Model-turn purpose: `'agent'`, `'compaction'`, or `'compaction_prefix'`. |
