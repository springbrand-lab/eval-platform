# program

Manage and work **long-running, plan-driven programs** from any Claude Code chat. One command carries the whole
lifecycle: create a program for a new plan, list the programs that exist, pick and implement one ready work item
(recording the result on the board so the next session, human or agent, picks up from the board rather than from
chat history), and retire a finished program, deleting its docs behind a permanent tombstone.

## Modes

- **`/program <name> [item-id]`** — work an item (the default mode; the bulk of this doc). `<name>` is resolved
  per "Naming and resolution" below. With `[item-id]` (e.g. `S0.1`, `WS-0`), skip picking — but still verify the
  item's deps and gates; if unmet, say what's blocking and stop rather than implementing out of order.
- **`/program new <name>`** — create a program folder for a new program.
- **`/program list`** (or no arguments) — enumerate the programs with their one-line purpose, lifecycle state, and
  rough progress (counts by status), then ask which to work on.
- **`/program retire <name>`** — establish completion, then delete a finished program's docs, leaving a tombstone
  behind as the forwarding address.

## Where programs live

**v2 — all new programs:** one folder per program under `programs-v2-plans/`.

```
programs-v2-plans/
  README.md          # RESERVED. Pointer, templates, the migration + resurrection procedures.
  _archive/          # RESERVED. One tombstone per retired program; permanent, never deleted.
    README.md        #   tombstone format + the 9-section template
    <name>.md
  <name>/            # one live program; lowercase kebab-case
    STATUS.md        # REQUIRED — YAML frontmatter manifest + the board
    PLAN.md          # REQUIRED in practice — the spec. BINDING.
    DECISIONS.md     # optional — recorded decisions. BINDING.
    FINDINGS.md      # optional — research / verified file:line maps. CONTEXT.
    notes/           # optional, flat, no schema. CONTEXT.
```

**Bindingness is carried by filename**, not by directory and not by a manifest field: `PLAN.md` and `DECISIONS.md`
bind, and an implementer may not deviate from them; `FINDINGS.md` and `notes/**` are context — read for *why*,
never as spec. `STATUS.md` is the only hard requirement (`PLAN.md` is required in practice because `/program new`
refuses to create a board for a plan that does not exist). **Never create empty placeholder files** — an empty
`DECISIONS.md` makes the reading order ambiguous, which is worse than the file's absence.

1. **One program per folder. No nested programs.**
2. **Nothing inside a program folder may be read or executed by code, CI, a workflow, or another slash command.**
   That invariant is what makes retirement a safe `rm -rf`. A program that needs a script puts it where scripts
   live (`scripts/`, `deploy/…`) and links to it.
3. **Reserved names:** `README.md` and `_archive/`, at the v2 root only. Discovery excludes `_archive` **by exact
   name**, never by an `_` pattern. Any other v2-root entry that is not a conforming program folder surfaces as
   `MALFORMED` — loud, never silently dropped.
4. **Link rule.** Sibling links inside a folder are bare-relative (`[plan](PLAN.md)`); links to anything outside it
   are repo-rooted (`deploy/k8s/litellm-proxy/`). **`../` is banned** — it is the one form that breaks silently
   when a folder is moved or retired.
5. **A program may own files outside its folder**, declared under `external:` and linked repo-rooted. A
   **program-exclusive doc** lives in the folder and dies with it. An **operational artifact** (a runbook, a
   `deploy/` installer) **stays put**: it outlives the program by design, so it goes under `external:` and into the
   tombstone's "Living artifacts" table. A **shared doc** cited by two programs belongs to whichever program owns
   it, and the other links it repo-rooted — **program folders are not disjoint.**

**The manifest is YAML frontmatter on `STATUS.md`**, not a sidecar file. Identity and lifecycle only:

