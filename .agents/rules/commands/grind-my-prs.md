# grind-my-prs

Grind the PRs assigned to me all the way to merged: gather PR context, validate and fix Greptile findings until the score is 5/5, and — when a PR contains DB migrations — split the migration into its own PR, get it approved and merged into `dev` first, then merge the feature PR.

This command composes existing workflows rather than replacing them:

- **The grind loop** (fetch feedback → critically validate → fix → iterate) is [`/pr-grind`](../skills/pr-grind/SKILL.md). Everything there applies — the multi-agent orchestration, the Step 2b critical evaluation of bot findings, the plan-and-confirm gate, the `pr-watch.sh` Monitor, the no-sleep-polling rule, and the loop harness (grind tracker + Stop guard).
- **The merge gate** is [`/merge-when-green`](merge-when-green.md)'s `pr-merge-gate.sh`, run with `GREPTILE_MIN=5` — this workflow's bar is a 5/5 Greptile score, stricter than the script's default of 4.
- **Migration hygiene** (models ↔ `db_interface.py` sync, `pytest cc_db/tests/test_schema.py`, never running alembic yourself) is [`/make-db-schema-changes`](make-db-schema-changes.md) and the `database-schema-migrations` rule.

**Invoking this command IS the merge authorization** (same contract as `/merge-when-green`): once a PR passes every gate below, merge it without asking again. The one thing that is never automated is the **migration approval issue** — see Step 5d.

Usage: `/grind-my-prs [PR number or URL ...]` — with no arguments, discovers open PRs assigned to me.

## Steps

### 1. Resolve the target PRs

- **Arguments given:** parse each as a PR number or URL (`gh pr view <arg> --json number,title,state`).
- **No arguments:** discover assigned PRs:
  ```bash
  gh pr list --assignee "@me" --state open --json number,title,headRefName,isDraft,baseRefName
  ```
- Skip drafts unless the user passed them explicitly as an argument. Only same-repo branches based on `dev`; anything else, stop and confirm.
- Present the worklist, then process **one PR at a time to full completion** (grind → gates → merge) before starting the next — with the single exception in Step 6 (feature-PR grinding may overlap the human wait on a migration approval). Track each PR as a chat task.

### 2. Get PR context

For the current PR:

- `git fetch origin`; check out the PR branch (`gh pr checkout <N>`) — refuse if the working tree is dirty.
- Read `gh pr view <N> --json title,body,files,comments,reviews` and skim the diff (`gh pr diff <N>`) to understand what the PR does.
- Start the change monitor immediately (pr-grind Step 1a): `Monitor` running `.claude/scripts/pr-watch.sh <N> 20`. This is the only sanctioned way to wait for reviews/CI throughout this workflow.

### 3. Classify: does the PR contain migrations?

```bash
gh pr view <N> --json files --jq '.files[].path' | grep '^cc_db/cc_db/alembic/versions/' || true
```

- **No migration files** → Step 4, then merge via Step 7. Done.
- **Migration files present, and the PR is *only* the migration** (migration file(s) + `cc_db/cc_db/models/` + `cc_db/cc_db/interface/` and nothing else) → no split needed; the PR *is* a migration PR. Treat it under Step 5c–5e (grind, label, human approval, merge).
- **Migration files present alongside feature code** → this PR must NOT be merged as-is. Go to Step 5 to split, then Step 6 to come back.

### 4. Grind to Greptile 5/5

Run the [`/pr-grind`](../skills/pr-grind/SKILL.md) loop on the PR:

- If Greptile has not reviewed the current head yet, wait for it via the monitor (its review triggers on push; `@greptile` comment to nudge if needed).
- **Validate findings before fixing** (pr-grind Step 2b): reject invalid ones with recorded rationale, fix valid ones, push, repeat.
- Target is **5/5**. If all findings are resolved and the score is still below 5, ask Greptile what's missing (`gh pr comment <N> --body "@greptile All review feedback has been addressed. What would it take to reach 5/5 confidence?"`) and act on the answer.
- pr-grind's iteration limits apply (5 external rounds); if the score stalls below 5 after that, stop and report rather than looping forever.

