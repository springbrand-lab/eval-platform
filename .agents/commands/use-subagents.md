# use-subagents

For the remainder of this conversation, follow these subagent guidelines:

## Keep the main context window clean

- Offload research, exploration, file discovery, and codebase analysis to subagents instead of doing it inline.
- Reserve the main context for decision-making, synthesis, and direct edits.

## Use subagents strategically

- Prefer subagents when the **data-reduction ratio is high** — the subagent reads many files but returns a small, distilled output. The token cost is contained within the subagent; only the compressed finding enters the main context.
- Prefer subagents when tasks are **independent and parallelizable** — launch N subagents simultaneously to cut wall-clock time from sum(all) to max(individual).
- **Do not** spawn a subagent for work you can do in 1–3 tool calls. The overhead of prompt construction, context setup, and response parsing exceeds the savings on trivial tasks.
- **The small-edit carve-out is a batch, not a single edit.** A batch of small, closely-related edits to files *already loaded in the main thread's context* — the typical grind-fix shape: a few call sites plus one test — is inline-eligible as a whole, not edit-by-edit. The ceiling is roughly **50 lines of new/changed code total (about one file's worth)**; above that, route the batch to an implementer/background subagent even when each individual edit in it looks trivial on its own. A one-line/typo/count fix always qualifies for the direct path, loaded or not. This is the same carve-out `/pr-grind` and `/orchestrate` use for their Sonnet-lane/implementer dispatch decision — keep the number in sync across all three docs if it changes.
- **The 50-line ceiling wins over the "1-3 tool calls" heuristic for edit batches.** A change that is small in tool-call count but large in diff size still routes to an implementer — e.g. a single `Write` that rewrites 60 lines of a file is one tool call but past the ceiling, so it goes to a background subagent, not inline.
- **Delegate rarely, and only when the payoff clearly exceeds the overhead.** Each subagent re-establishes context, re-explores, and reports back, and then you re-read its report. Current models reach for subagents readily on their own, so the useful guidance is the ceiling, not the encouragement: if one subagent can do the task, use one; don't split a modest job across several; and don't delegate review, verification, or double-checking your own work — that belongs in your main loop. The one exception is the independence-driven fresh-context review (pr-grind's fresh-eyes lane, orchestrate's fresh-context review): its value is that the reviewer has NOT seen your reasoning, which is exactly what your own main loop cannot provide.
- **Parallel dispatch isn't free.** Each background agent costs tokens and review attention; keep to a soft cap of ~3–4 concurrent background agents per wave, exceed it only deliberately, and prefer fewer well-briefed agents over many shallow ones.
- For complex multi-stage investigations with dependencies between tasks, use the **DAG workflow** (see "DAG workflow for complex tasks" below) to plan execution waves and pass context between subagents through shared docs.

## Pick the right `subagent_type`

- **Default to `general-purpose`.** It has the broadest tool access and the strongest default reasoning quality — the right choice for almost any task involving analysis, synthesis, judgment, or non-trivial reading comprehension.
- Specialized subagent types ship alongside `general-purpose`, and the catalog evolves. Use a specialized type when its description obviously matches the task (e.g. a fast read-only file-finding sweep, or a planning agent that returns a step-by-step approach), or when the user explicitly asks for one. Don't memorize the list here — read the `Agent` tool's own description for the current set of types and their scopes.
- `subagent_type` values are case-sensitive and the spelling can change as the catalog evolves — copy the exact string from the `Agent` tool's description rather than relying on memory or examples in this doc.

## Set the subagent's model explicitly