```yaml
---
name: activity-tracking-update      # == the folder name. Canonical invocation. Frozen.
title: Activity Tracking Update
purpose: Normalize KoloClaw activity tracking onto the append-only table.
state: active                       # active | paused | complete   (REQUIRED)
aliases: [atu, activity-tracking]   # extra names /program <name> accepts. Default [].
owner: wwerst
started: 2026-07-13
# blocked_on: "LCM Phase B"         # REQUIRED when state: paused
# completed: 2026-07-17             # REQUIRED when state: complete
# external:                         # optional — paths this program OWNS outside the folder
#   - deploy/k8s/litellm-proxy/
---
```

**Format:** a strict flat subset of YAML — `key: scalar` and `key: [a, b]` only. No nesting, no anchors, no
multi-line scalars. The format is the guardrail: it makes the manifest physically incapable of growing a nested
`items:` tree.

> **Anti-drift rule.** The frontmatter carries **identity and lifecycle only**. It MUST NOT contain item statuses,
> progress counts, PR numbers, or dates other than lifecycle dates. **If a fact changes when an item's PR merges,
> it belongs on the board, not in the frontmatter.** A normal work-an-item PR does not touch the frontmatter at
> all. If you are editing it in Step 5, stop — you are storing state the board already owns.

**v1 legacy boards** live at `docs/plans/<PROGRAM>_STATUS.md` with their plan docs beside them. They are **fully
supported through every mode of this command: no migration required, no deadline.** Do not create new ones.
Migration is opt-in, and a completed v1 program can be retired in place without ever being migrated.

## Board contract (v1 and v2, identical)

The board is the **single source of implementation state**. Specs stay in the plan docs the board links to — the
board tracks state, slots, and gates only. This contract names no path, so it governs
`docs/plans/<PROGRAM>_STATUS.md` and `programs-v2-plans/<name>/STATUS.md` identically. v2 is a *location* change,
never a format change. A conforming board has, at minimum:

1. A **header** stating purpose and which plan docs carry the specs.
2. A **Program conventions** section — the program-specific rules that bind implementation (source-doc reading
   order, house rules, flag/rollout discipline, who runs what, branch naming). *The command is generic; the
   conventions section is where a program's specifics live.*
3. An **Item status** table: `id | status | PR/refs | notes`, using the standard statuses: `not-started →
   in-progress → in-review (PR#) → landed → shadow@<envs> → enforced@<envs> → done` (or `parked`). **`in-review
   (PR#)` is written only by a board edit that lands SEPARATELY from the item's own PR** (e.g. another session
   noting an in-flight PR). The item's own PR always writes the post-merge state — see Step 5.
4. A **Board changelog** (append-only).

Optional but recommended: a **"Start here" / ready-set** section, a **task graph** (mermaid), **WIP/slot
trackers**, and **flag × env ledgers**. If present, they bind.

> **Tolerance.** The `id | status | PR/refs | notes` table is the *default* shape, not a requirement. Real boards
> carry extra columns (`item`, `deps`, `thread`, `slot?`, `owner-run`), split into several tables by phase or
> sub-program, or replace the table entirely with phase sections plus a PR ledger. Known-good deviations:
> `KOLOCLAW_REWRITE` (two sub-programs, two tables), `KOLO_ORG_EGRESS_VPN` (five tables under `###` sub-headings,
> four column sets), `LINQ_V3_MIGRATION` (PR-keyed, not item-keyed, with a findings register in the same section),
> `LOSSLESS_CLAW` (phase-structured, no item table at all), `SILENT_CONTEXT_INJECTION` (`merged` status).
> **Whatever shape a board has, it binds — read it; do not restructure a board you are only passing through.** A
> board rewrite is its own change, agreed with the program's owner. Likewise the status ladder is a default: if a
> board's header states its own legend, that legend wins.

> **Two formatting constraints.** Progress counts are derived by scanning item-row cells for a status token, never
> by column position. So: (1) **never put a bare status word in a non-status cell of an item row**; and (2) **keep
> the item table(s) under a level-2 `## Item status` heading** — `###` sub-headings inside that section are fine
> and are used by two boards today. Declared vocabulary extensions (`verified@<env>`, `deployed@<env>`, `merged`,
> `dropped`) are legal when the board's header declares them; undeclared ones are drift. Counts are
> **approximate**: a board that keeps a findings or scope register inside `## Item status` has those rows folded
> into its counts. Render them with a `~` and never gate a decision on them — open the board.

