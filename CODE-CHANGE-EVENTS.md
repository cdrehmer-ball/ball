# Code-change events

Available in the local pilot build **1.5.1-customizing.2**. Disabled by default. Enabling events does not enable SAP writes or expand authorization.

## Enable in Claude Desktop

Add these values to the existing ARC-1 entry's `env` in Claude's MCP configuration, keeping its SAP settings:

```json
{
  "ARC1_CODE_CHANGE_EVENTS": "true"
}
```

Fully quit and restart Claude. Events append as one JSON object per line to:

- Windows: `%LOCALAPPDATA%/arc-1/events/code-changes.jsonl`
- Linux/macOS default: `~/.local/share/arc-1/events/code-changes.jsonl`

Override the path with `ARC1_CODE_CHANGE_LOG` (absolute path). Keep separate files for separate server processes; cross-process ordering is not guaranteed. On Windows, the containing user's inherited filesystem permissions apply. Logs contain object names and actor/system metadata; apply your normal access and retention controls. No automatic log rotation is performed.

The installer accepts `-EnableCodeChangeEvents` to enable the local event log while preserving existing SAP permissions. Without this switch it preserves the existing event setting. Webhook delivery is never enabled by the installer.

## Optional webhook

Configure the receiver explicitly:

```json
{
  "ARC1_CODE_CHANGE_EVENTS": "true",
  "ARC1_CODE_CHANGE_WEBHOOK_URL": "https://events.example.org/arc1/code-changes",
  "ARC1_CODE_CHANGE_WEBHOOK_TOKEN": "<receiver-specific bearer token>"
}
```

Use a webhook-specific token, never SAP credentials. The endpoint is administrator configuration, not a tool argument. HTTPS certificate validation remains enabled regardless of `SAP_INSECURE`. Redirects are refused; credentials, query strings and fragments in the URL are refused. Authenticate using the separate token setting. Internal HTTPS endpoints are permitted when deliberately configured by the operator.

The body is the same redacted JSON event stored locally. Headers are `Content-Type: application/json`, `Idempotency-Key: <eventId>`, and optional `Authorization: Bearer ...`. Receivers should deduplicate on `eventId`. The JSON `schemaVersion` starts at 1.

An event is appended locally before webhook delivery. Delivery uses up to three attempts, a three-second request timeout and bounded backoff; ordinary non-retryable 4xx responses are not retried. Queue capacity is 256 pending local writes and 256 webhook events. Overflow/failure produces a rate-limited diagnostic; local events remain available when webhook delivery fails. Local write failure suppresses webhook delivery for that event. Event delivery never repeats, rolls back or changes the result of the SAP operation.

Shutdown flushes local writes and gives webhook delivery up to five additional seconds, then cancels outstanding requests. Delivery is best-effort, not transactional or exactly-once. Pending in-memory events can be lost on abrupt process termination. Failed webhook deliveries are **not automatically replayed after restart**; a consumer can replay the local JSONL using the original event IDs. Audit events also remain available through existing audit sinks.

## What emits events

- `SAPWrite`: create/update/delete, method and text edits, class surgery, generation and batch operations.
- `SAPActivate`: activation and service-binding publish/unpublish.
- `SAPManage`: package create/delete/move and API release-state changes.
- `SAPDiagnose apply_quickfix`.
- `SAPGit clone`, `pull`, and `switch_branch` (operation-level evidence; no invented per-object diff).
- The same operations through the hyperfocused `SAP` wrapper and direct CLI use.

One terminal event is emitted per handled operation, not per changed source line. Batch requested-object metadata is capped at 50 entries and marked truncated when necessary. Compound operations aggregate observed HTTP outcomes. Child requests within a tool call do not emit duplicate operation events.

Reads, checks, locking/unlocking, formatting, data preview, Customising prepare/guide, dry runs and successful operations with no observed modifying request do not emit change events. Failed eligible operations may emit `not_attempted` when no modifying request was observed. Scope/schema/deny-action rejections before dispatch remain normal security audit events. Transport administration, diagnostic trace controls, external plugin execution and Git push/stage are outside code-change coverage.

This is **MCP-originated operation evidence**, not SAP-wide change-data capture. Edits made independently in SAP GUI, Eclipse, other MCP servers or transport imports are not observed. Manual Customising saves are not emitted as MCP code changes.

## Event meaning

Each event carries `eventId`, timestamp, request ID, tool/action, configured system origin (or destination identity), SAP client, known acting user, requested object identifiers, intended transport when supplied, overall operation status and HTTP evidence counts. Unresolved system identity is explicitly `unresolved`. The receiver URL/token, SAP passwords/cookies/session IDs, raw URLs/query strings, source code, configuration values and error/response bodies are excluded from the event payload.

`requestedObjects` and `requestedTransport` describe the invocation, not proof of what SAP actually recorded. For aggregate Git/quickfix operations the object list may be empty. Identity attached by the MCP is not a reconstruction of SAP's historical change records.

| Outcome | Meaning |
|---|---|
| `http_accepted` | At least one relevant request returned a completed 2xx response; no observed failed/uncertain mutation and the tool completed. |
| `rejected` | Relevant requests were rejected by definitive 4xx responses, with none accepted. |
| `unknown` | Timeout, connection failure, 5xx, 408/429, 202 asynchronous acceptance or another uncertain result. |
| `partial` | At least one request was accepted, but another request or a later step failed or remained uncertain. |
| `not_attempted` | The operation failed without an observed relevant modifying request, such as a failed LOCK. |

`verification: "not_performed"` is always explicit. HTTP acceptance does not prove the final source was saved, activated or recorded in a transport. An HTTP-200 response can also contain application-level errors: consumers must consider `operationStatus` and use a fresh read/activation/transport check before treating the result as a verified deployment. No automatic follow-up SAP writes are triggered by event delivery.

CLI equivalents: `--code-change-events true`, `--code-change-log <absolute-path>`, `--code-change-webhook-url <https-url>`, `--code-change-webhook-token <token>`. Prefer environment variables for secrets.