- **Pass `model` on every dispatch. Never inherit.** Implicit inheritance only kicks in when the chosen subagent type has no `model` of its own, and many subagent definitions ship with a smaller / faster default in their frontmatter — so a dispatch without `model` can silently downgrade.
- **Fan-out agents run on `opus` or `sonnet` — never `fable`**, even when the parent chat is on Fable (which it is whenever ultracode is active). This is the project CLAUDE.md ultracode rule; the `Agent` tool accepts `fable` as an enum value, so the wrong dispatch is reachable and the explicit `model` argument is what prevents it.
- **Which of the two:** `opus` for reasoning, judgment, review, synthesis, and any investigation whose conclusion you will act on; `sonnet` for mechanical work — transcript and log reading, status gathering, well-specified implementation against a written spec, format sweeps. Sonnet at its default effort is comparable to the previous Sonnet generation at its ceiling, so it stretches further than it used to.
- **Effort** is a `Workflow` `agent()` option, not an `Agent`-tool parameter — an `Agent` dispatch inherits the session's effort and cannot override it (an agent *definition* can pin effort in its frontmatter). The full ladder is `low`/`medium`/`high`/`xhigh`/`max`. Where you *can* set it: `max` for the rare hardest judge/verify stage; `xhigh` for the hardest coding, review, and agentic work; `high` for other intelligence-sensitive work; `medium` for mechanical lanes where a step down is worth the cost saving; `low` for bulk mechanical sweeps where speed dominates.
- Trivial dispatches (e.g. a fast file-finding sweep) still get an explicit pin — `sonnet` is the default choice there. Omission is never the mechanism: a subagent definition's frontmatter default may be a bigger model than the sweep deserves (or `fable`, which fan-out must never run on), and the explicit argument is what prevents both.

## Claude Code `Agent` tool features worth knowing

A few `Agent` parameters and dispatch idioms materially change how subagents work — they're easy to miss but worth using. Always cross-check the current parameter names and accepted values against the `Agent` tool's own description (the surface evolves); the notes below describe the current behavior:

- **Parallel dispatch.** Multiple `Agent` tool calls in a *single* assistant message run concurrently. This is the primary fan-out mechanism in Claude Code — independent tasks within a wave should be issued together in one message, not one per turn.
- **`isolation: "worktree"`.** Runs the subagent inside a temporary git worktree (an isolated branch/copy of the repo) so its file changes are contained until you review them. Useful when a subagent will edit code; the worktree is auto-cleaned if the agent makes no changes, and the path/branch is returned otherwise.
- **`run_in_background: true`.** Fire-and-forget: the call returns immediately and you're notified when the subagent completes. Do **not** poll, sleep, or proactively check progress — continue with other work and pick up the result on notification.
- **Continuation via `SendMessage`.** A new `Agent` call starts a *fresh* subagent with no memory of prior runs, so its prompt must be self-contained. To resume a previously spawned subagent with full context instead, use `SendMessage` with the agent's ID or name as the `to` field. Prefer continuation when a follow-up depends on context the original subagent already gathered.

### Foreground vs. background: the decision rule

First matching row wins (the foreground carve-outs deliberately come first):

| Situation | Mode |
|-----------|------|
| The user is waiting synchronously on this single answer | Foreground |
| The result is consumed by your immediate next step AND the task is short | Foreground |
| The task is long-running, or the main thread has independent non-overlapping work, or the turn should end so the user regains control | Background |

## One task per subagent

- Each subagent should have a single, focused objective (e.g., "find all usages of X", "understand how Y works", "check Z for patterns").
- Write clear, self-contained prompts — the subagent has no access to prior conversation context.
- Specify exactly what information to return so results are immediately actionable.
- **Tell the subagent its role.** A subagent that doesn't understand its scope will either over-reach (duplicating work assigned to other tasks) or under-deliver (skipping findings it assumes "someone else" will cover). Every prompt should include:
  - What this task **is** — its specific objective
  - What this task **is not** — adjacent work that belongs to other tasks or the main agent
  - What **depends on its output** — so it knows what level of detail and completeness downstream consumers need
- **File claims for editing subagents.** If a subagent will EDIT files, its prompt must declare the exact paths it may touch (a "files you may touch:" line). No two concurrent agents may claim overlapping paths, and the main agent must not edit a claimed path while the agent runs. When using the DAG workflow, mirror the claims as a column or note in the DAG table. Default editing agents to `isolation: "worktree"` unless the main agent explicitly needs the edits in-place. A worktree's changes don't land by themselves: on completion the agent reports its worktree path/branch — review that diff directly, then integrate it deliberately (merge or cherry-pick the branch, or re-apply the reviewed changes on the main branch) and clean up the worktree branch.

## Token efficiency

- **Never ask subagents to return full file contents** in their response. This wastes tokens in both the subagent output and the main context window.
- Instead, let the subagent read files internally (via Read/Grep/etc.) and return only **findings, summaries, and relevant snippets** (with file paths and line numbers for reference).
- The whole point of a subagent is **data reduction**: it absorbs the cost of reading many files and returns only the compressed insight. If the output is as large as the input, the subagent added overhead for no benefit.
- If the main thread needs full file contents after a subagent returns, use the Read tool directly.
- When writing subagent prompts, say "Read and analyze X, return your findings" — not "Read X and return the full contents."