## Naming and resolution

`<name>` is **lowercase kebab-case**, `^[a-z0-9]+(-[a-z0-9]+)*$` — simultaneously the folder name, the canonical
invocation, and the tombstone filename. `resolve(arg)` runs first in EVERY mode. **No tier may short-circuit:**
build the full candidate universe across BOTH spaces before any tier can hit, or the split-brain STOP below is
unreachable.

```
STEP 0 — NORMALIZE arg: lowercase; '_' -> '-'; trim; whitespace -> '-'; drop a trailing '-status'.
STEP 1 — BUILD THE UNIVERSE (always both spaces, always complete):
  V2 = each dir D in programs-v2-plans/*/ except _archive:
         { name: basename(D), aliases + title from D/STATUS.md frontmatter }
  V1 = each F in docs/plans/*_STATUS.md whose line 1 is NOT a migrated-to marker:
         { stem: basename minus _STATUS.md, name: normalize(stem), title: line 1 minus '# ' }
STEP 2 — MATCH, in tiers. Within a tier, DE-DUPLICATE candidates by resolved program before counting
  (an arg matching both a folder name and that same folder's alias is ONE candidate).
  T1  exact on a V2 name or V2 alias
  T2  exact on a V1 normalized name
  T3  unique PREFIX over {V2 names} U {V2 aliases} U {V1 names}
  T4  unique SUBSTRING over the same set
  T5  unique case-insensitive SUBSTRING over {V2 titles} U {V1 titles}
  T6  archive: test -f programs-v2-plans/_archive/<normalized>.md
        -> print the tombstone summary; ask whether to resurrect
  T7  no match -> run /program list and offer /program new <name>
  In T1-T5: exactly one candidate -> hit, and SAY which and why before proceeding.
            two or more -> AskUserQuestion listing each with its purpose.
STEP 3 — BOTH-EXIST ARBITRATION whenever the resolved program has BOTH a V2 entry and a matching V1
  entry (table below).
```

T3-T5 are what keep short forms working on the unmigrated v1 boards (`/program koloclaw`, `/program linq-v3`, and
title-only matches like `/program lcm`). T6 is why a retired program's name never silently 404s.

**The `migrated-to:` stub marker.** A migrated v1 board is replaced in place by a redirect stub whose **line 1** is
`<!-- migrated-to: programs-v2-plans/<name> -->`. The marker is legal on line 1 and nowhere else, and every test is
line-1-anchored: `head -1 "$f" | grep -q '^<!-- *migrated-to:'`. **Never use `grep -L 'migrated-to:'` on file
contents** — a board that merely *mentions* the string (a migration-PR changelog line, a "v2 deferred" note) would
vanish from both `/program list` and resolution, after which `/program <that name>` offers `/program new` and
scaffolds a duplicate board for a live program.

**Liveness test for a v1 file:** a v1 board is LIVE if it has a `## Item status` heading **OR** a `## Board
changelog` heading **OR** is more than 100 lines. Three-way because one board of the 13 has no `## Item status`
section yet is ~1000 lines and very much live; a one-way test would classify it as a stub and silently write into
the wrong board.

| v1 file state | outcome |
|---|---|
| line 1 carries the marker | Normal. Not in the universe at all; use v2 silently. The stub exists so source comments, runbooks, and other slash commands keep resolving. |
| no marker, and NOT live | A malformed stub. Use v2, and say out loud that the stub needs its line-1 marker added. |
| no marker, and LIVE | **STOP. Report split-brain.** Two live boards for one program is a data-integrity bug; guessing which is authoritative is exactly how a session writes an item's result into the board nobody reads. |

## Discovery and mode: list

