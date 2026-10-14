# Eval SP Harness service contract

This is the **target service contract** consumed by `apps/eval-api`. The current SP branch does not yet expose all of these routes. SP will implement or reconcile the route names during its public API work; Eval must not call SP Durable Object storage or private source modules.

The Eval Run Worker calls the independently deployed Eval SP origin with `X-Eval-Service-Token`. SP authenticates the service and checks the requested user, Agent Config, Chat, and Workspace ownership. HTTP responses below are bare JSON. A `409` on Chat ensure means immutable creation facts conflict; an unknown operation lookup returns JSON `null` with `200`, while an unknown Chat is an error. Retries use the original Chat ID and operation key.

| Operation | Target route | Request / response |
| --- | --- | --- |
| Ensure ordinary Inbox Chat | `PUT /internal/v1/eval-harness/chats/{chatId}` | `EnsureAgentInput` / `AgentHandle`; SP validates owner, Project, Sampling, role, `sp` framework, Agent Config and optional Evaluator Workspace binding. |
| Initialize Chat | `POST /internal/v1/eval-harness/chats/{chatId}/initialization` | `{idempotencyKey,data,runtime?}` / `MaterializedDataBinding`; SP loads optional Session and materials into the Chat exactly once. |
| Submit or restart | `POST /internal/v1/eval-harness/chats/{chatId}/submissions` | `{idempotencyKey,prompt,runtime?,unattended:true}` / `AgentSubmission` with the real Submission ID. A new key in one Chat creates a new Submission; the same key recovers the original. SP handles approvals and `ask_user` without an observer connection. |
| Inspect operation | `GET /internal/v1/eval-harness/chats/{chatId}/submissions/by-key/{key}` | `AgentSubmission` or `null`; no write or replacement Submission. |
| Observe terminal | `WS /internal/v1/eval-harness/chats/{chatId}/submissions/{submissionId}/events` | Authenticate the upgrade with `X-Eval-Service-Token`. On connect SP sends a persisted status snapshot, then `{"type":"submission.status","submission":AgentSubmission}` updates for this Submission. Disconnect permits one HTTP inspection; normal progress uses the socket, not polling. |
| Collect output | `GET /internal/v1/eval-harness/chats/{chatId}/output?role=...&samplingId=...&evaluationId=...` | `ExecutionOutput` or `EvaluationAgentOutput`. SP returns the complete artifact list and complete trajectory reference, including failed runs. Subject files remain in its Workspace; Evaluator outputs stay under `/evaluations/{evaluationId}/`. |
| Collect raw resources | `GET /internal/v1/eval-harness/chats/{chatId}/resources/by-key/{key}?submissionId=...` | `AgentResourceSnapshot` with source events, `coverage` and `finalized` unchanged. SP resolves a missing Submission ID by Chat and key; it never substitutes Chat ID. |
| Materialize Subject trajectory | `POST /internal/v1/eval-harness/workspaces/{userId}/{chatId}/trajectory` | `{idempotencyKey,samplingId,trajectory}` / `204`; SP reads the complete Subject trajectory and writes it once into the Subject SpaceDO. Evaluator preparation waits for confirmation. |

The Run Worker process reads persisted Run configuration and Sample references, composes the existing Runtime and PostgreSQL recovery worker, and exits only after active Runs drain. It uses this service contract; browser session tokens are never stored for background execution. This release's concrete Harness rejects `codex` and `cc` rather than falling back to SP.