## Share context through structured docs

When dispatching multiple subagents — especially across waves in a DAG (see below) — use **shared markdown docs** to pass context efficiently. This supports three context flows:

1. **Main → subagents** (seed context): The main agent writes shared background once; all subagents read it.
2. **Subagent → main** (output docs): Each subagent writes its findings to a dedicated output doc; the main agent reads all docs after a wave completes.
3. **Subagent → subagent** (cross-wave dependencies): A subagent in Wave 1 reads the output doc written by a subagent in Wave 0, inheriting its findings without the main agent needing to relay them.

### Directory convention

```
.subagent-shared/<task-group>/
├── seed-context.md              # Written by main agent before Wave 0
├── T1-auth-backend.md           # Written by subagent T1
├── T2-auth-frontend.md          # Written by subagent T2
├── T3-token-lifecycle.md        # Written by subagent T3 (reads T1's doc)
└── ...
```

> **Why `.subagent-shared/` instead of `/tmp/`?** Keeping docs inside the repo (gitignored) means subagents resolve paths relative to the workspace root — no absolute paths needed. The directory is listed in `.gitignore` so it never gets committed.

- **Task group name**: A short kebab-case descriptor of the overall objective (e.g., `auth-refactor`, `perf-audit`, `migration-plan`). If concurrent agent sessions are possible, append a short timestamp or hash to avoid collisions (e.g., `auth-refactor-20260414`, `perf-audit-a3f9`).
- **File naming**: `<task-id>-<short-name>.md` — the task ID from the DAG table plus a descriptive slug.
- **Seed context**: `seed-context.md` — written by the main agent before dispatching Wave 0. Contains shared prerequisite knowledge that multiple subagents need.

### Read/write contract

| Actor | May write to | May read from |
|-------|-------------|---------------|
| Main agent | `seed-context.md`, any file in the directory | All files |
| Subagent (task T1) | `T1-<name>.md` only | `seed-context.md` + any dependency output docs listed in its prompt |

- **One output doc per subagent.** Each subagent writes only to its own designated file. It must never modify another subagent's output or the seed context.
- **Read dependencies explicitly.** A subagent's prompt must list exactly which docs to read. Don't say "read everything in the directory" — that's wasteful and breaks the principle of focused, scoped work.

### Output doc template

Each subagent's output doc should follow this structure for consistency:

```markdown
# <Task ID>: <Task description>

## Summary
One-paragraph summary of findings.

## Key Findings
- **Finding 1**: Description. (`path/to/file.py:L42-L58`)
- **Finding 2**: Description. (`path/to/other.ts:L100`)

## Open Questions
- Question that downstream tasks or the main agent should consider.

## Recommendations
- Actionable recommendation based on findings.
```

### Lifecycle

1. **Main agent creates** the directory: `mkdir -p .subagent-shared/<task-group>/`
2. **Main agent writes** `seed-context.md` with shared prerequisite knowledge (if applicable).
3. **Subagents write** their output docs during execution.
4. **Main agent reads** output docs after each wave completes to update the DAG and inform subsequent waves.
5. **Main agent cleans up** the entire directory when all work is done: `rm -rf .subagent-shared/<task-group>/`

> **Stale directory cleanup**: If a workflow is interrupted before cleanup (e.g., session crash, user closes window, error aborts execution), the `.subagent-shared/` directory will persist on disk — but it is gitignored and will never be committed. At the start of a new session, check for and remove any leftover directories: `ls .subagent-shared/ 2>/dev/null && rm -rf .subagent-shared/*/`

### Avoiding duplicate work (the original pattern, preserved)

The shared-docs pattern also eliminates redundant reads. Before dispatching subagents, identify any **shared prerequisite research** they would each need to perform independently. Do that work once upfront and include it in the seed context.

❌ Bad — 3 subagents each independently read the same 8 model files:
```
Subagent 1: "Read all DB models and find usages of field X"
Subagent 2: "Read all DB models and find usages of field Y"
Subagent 3: "Read all DB models and find usages of field Z"
```