```bash
# 1. v2 programs: ONE call yields folder identity AND the manifest for every program.
#    /dev/null forces the "==> path <==" header even when exactly one file matches.
head -n 20 programs-v2-plans/*/STATUS.md /dev/null 2>/dev/null

# 2. v2 folders present, so malformed ones can be NAMED rather than lost (exact-name exclusion).
ls -d programs-v2-plans/*/ 2>/dev/null | grep -v '^programs-v2-plans/_archive/$'

# 3. v1 legacy boards, live ones only. Line-1 anchored — do NOT use grep -L.
for f in docs/plans/*_STATUS.md; do
  head -1 "$f" | grep -q '^<!-- *migrated-to:' || echo "$f"
done

# 4. v1 titles and purposes (v2 purposes already came from step 1).
head -n 12 <the step-3 files> /dev/null

# 5. Progress counts. TWO separate calls — a combined glob dies when v2 is empty.
awk -f .claude/scripts/program_counts.awk programs-v2-plans/*/STATUS.md 2>/dev/null
awk -f .claude/scripts/program_counts.awk docs/plans/*_STATUS.md 2>/dev/null

# 6. Retired programs (the archive IS the index; there is no index file).
ls programs-v2-plans/_archive/ 2>/dev/null | grep -v README

# 7. Stray FILES at the v2 root. Steps 1-2 match directories only, so without this a stray
#    file is invisible — and rule 3 promises nothing there is ever silently dropped.
ls -p programs-v2-plans/ 2>/dev/null | grep -v '/$' | grep -v '^README.md$'
```

**Do NOT glob `docs/plans/*.md`** — that directory also holds ~91 plan docs, PRDs, postmortems, discovery docs, and
design reviews that are not programs. **Empty or non-zero is not failure here:** while no v2 program exists, steps
1, 2, 6, and 7 are empty (step 1 prints a bare `==> /dev/null <==` header, which means zero v2 programs, not a
malformed entry) and step 5's v2 call exits non-zero on the unexpanded glob. Do not run these under `set -e`. Then
assemble:

- For each v2 folder, parse the frontmatter. **MALFORMED** = no `STATUS.md` **OR** no parseable frontmatter **OR**
  `state:` absent or not in `{active, paused, complete}`. Anything step 7 returns is MALFORMED too (a file at the
  v2 root is not a program). A malformed entry is **always named with its specific defect, never silently
  skipped** — `/program list` is the only validator this design ships. Otherwise group by `state:`.
- Every live v1 board is a **first-class program row**: `[v1]` is a per-row tag, not a bucket. **A v1 board is
  `active` unless it carries the completion banner** — `> **COMPLETE - <date>.**` on the first line after the `# `
  title, written by retire Phase A, which puts it in COMPLETE. That banner is the *only* v1 completion evidence
  there is: never infer state from changelog prose or from all-items-looking-done, which would gate work
  differently in two sessions reading the same board.