Bot-thread hygiene (field-tested on #9792/#9918/#10003, 2026-07-23):

- **Cursor Bugbot rides along.** Its findings get the same validate-then-fix-or-reject treatment as Greptile's. It does not reliably re-review on every push — nudge it with a `bugbot run` PR comment. It self-resolves a thread only when a later commit *changes the flagged code*; a finding rejected with rationale (no code change) will stay open through every re-review. Record the rejection as a reply inside the thread, get the user's sign-off on the rejection, then resolve the thread manually (GraphQL `resolveReviewThread`).
- **Greptile can confirm without resolving.** If its thread lingers after a 5/5 re-review, reply inside the thread tagging `@greptile` with exactly what changed — it re-checks and answers there. Once it has *confirmed in writing* that the concern is addressed, resolving the thread manually is bookkeeping, not masking; the no-manual-resolve rule exists for unverified fixes.
- **Merge bar: zero unresolved review threads.** Before acting on any READY gate, count unresolved threads (GraphQL `reviewThreads`, `isResolved == false`) and hold the merge while any remain. The Greptile score is a floor, not a license.

### 5. Migration split flow

When Step 3 found migrations mixed with feature code:

#### 5a. Create the migration branch from dev

```bash
git fetch origin dev
git checkout -b <initials>/<feature-slug>-migration origin/dev
```

(Branch naming per [`/git-new-feature`](git-new-feature.md): initials from `git config user.name`.)

Bring over **only** the schema change — the migration PR contains exactly:

- the migration file(s): `cc_db/cc_db/alembic/versions/<...>.py`
- the SQLAlchemy model changes: `cc_db/cc_db/models/` (usually `model.py`)
- the pydantic interface changes: `cc_db/cc_db/interface/db_interface.py`

```bash
git checkout <feature-branch> -- cc_db/cc_db/alembic/versions/<file>.py cc_db/cc_db/models/ cc_db/cc_db/interface/
```

If the models/interface diffs contain edits **unrelated** to this schema change (rare — model edits normally *are* the migration's cause), take only the schema-backing hunks (`git checkout -p`) and say so in the migration PR body.

**Leave the feature branch untouched.** Do not remove the migration or models from it — the feature code depends on the models, and after the migration PR merges to dev, merging dev back into the feature branch makes those paths drop out of the feature PR's diff on their own (Step 6).

#### 5b. Verify the split stands alone

- The migration must apply cleanly on top of dev's current alembic head. Derive the head from the **revision graph**, never from filename order — filenames carry their generation timestamp, and a re-parented migration keeps its old filename, so `ls | sort | tail` lies exactly when it matters. The head is the revision no other migration on `origin/dev` references as `down_revision` (tuple-aware for merge revisions):

  ```bash
  git grep -h -E "^(revision|down_revision)" origin/dev -- cc_db/cc_db/alembic/versions/ \
    | awk -F"['\"]" '/^revision/{r[$2]=1} /^down_revision/{for(i=2;i<=NF;i+=2) if($i!="") d[$i]=1} END{for (x in r) if (!(x in d)) print x}'
  ```

  Exactly one id must print — more than one means dev itself has divergent heads: stop and report. The split migration's `down_revision` must equal that id; if dev's head moved since the migration was generated, the migration needs re-parenting/regeneration — per `/make-db-schema-changes`, do **not** run alembic or `generate_migration.sh` yourself; give the user the exact command and wait.
- `pytest cc_db/tests/test_schema.py` (models ↔ interface consistency), then `pre-commit run --files <changed files>`.
- Commit, push, and open the migration PR against `dev` (per [`/create-pull-request`](../skills/create-pull-request/SKILL.md)). Body must state: *"Migration split out of #<feature-N> — merge this first."*
- On the **feature PR**: prepend a visible blocker line to the body (preserving human edits): *"⚠️ Blocked on migration PR #<M> — do not merge until it lands in dev."* Remove this line in Step 6.

#### 5c. Grind the migration PR

Run Step 4 on the migration PR (it gets its own Greptile review and must also reach 5/5 with green CI).

#### 5d. The migration approval gate — human-only

When the migration PR is otherwise merge-ready (grind clean, all pre-gate CI green), apply the `deploy-scratch` label — preferably by **ticking the gate-notice checkbox** rather than labeling by hand: PATCH the `github-actions[bot]` comment marked `<!-- scratch-label-gate-notice -->`, flipping the first `- [ ]` to `- [x]`.

```bash
# find the notice comment on the MIGRATION PR, flip its checkbox, PATCH the body back
gh api repos/<owner>/<repo>/issues/<M>/comments \
  --jq '.[] | select(.body | contains("scratch-label-gate-notice")) | .id'
gh api -X PATCH repos/<owner>/<repo>/issues/comments/<comment-id> -f body="<body with - [x]>"
```

The Scratch Label Gate Assist workflow reacts to the edit: it applies the label, rewrites the checkbox into a confirmation line, and does a **run-level re-run of the whole ci.yml run** — which is what actually deploys, since the skipped `scratch_optin`/deploy jobs only re-run on a full re-run (a "Re-run failed jobs" would green the gate but never deploy). Two field notes:

- The `issue_comment [edited]` event can take several minutes to reach the workflow — wait for it, don't re-tick.
- Hand-labeling still works as a fallback (`gh pr edit <M> --add-label deploy-scratch`; if that 500s on the projectCards GraphQL deprecation, use REST: `gh api repos/<owner>/<repo>/issues/<M>/labels -f "labels[]=deploy-scratch"`) — but labeling moments before a push races the assist's re-run against the push's fresh run in the per-PR concurrency group, and one cancels the other. Use the checkbox when no push is pending; if you must label by hand, label *before* the push so one CI cycle covers both.

This triggers the scratch deploy path: the `migrate-db` job classifies the pending migrations and opens a GitHub issue titled **"Approve Database Migrations for scratch (N pending)"**, pinging the approvers (`wwerst`, `carlodizon03`, `Pascal-Bliem`, `svott03`, `tsaow`).

- **NEVER approve this issue yourself.** The `gh` CLI is authenticated as the user, who is an approver — commenting "approve"/"lgtm"/"yes" via `gh` would technically work and is strictly forbidden. This issue is the human safety gate on live DB migrations.
- Surface the issue URL to the user and ask them to review the listed revisions and reply on the issue (any of trstringer/manual-approval's approve words: `approve`, `approved`, `lgtm`, `yes`). Deny words (`deny`, `denied`, `no`) cancel the run.
- Wait via the monitor — after approval, `migrate-db` applies the migration to the scratch DB and the run proceeds to green.

#### 5e. Merge the migration PR

Run the merge gate and merge (per `/merge-when-green`, but with the stricter score bar):

```text
Monitor:
  description: PR #<M> merge gate
  persistent: false
  command: GREPTILE_MIN=5 .claude/scripts/pr-merge-gate.sh <M> 60
```

On READY: final `--once` recheck, verify **zero unresolved review threads** (Step 4's merge bar), then `gh pr merge <M> --merge --match-head-commit <head-sha>`. Handle the other exit codes per the `/merge-when-green` table. (Once the merge queue is enabled, this becomes `gh pr merge <M> --merge --auto` — see `/merge-when-green`'s "Once the merge queue is enabled" section — but a migration PR still merges strictly first per the invariant below; the queue's own serialization only strengthens that ordering, it does not relax it.)

### 6. Return to the feature PR

Once the migration PR is merged into dev:

```bash
git checkout <feature-branch>
git fetch origin dev
git merge origin/dev --no-edit
```

- If git reports conflicts, resolve per path — the two kinds are not the same:
  - **The migration file itself**: take dev's copy wholesale (`git checkout origin/dev -- cc_db/cc_db/alembic/versions/<file>.py`) — the two copies should be identical and dev's is canonical.
  - **Models / interface files**: do NOT take dev's whole file. The feature branch may carry feature-only edits in the same files (only the schema-backing hunks were split out in Step 5a). Resolve hunk by hunk: dev's side for the schema hunks that went through the migration PR, the feature side for everything else. Afterwards sanity-check `git diff origin/dev -- cc_db/` — any remaining schema-shaped hunk that never rode the migration PR means the split was incomplete: stop and report.
- Push, then verify the split worked: `gh pr view <N> --json files --jq '.files[].path'` must no longer list any `cc_db/cc_db/alembic/versions/` file. If it still does, the copies diverged — reconcile to dev's version and push again.
- Remove the "⚠️ Blocked on migration PR" line from the feature PR body.
- The feature PR now has no pending migrations, so labeling it `deploy-scratch` later will NOT open an approval issue — `migrate-db` finds nothing pending.
- Re-run Step 4 on the new head (the merge-back produces a new Greptile review; the 5/5 bar still applies).

**Overlap allowance:** the wait in Step 5d is human latency. While waiting on the approval comment (and only then), it's fine to start Step 4's grind on the feature PR in parallel — but its merge stays strictly behind Steps 5e and 6.

### 7. Merge the feature PR

Same as 5e: when grind is clean, apply `deploy-scratch` via the gate-notice checkbox (Step 5d's procedure; only once otherwise merge-ready, per pr-grind Step 6a), run the merge gate with `GREPTILE_MIN=5`, verify zero unresolved review threads, merge with `--merge --match-head-commit`, confirm `state == MERGED`. A non-migration feature PR may now merge unlabeled — since the 2026-08-21 ruleset flip, `deploy-scratch` is required for merge only on migration-bearing PRs, so this step's labeling is optional pre-merge scratch verification for a feature PR with no pending migrations. Once the merge queue is enabled, the merge becomes `--merge --auto` (same note as Step 5e) — it enqueues rather than merges directly, and completion is confirmed per merge-when-green.md's queue path (poll state + autoMergeRequest; a still-open enqueued PR is not a failure).

Then pick up the next PR from the Step 1 worklist.

### 8. Report

Per PR, output:

```
## Grind Report — PR #<N> <title>
- Greptile: <score>/5 (rounds: <n>)
- Findings fixed / rejected: <n> / <n> (rejections rationale per pr-grind report format)
- Migration: none | split into PR #<M> (merged <sha>) | this PR was migration-only
- Approval issue: <url> — approved by <user>
- Merged: <merge commit sha>
```

## Hard rules

- **One PR at a time to completion** (except the Step 6 overlap allowance).
- **Never merge a PR that still contains migration files mixed with feature code.** The split is mandatory, not advisory.
- **Never comment approval on the migration approval issue** — surface it to the user, every time, even though the authenticated account is an approver.
- **Merge order is invariant:** migration PR → dev → merge dev back into feature branch → feature PR.
- **No sleep-polling.** All waiting happens under `Monitor` (`pr-watch.sh` / `pr-merge-gate.sh`).
- Repo merge convention: merge commits (`--merge`), no `--squash`, no `--delete-branch`. `--admin` stays off the normal path here too — once the merge queue is enabled, `--merge --auto` (which enqueues) is the normal action in Steps 5e/7; `--admin` is only the queue's escape hatch (migration-PR staleness where the migration is still judged valid, or a genuine emergency), never a routine substitute for waiting on the queue. See `/merge-when-green`'s "Once the merge queue is enabled" section.
- `pre-commit run` before every commit; `./run_tests.sh` after substantive Python changes.