✅ Good — main agent reads models once, writes seed context, subagents get focused tasks:
```
Main agent: Read DB models → write .subagent-shared/field-audit/seed-context.md
  (contains: table names, key fields, relationships, file paths)

Subagent 1: "Read seed-context.md, then find usages of field X → write T1-field-x.md"
Subagent 2: "Read seed-context.md, then find usages of field Y → write T2-field-y.md"
Subagent 3: "Read seed-context.md, then find usages of field Z → write T3-field-z.md"
```

---

## DAG workflow for complex tasks

When a complex task involves multiple subagents with **dependencies between their outputs**, use a DAG (directed acyclic graph) to plan and execute the work systematically. The DAG ensures tasks run in the right order, maximizes parallelism within each wave, and routes context between subagents through shared docs.

### When to use the DAG workflow

- The task involves **≥4 subagent dispatches**.
- There are **dependencies between subagent outputs** — Subagent B needs Subagent A's findings to do its work.
- The work spans **multiple layers or modules** with cross-cutting concerns (e.g., backend + frontend + infra).
- You need a **traceable audit trail** of how the investigation or analysis progressed.

### When NOT to use it

- **≤3 independent subagents** with no inter-dependencies — just batch-dispatch them without the overhead of DAG planning.
- **All tasks are independent** — if nothing depends on anything else, there's no graph to build. Just launch them all in parallel.
- **Simple sequential chains** (A → B → C with no parallelism) — the DAG adds overhead for a linear pipeline. Just run them in sequence or do the work inline.

### Step-by-step DAG workflow

#### Step 1: Decompose

Break the complex task into discrete subtasks. Each subtask should map to **one subagent dispatch**. Give each a short ID (e.g., `T1`, `T2`, …) and a clear one-line description.

**Rules for good decomposition:**
- Each task should have a **single, focused objective** (same as "One task per subagent")
- Each task should produce a **concrete, reusable output** (findings doc, not just "I looked at things")
- Tasks should be **as independent as possible** — minimize edges in the DAG
- If two tasks share no dependencies and don't need each other's output, they belong in the same wave

#### Step 2: Identify dependencies

For each task, determine which other tasks must complete before it can start. Ask: "Does this task need findings from another task to do its work?"

- A task with **no dependencies** is a root task (Wave 0).
- A task that depends on **one or more** other tasks cannot start until all its dependencies are complete.
- **Watch for false dependencies.** If Task B only needs "some general background" that Task A also needed, that's shared seed context — not a true dependency on Task A's output. Write it in `seed-context.md` instead.

#### Step 3: Build the DAG table

Create a markdown table to track the entire DAG. This is your execution plan and progress tracker:

```markdown
### DAG: <task-group-name>

| Task | Description | Depends on | Wave | Status | Output doc |
|------|-------------|------------|------|--------|------------|
| T1 | Analyze backend auth middleware | — | 0 | pending | T1-auth-middleware.md |
| T2 | Analyze frontend auth components | — | 0 | pending | T2-auth-frontend.md |
| T3 | Trace token refresh lifecycle | T1 | 1 | pending | T3-token-refresh.md |
| T4 | Map API contract between FE ↔ BE | T1, T2 | 1 | pending | T4-api-contract.md |
| T5 | Identify test coverage gaps | T3, T4 | 2 | pending | T5-test-gaps.md |
| T6 | Draft migration plan | T3, T4 | 2 | pending | T6-migration-plan.md |
```

Update the **Status** column as tasks complete: `pending` → `running` → `done` (or `failed`). If any task will edit files, add a **Claims** column (or note) listing the exact paths it may touch, matching the "files you may touch" line in its prompt.

#### Step 4: Assign waves

Group tasks by dependency depth. A task's wave number is determined by its longest dependency chain:

- **Wave 0**: Tasks with no dependencies. All can run in parallel.
- **Wave 1**: Tasks whose dependencies are all in Wave 0.
- **Wave N**: Tasks whose dependencies are all in Wave N-1 or earlier.

**Maximize parallelism within each wave.** All tasks in the same wave are independent of each other and should be dispatched simultaneously.

#### Step 5: Create shared-docs directory and seed context

```bash
mkdir -p .subagent-shared/<task-group>/
```

If multiple Wave 0 tasks share prerequisite knowledge (e.g., "here's how the auth system is structured"), the main agent writes it to `seed-context.md` before dispatching:

```bash
# Main agent writes seed context — distilled background for all subagents
# Include: architecture summary, key file paths, relevant patterns, conventions
```

If no shared prerequisite exists, skip the seed context — don't create an empty file.

#### Step 6: Execute wave by wave

For each wave, from 0 to N:

1. **Dispatch all tasks in the wave in parallel.** Each subagent prompt includes:
   - Its specific task description
   - Path to `seed-context.md` (if it exists)
   - Paths to dependency output docs (for waves > 0)
   - Path to write its own output doc

2. **Dispatch in the background; resume on notification.** Issue all wave tasks with `run_in_background: true` in one message, then end the turn (or do genuinely independent, non-overlapping work). Completion notifications re-invoke you — never block, poll, or sleep waiting for a wave. The DAG table's Status column is the tracking mechanism for partial arrivals: on each completion notification, verify that task's output doc and flip its Status (`running` → `done`/`failed`); proceed to the next wave only when no task in the wave remains `running` and every `done` task's output doc has been verified.

3. **Read output docs.** The main agent reads each output doc from the completed wave. Check for:
   - Quality: Are findings concrete and actionable?
   - Gaps: Did any subagent fail to answer its question or report blockers?
   - Conflicts: Do two subagents' findings contradict each other?

4. **Update the DAG table.** Mark completed tasks as `done`. If a subagent failed or produced poor results, decide whether to retry it or adjust downstream tasks.

5. **Proceed to the next wave.** Subagents in the next wave can now read the output docs from all prior waves.

#### Step 7: Synthesize

After all waves are complete, the main agent reads all output docs and synthesizes the final result. This is where decision-making happens — subagents gathered evidence, the main agent decides what to do with it.

- Identify cross-cutting themes across subagent findings
- Resolve any contradictions between output docs
- Form the final plan, analysis, or implementation approach
- The main agent owns all code edits and implementation work

#### Step 8: Clean up

```bash
rm -rf .subagent-shared/<task-group>/
```

Remove all shared docs after the work is complete. These are ephemeral working files, not permanent artifacts.

### Subagent prompt template (for DAG tasks)

Use this template when writing prompts for subagents that are part of a DAG:

```
You are completing task <TASK_ID>: <DESCRIPTION>.

You are one subagent in a larger DAG of tasks. Here is your role:

**Your role (what IS your job):**
<Specific, focused task description. What exactly should this subagent investigate,
trace, or analyze? Be precise about scope boundaries.>

**Not your role (what is NOT your job):**
<Explicitly list adjacent work that belongs to other tasks or the main agent.
E.g., "Do not investigate the frontend auth components — that is task T2."
or "Do not propose fixes — just identify the problems. The main agent will
decide on solutions.">

**Who depends on your output:**
<List downstream tasks and what they need from you. E.g., "Task T3 will use your
findings to trace the token lifecycle, so be thorough about middleware ordering
and token validation logic." This tells the subagent what level of detail matters.>

**Read first (shared context):**
- Seed context: .subagent-shared/<group>/seed-context.md
[For waves > 0, add dependency docs:]
- T1 findings: .subagent-shared/<group>/T1-<name>.md
- T2 findings: .subagent-shared/<group>/T2-<name>.md

**Write your findings to:** .subagent-shared/<group>/<task-id>-<name>.md

Your output doc must include:
1. A one-paragraph summary of findings
2. Key findings with file paths and line numbers
3. Open questions or ambiguities for downstream tasks
4. Recommendations (if applicable)
```

### Example: DAG for cross-cutting auth refactor

**Goal:** Investigate and plan a refactor of the auth middleware that spans backend and frontend.

#### DAG table

```markdown
### DAG: auth-refactor

| Task | Description | Depends on | Wave | Status | Output doc |
|------|-------------|------------|------|--------|------------|
| T1 | Trace backend auth middleware chain | — | 0 | pending | T1-auth-middleware.md |
| T2 | Map frontend auth state and guards | — | 0 | pending | T2-auth-frontend.md |
| T3 | Trace token refresh + expiry lifecycle | T1 | 1 | pending | T3-token-lifecycle.md |
| T4 | Map FE ↔ BE auth API contract | T1, T2 | 1 | pending | T4-api-contract.md |
| T5 | Identify auth-related test gaps | T3, T4 | 2 | pending | T5-test-gaps.md |
| T6 | Draft refactor plan with migration steps | T3, T4 | 2 | pending | T6-refactor-plan.md |
```