- **Purpose line, v1:** take the **first non-blank line after the `# ` title that is not itself a heading**,
  **skipping the `> **COMPLETE - <date>.**` banner if present** (it is a state marker, not a purpose — read it for
  the row's state, then take the next qualifying line), and
  stripping a leading `> ` and any bold-or-plain `Purpose` / `Program` lead-in with its trailing punctuation
  (`**Purpose:**`, `**Purpose.**`, `**Purpose**:`, `Purpose:`, `Program:` — all five occur today). Do not grep for the word
  "purpose" — one board of the 13 has no such string near its top (it says `Program:`). Truncate to ~60 chars.
- Counts come from step 5. `NO-ITEM-STATUS-SECTION` renders as `phase-structured — open the board`;
  `NO-ROWS-PARSED` renders as `counter returned no rows — investigate`. Never collapse these two into one message.
- **Cross-check:** test every live v1 name against every v2 name and alias. A collision is split-brain — surface it
  here loudly, do not wait for someone to invoke that program.

```
ACTIVE (workable now)
  koloclaw-rewrite   [v1]  KoloClaw rewrite + ZFS shards  ~69 not-started · 7 landed · 1 in-progress
  spend-guardrails   [v1]  Per-org spend caps             ~12 not-started · 7 in-review · 3 parked
  lossless-claw      [v1]  LCM context-engine re-enable   phase-structured — open the board
  …
PAUSED (blocked, do not start)    <v2 state: paused, showing blocked_on:>
COMPLETE (awaiting retirement)    <v2 state: complete, showing completed:>  → /program retire <name>
MALFORMED (fix or remove)         programs-v2-plans/foo/   no STATUS.md

0 retired — ls programs-v2-plans/_archive/
13 programs (13 v1 legacy boards, 0 v2). Legacy boards are fully supported; no migration required.
```

Then ask which to work on, recommended pick first, never recommending a `paused` or `complete` program.

## Mode: new — create a program

`/program new <name>` scaffolds `programs-v2-plans/<name>/`. **New programs never land in `docs/plans/`; there is
no `--v1` escape hatch.**

1. Normalize `<name>` to kebab. **Collision-check** against v2 folder names, all v2 aliases, normalized live v1
   stems, **and `_archive/`** — reusing a retired name breaks archive resolution for the old one. Refuse and ask
   for a different name.
2. **Ask which plan doc(s) carry the specs** (or take them from the invocation). Read them. **If there is no
   written plan yet, stop** — a board tracks a plan; write the plan first.
3. **Ask the user for `aliases:`.** The name is a permanent identifier; coining short forms up front is the
   10-second conversation that prevents a `koloclaw` / `KOLOCLAW_REWRITE` mismatch.
4. `mkdir -p programs-v2-plans/<name>`. If the plan doc already exists and is program-exclusive, `git mv` it to
   `<name>/PLAN.md` (history follows the file) and leave a redirect stub at the old path if anything links it.
   **If the plan doc has inbound references from outside `docs/plans/`, do not move it** — leave it and list it
   under `external:`. Otherwise write `PLAN.md` fresh.
5. **Extract the work items and dependency edges from the plan text** (deps columns, phase/wave rosters, gate
   language). Do not invent edges. For large plans (>~20 items), fan the extraction out to subagents and
   adversarially spot-check a sample of edges against the doc before trusting the graph.
6. **Write `STATUS.md`** — start from the ready-made skeleton in `programs-v2-plans/README.md` §Templates, not from
   a v1 board: frontmatter (`state: active`) + the board per the contract above, every item seeded
   `not-started` (or the real status if work already shipped — check `git log`/merged PRs), a mermaid task graph if
   the plan has non-trivial dependencies, slot/flag ledgers if the program uses them. Keep the item table(s) under
   a level-2 `## Item status` heading.
7. **Write the Program conventions section with the user** — this is judgment, not extraction: reading order,
   rollout ladder, credential boundaries, test commands, branch naming (`<initials>/<item-id>-<slug>` is the house
   default). Ask rather than guess.
8. Link the board from the plan doc, commit on a feature branch, and open a PR. From then on `/program <name>`
   works for this program.

Reference implementation: `docs/plans/UNREAD_BADGE_SLACK_STATUS.md` — **a v1-layout board: copy the board body,
not the path or the layout.**

## Mode: work an item

### Step 0 — Resolve the program

`resolve(<name>)` per "Naming and resolution", including both-exist arbitration. Then:

- **v2 hit** → `PROGRAM_DIR=programs-v2-plans/<name>/`, `BOARD=$PROGRAM_DIR/STATUS.md`. BINDING:
  `$PROGRAM_DIR/PLAN.md` and `$PROGRAM_DIR/DECISIONS.md` (if present). CONTEXT: `$PROGRAM_DIR/FINDINGS.md`,
  `$PROGRAM_DIR/notes/**` — read on demand only. `ls $PROGRAM_DIR` is the complete roster of what the program owns
  locally.
- **v1 hit** → `BOARD=docs/plans/<STEM>_STATUS.md`. BINDING: whatever the board header links or names in prose —
  v1 has no fixed plan filename, so mine the header.

Lifecycle guard. **v2** reads the frontmatter: `state: paused` → say what `blocked_on:` names and ask before
proceeding; `state: complete` → say so and ask whether the user means a follow-up or a retirement. An archive hit
→ print the tombstone and offer resurrection. **v1** has exactly one lifecycle signal, the retire-Phase-A banner
`> **COMPLETE - <date>.**` on the first line after the title: present → treat as `complete` and ask the same
question v2 asks; absent → proceed as active. **Never infer v1 state from anything else** — not changelog prose,
not "every row looks terminal". v1 has no `paused` state; a v1 program the user wants paused says so in its
Program conventions, which you are reading anyway.

Everything below is path-free: it speaks of "the board" and "the binding plan docs", and applies to v1 and v2
identically.

### Step 1 — Gather context

- Read the board. Note: ready set, open slots, in-flight items, standing gates, and
  the Program conventions. Boards are meant to stay small, but the oldest run ~1000
  lines — on those, read the conventions, the standing gates, and the current phase's
  sections in full rather than skimming the whole file.
- Freshness check: `git fetch origin` and compare the board against reality — merged
  PRs still shown `in-review`, landed flags not reflected, items done on the default
  branch but not on the board. **If stale, fix the board first** (same PR as your work
  or a small standalone one) — a wrong board poisons every later session.
- Read the chosen/candidate items' full spec rows in the owning plan doc, AND their
  dependencies' rows. Do not re-derive program strategy: if the plan has a decisions
  log, it is binding — when your implementation instinct contradicts a recorded
  decision, surface the tension instead of silently deviating.

### Step 2 — Pick what to work on

Compute candidates in this priority order:

1. Items whose dependencies are satisfied and whose phase/wave gate is open,
   preferring the current phase's order. **A dependency is satisfied at the state the
   dependent item actually needs** — some deps need merely `landed` (the code/schema
   exists), others need `shadow@env` or `enforced@env` in the specific environment;
   the plan row's deps column and the board's gate notes say which. Do not require
   `done` when `landed` suffices, and do not treat `landed` as enough when the plan
   says "enforced in-env first".
2. Items the board marks exempt from slot/WIP budgets (measurement, schema-only,
   drafting) can start whenever deps allow.
3. Slot-consuming items need a free slot per the board's tracker and slot rules.
4. Respect every standing gate the board lists (entry criteria, refuses-to-enable
   rules, soak requirements).

Present 2–4 candidates with a recommendation (AskUserQuestion, recommended option
first) unless the item was passed as an argument. State for each: size, blast radius,
and what completing it unblocks.

### Step 3 — Implement

- Branch from fresh default branch, named per the program's conventions (default:
  `<initials>/<item-id-lowercase>-<slug>`).
- Follow the item's spec row **literally** — reviewed plans are the spec; do not
  "improve" scope mid-implementation. If the row is wrong or ambiguous against the
  actual code, STOP and surface it: the plan gets amended first, then implemented.
- The board's **Program conventions bind** (flag discipline, schema rules, rollout
  ladder, audit requirements, credential boundaries). Repo-wide rules (`AGENTS.md`,
  `.claude/rules/`) still apply on top.
- Anything requiring credentials/environments the agent lacks: implement + test what
  you can locally, then hand the user the exact commands and wait for their output.

### Step 4 — Verify

- Run `pre-commit run`; run the test suite the conventions name (e.g.
  `./run_tests.sh` for Python changes). Report results faithfully — a red test is a
  stop, not a footnote.
- Walk the item's acceptance criteria; list what passed locally vs what needs an
  owner-run step (with exact commands).

### Step 5 — Record and hand off

In the SAME PR as the code:

- Update the item's board row (`status`, `PR`, date) and any slot/ledger the item
  affects; append a line to the board changelog.
- **On a board with no item table, record in that board's own shape** — tick its
  checklist box, append to its PR ledger, update its phase section — plus the
  changelog line. Never add a column, or invent a table, that the board does not
  have; the board's shape binds (see the Tolerance note).
- **Write the row as it will be true the moment THIS PR merges** — the board edit
  rides the PR, so the merged board must be accurate without a follow-up commit.
  Concretely: an item whose code is complete in this PR is written `landed (PR#,
  merged <date>)`, NOT `in-review (PR#)` — a row that says "in-review" merges
  stale by construction and poisons the next session's freshness check. (This is
  self-correcting in both directions: if the PR is abandoned, its board edit dies
  with it.) States the PR cannot deliver by merging — `shadow@env`, `enforced@env`,
  `done` gated on owner-run steps — are still written at the highest state the
  merge itself achieves, with the remaining steps in the notes.