#### Execution

**Setup:**
```bash
mkdir -p .subagent-shared/auth-refactor/
# Main agent writes seed-context.md with: project structure overview,
# auth-related file paths, current auth flow diagram, relevant config
```

**Wave 0** — Dispatch T1 and T2 in parallel:
```
T1 prompt: "You are task T1 in the auth-refactor DAG.

  Your role: Trace the backend auth middleware chain in cc_core/ — identify all
  middleware functions, decorators, and auth checks applied to routes. Map the flow
  from request → token validation → user resolution → route handler.

  Not your role: Do not investigate frontend auth (that's T2). Do not trace the
  full token refresh lifecycle (that's T3). Focus on the middleware chain only.

  Who depends on you: T3 (token lifecycle) needs your middleware ordering and
  validation logic. T4 (API contract) needs your endpoint auth requirements.
  Be thorough about which endpoints require auth and what checks run.

  Read seed-context.md first.
  Write findings to .subagent-shared/auth-refactor/T1-auth-middleware.md."

T2 prompt: "You are task T2 in the auth-refactor DAG.

  Your role: Map the frontend auth state management in cc_web_user_portal/ —
  auth context/store, route guards, token storage, login/logout flows, and
  protected route components.

  Not your role: Do not investigate backend middleware (that's T1). Do not trace
  token refresh mechanics (that's T3). Focus on the frontend auth layer only.

  Who depends on you: T4 (API contract mapping) needs your findings about how
  the frontend calls auth endpoints and handles auth errors. Be specific about
  request headers, token storage locations, and error handling behavior.

  Read seed-context.md first.
  Write findings to .subagent-shared/auth-refactor/T2-auth-frontend.md."
```

**Wave 0 completes.** Main agent reads T1 and T2 output docs. Both are clear and complete.

**Wave 1** — Dispatch T3 and T4 in parallel:
```
T3 prompt: "You are task T3 in the auth-refactor DAG.

  Your role: Trace the complete token lifecycle — issuance, storage, refresh,
  expiry handling, and revocation. Focus on edge cases (expired token during
  active session, concurrent refresh requests).

  Not your role: Do not re-investigate middleware structure (T1 already did that —
  read its output). Do not map the FE↔BE contract (that's T4). Do not identify
  test gaps (that's T5).

  Who depends on you: T5 (test gaps) and T6 (refactor plan) both consume your
  output. Be thorough about edge cases and failure modes — T5 needs them to
  identify missing test coverage, and T6 needs them to plan safe migration steps.

  Read seed-context.md and T1-auth-middleware.md first.
  Write findings to .subagent-shared/auth-refactor/T3-token-lifecycle.md."

T4 prompt: "You are task T4 in the auth-refactor DAG.

  Your role: Map the API contract between frontend and backend for auth —
  endpoints, request/response shapes, headers, error codes, and retry behavior.
  Identify mismatches or fragile assumptions between the two layers.

  Not your role: Do not re-investigate backend middleware (read T1's output) or
  frontend state management (read T2's output). Do not trace token lifecycle
  details (that's T3). Focus strictly on the FE↔BE interface boundary.

  Who depends on you: T5 (test gaps) and T6 (refactor plan) both consume your
  output. Be specific about contract mismatches — T6 needs them to plan
  backward-compatible migration steps.

  Read seed-context.md, T1-auth-middleware.md, and T2-auth-frontend.md first.
  Write findings to .subagent-shared/auth-refactor/T4-api-contract.md."
```

**Wave 1 completes.** Main agent reads T3 and T4 output docs.

**Wave 2** — Dispatch T5 and T6 in parallel:
```
T5 prompt: "You are task T5 in the auth-refactor DAG.

  Your role: Identify test coverage gaps for the auth system — untested edge
  cases, missing integration tests, and areas where the token lifecycle or API
  contract lacks coverage.

  Not your role: Do not draft the refactor plan (that's T6). Do not propose
  code fixes — just identify what's untested.

  Who depends on you: The main agent will use your output to prioritize which
  tests to write during the refactor. Be specific about what's missing and why
  it matters (severity of the gap).

  Read T3-token-lifecycle.md and T4-api-contract.md first.
  Write findings to .subagent-shared/auth-refactor/T5-test-gaps.md."

T6 prompt: "You are task T6 in the auth-refactor DAG.

  Your role: Draft a step-by-step refactor plan — what changes in what order,
  which files are affected, what can be done without breaking the existing auth
  flow, and what needs a migration or feature flag.

  Not your role: Do not identify test gaps (that's T5). Do not implement
  anything — the main agent owns all code changes. Produce a plan only.

  Who depends on you: The main agent will use your plan as the implementation
  roadmap. Be specific about ordering constraints and backward-compatibility
  requirements.

  Read T3-token-lifecycle.md and T4-api-contract.md first.
  Write findings to .subagent-shared/auth-refactor/T6-refactor-plan.md."
```