- Append one row to the owning plan's progress log if the program keeps one (never
  rewrite history).
- **Leave the v2 frontmatter alone** — a work-an-item PR changes board state only.

Then commit, push, and open the PR against the default branch
(`/create-pull-request`), with a test plan naming the owner-run steps. Finish the chat
by stating: what landed, what the owner must run, and which items the board now shows
as unblocked.

## Mode: retire — complete, then delete

> **Governing principle: paths in this system are never deleted, only shortened into redirects.** A migrated v1
> board becomes a stub; a retired folder becomes a tombstone; a resurrected tombstone becomes a forward pointer.
> The only thing ever truly `rm -rf`'d is a folder whose forwarding address already exists.

**Phase A — establish completion.** If the program is not already `complete`:

1. Read the board and confirm **every** item is terminal. Terminal means `done`; or `landed` where the program's
   ladder ends at landed; or `dropped`; or `parked` **with an explicit will-not-do note**; or `parked` **deferring
   future scope**, which is terminal ONLY IF the tombstone's "Loose ends" section records the row **verbatim** —
   otherwise STOP and ask the owner. A `parked` item blocked on **live external work is not terminal**. **This is a
   checklist a reader walks, not a parser** — several boards would defeat any parser, and a wrong automated verdict
   here deletes a live program.
2. Confirm with the user, then record completion. **v2:** set `state: complete` and `completed: <date>` in the
   frontmatter and append a board changelog line; **do NOT add a body banner** — the frontmatter is the single
   source, and a banner is a third copy that resurrection forgets to clear. **v1** (no frontmatter exists): add a
   `> **COMPLETE - <date>.**` banner as the first line after the `# ` title, and append a board changelog line;
   **do not invent YAML frontmatter on a v1 board** — it breaks the v1 purpose-line read and creates a file that
   arbitration never anticipates.
3. **Delete nothing.** Stop and report. Completion and deletion are different days.

**Phase B — retire.** Three hard gates: **G1** every item terminal, *recorded on the board* (frontmatter for v2,
banner for v1); **G2** no open PR touches the program (`gh pr list --state open --json number,title,files`, grepped
for the folder path / the board stem); **G3** the inbound sweep is clean. Then, in **one** PR titled
`program: retire <name>`:

```bash
git rev-parse HEAD                              # 1. last_full_sha — capture BEFORE deleting
$EDITOR programs-v2-plans/_archive/<name>.md    # 2. tombstone (template in _archive/README.md)
git rm -r programs-v2-plans/<name>/             # 3. the one-command win (v2)
                                                # 4. repoint every inbound reference from G3
```

**The inbound sweep (G3) is the gate that actually matters.** Sweep on **paths and name spellings, not on the kebab
name**: for `activity-tracking-update` the kebab grep returns 25 unrelated code identifiers and **zero** of the
four real references, which cite `ACTIVITY_TRACKING_UPDATE_PLAN.md` from `cc_db/` source and an alembic comment.

**Sweep on every stem the program ever had, not just its current one.** A program that was migrated to v2 still
has inbound references naming its old `docs/plans/<OLD_STEM>_*` paths — that is the entire reason its redirect stub
is permanent — and the retire PR deletes that stub. Retiring on the kebab name alone leaves every one of those
references dangling. `NAME` is the kebab name (empty for a never-migrated v1 program); `STEM` is the legacy board
stem (empty for a program born in v2). A migrated program has **both**, and its old stem is recorded on the
tombstone's "Was:" line — set both before sweeping.