**Wave 2 completes.** Main agent reads all output docs, synthesizes the final plan, and proceeds with implementation.

**Cleanup:**
```bash
rm -rf .subagent-shared/auth-refactor/
```

---

## Trust the work, verify the artifacts

A subagent's chat-style summary describes what it *intended* to do, not necessarily what landed on disk. When a subagent has produced an artifact — a shared output doc, a worktree edit, generated content — open the artifact and read it directly rather than trusting the subagent's prose recap. In a DAG, an under-delivered output doc in an early wave silently corrupts every downstream task that reads it as if it were complete; verify after each wave to catch gaps before they amplify.

### When a background agent fails

On a completion notification, verify the artifact first. If it's missing or under-delivered, retry **once** by continuing the same agent via `SendMessage` with a sharpened scope — don't spawn a fresh agent that lacks its context. If the retry also fails, rescope the task or escalate to the user. When 1 of N agents in a wave fails: verify and bank the N-1 good results, retry only the failed task, and don't block on it before reading the completed output docs. After an exhausted retry, the wave gate applies per-dependency, not per-wave: downstream tasks that depend on the failed output stay blocked (mark them `blocked` in the DAG table) until the rescope/escalation resolves, while downstream tasks with no edge to the failed task proceed normally.

---

## When subagents are efficient

- **Large data in → small output**: The core efficiency pattern. Subagent reads 10–50 files but returns a concise finding. Examples: "scan all models for field X, return which files have it", "read all 15 test files and summarize coverage gaps", "trace the call chain from endpoint Y to the database layer."
- **Embarrassingly parallel tasks**: Multiple independent investigations with zero data dependency. Examples: investigate frontend + backend + infra in parallel; check 5 different modules for the same pattern; validate 4 independent blast-radius areas of a refactor.
- **Multi-stage investigations with dependencies**: When the investigation has stages — initial discovery feeds into deeper analysis, which feeds into synthesis — use the DAG workflow to structure the work into waves. Each wave runs in parallel; context flows between waves through shared docs.
- **Broad exploration of unfamiliar territory**: When you don't know what's relevant yet, a subagent can explore broadly without filling the main context with dead-end reads. The subagent absorbs the noise; main context stays clean.
- **Well-scoped validation sweeps**: Clear objective, clear output format. "Find all callers of function X", "verify no remaining imports of deleted module Y", "list all files that reference config key Z."

## When NOT to use subagents

- **Trivial tasks (1–3 tool calls)**: If the main agent can grep one pattern or read one small file, just do it inline. Subagent spin-up cost exceeds the savings.
- **Simple sequential chains with no parallelism**: If task A → B → C is purely linear with no tasks that can run in parallel alongside them, doing the work inline avoids subagent overhead. (But if A and B are independent and only C depends on both, that's a DAG — use the workflow.)
- **Tasks requiring conversation context**: Subagents have no access to the parent conversation history. If the task needs user preferences, prior decisions, or evolving requirements from the chat, the subagent will miss critical context. Pass this context via the seed doc or subagent prompt instead.
- **Vaguely scoped tasks**: If you can't write a crisp one-sentence objective for the subagent, the results will be noisy and you'll redo the work anyway.
- **Reading files you're about to edit**: If you need `foo.ts` in your context to make an edit, read it yourself. Having a subagent summarize it just adds a lossy middleman.
- **N subagents doing the same prerequisite work**: If multiple subagents would each independently read the same files, deduplicate first — see "Share context through structured docs" above.
- **Overkill DAG planning for simple parallel work**: If you have 2–3 independent tasks with no inter-dependencies, just dispatch them. Don't build a DAG table for embarrassingly parallel work — that's overhead for no benefit.