```bash
NAME=activity-tracking-update          # v2 folder name; empty if never migrated
STEM=ACTIVITY_TRACKING_UPDATE          # legacy board stem; empty if born in v2
for K in "$STEM"; do [ -n "$K" ] && grep -rni --exclude-dir=.git --exclude-dir=node_modules \
  -e "docs/plans/$K" -e "${K}_STATUS" -e "${K}_PLAN" -e "${K}_DECISIONS" -e "${K}_FINDINGS" \
  . | grep -v "^\./docs/plans/$K"; done
[ -n "$NAME" ] && grep -rni --exclude-dir=.git --exclude-dir=node_modules \
  -e "programs-v2-plans/$NAME" . | grep -v "^\./programs-v2-plans/$NAME"
```

Triage every hit into exactly one bucket; the sweep is not clean until every hit is in one. (1) **Rewrite** → point
it at `programs-v2-plans/_archive/<name>.md`; this is the default for docs, runbooks, slash commands, and source
comments, because a tombstone link says what shipped rather than what was intended. (2) **Drop** → incidental prose
in another program's changelog; leave it, a dead name in a historical entry is honest. (3) **Blocks retirement** →
something actively depends on the plan's content; fix that first. **Scope rule:** the sweep is about **path
references** — a mention of an item id or a feature name that does not cite a deleted file path is not a hit and
does not block retirement. **A retire PR that leaves a dangling path reference does not ship.**

**Retiring a v1 program in place is the day-one win.** A completed v1 program does **not** need migration to be
retired; the archive serves v1 directly. Write the tombstone (its "Was:" line and its recovery commands cite the
`docs/plans/` paths), then enumerate and delete only the satellites that exist:

```bash
ls docs/plans/${STEM}_*.md          # the real roster — satellite sets differ per program
git rm docs/plans/${STEM}_STATUS.md docs/plans/${STEM}_PLAN.md   # …only the ones ls listed
```

**Never brace-expand the satellite names** (`_{STATUS,PLAN,DECISIONS,FINDINGS}.md`): only one of the 13 boards has
all four, so `git rm` aborts with `did not match any files` and deletes nothing. Verify each listed satellite
belongs to this program and no other before removing it — `docs/plans/` satellites are shared and cross-linked —
and run G1-G3 with `STEM` as the sweep key.

The tombstone is one permanent file at `programs-v2-plans/_archive/<name>.md`, never deleted; its 9-section
template lives in `programs-v2-plans/_archive/README.md`.

## Migrating and resurrecting

Migrating a v1 board to v2 is **opt-in and never required** — one program per PR, no deadline. The full migration
procedure and the resurrection procedure for a retired program live in `programs-v2-plans/README.md`.

## Anti-patterns (stop and ask instead)

- Implementing an item whose deps aren't satisfied "because it's easy".
- Flipping flags / enabling enforce modes ahead of the program's rollout ladder, even if the code is done.
- Editing plan docs to match the code (amendments go through the program's review process, not drive-by).
- Batch-implementing multiple slot-consuming items in one PR (breaks slot accounting and rollback).
- Writing `in-review (PR#)` in the item's own PR's board update — the row is stale the instant that PR merges;
  write the post-merge state (Step 5).
- Trusting the board over `git log` when they disagree — reconcile first.
- Creating a board for a plan that doesn't exist yet — `/program new` tracks plans, it doesn't write them.
- Deleting a program folder without writing its tombstone first. Git keeps the bytes; nothing keeps the *pointer*,
  and every inbound reference becomes a dangling path.
- Retiring a program whose inbound sweep is not clean, or that still has an open PR.
- Putting item statuses, progress counts, or PR numbers in the frontmatter. The board owns state; the frontmatter
  owns identity.
- Migrating a v1 board to v2 in order to delete it — `/program retire` works on v1 boards in place.
- Restructuring a non-conforming board while passing through it. Boards with phase sections, several tables, or
  their own status vocabulary bind as-is.
- Creating anything at the v2 root other than a program folder (or the reserved `README.md` / `_archive/`), or a
  program folder without a `STATUS.md`.
