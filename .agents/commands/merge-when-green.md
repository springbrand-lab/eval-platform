# merge-when-green

Monitor a PR until it is merge-ready, then merge it into `dev` immediately. Merge-ready means **all three gates** hold at once:

1. **Every CI check on the head SHA is green** — not just the `merge_ready` check the dev ruleset requires (skipped/neutral are fine).
2. **Greptile reviewed the head SHA with a confidence score >= 4/5.**
3. **The branch contains the latest `origin/dev` — required only for a migration-bearing PR** (one touching `cc_db/cc_db/alembic/`), mirroring `merge_ready`, which enforces freshness + a single alembic head for exactly that class and ignores freshness for every other PR, infra changes included (the dev ruleset has strict up-to-date OFF). For a non-migration PR the gate reports `behind_by` on its status line and does not block, so a fast-moving `dev` no longer costs it a CI cycle per merge. Set `FRESHNESS=always` in the Monitor command to restore the strict policy for one gate. A merge conflict always blocks. When freshness IS required and dev moves while waiting, merge `origin/dev` into the branch, push, and wait for the fresh checks — repeat until merged.

**Invoking this command IS the merge authorization.** Once the gates pass, merge without asking for further confirmation. Conversely, never merge while any gate fails — a failing gate is stop-and-report, not a judgment call.

Usage: `/merge-when-green [PR_NUMBER]` — defaults to the current branch's open PR.

## Requirements

- `gh` (authenticated) and `jq`, run from the repo working tree (the gate script resolves owner/repo from the checkout). Not usable in MCP-only environments.
- Same-repo PR branches only (no fork heads).
- This command never edits code. Fixing failures and addressing review feedback is `/pr-grind`'s job.

## Steps

### 1. Identify and validate the PR

- PR number from the argument; otherwise resolve from the current branch:
  `gh pr list --head $(git rev-parse --abbrev-ref HEAD) --json number --jq '.[0].number'`
- `gh pr view <N> --json title,state,isDraft,baseRefName,headRefName` — must be OPEN, not a draft, and based on `dev`. Any other base: stop and confirm with the user first.

### 2. Start the merge gate under Monitor

```text
Monitor:
  description: PR #<N> merge gate
  persistent: false
  command: .claude/scripts/pr-merge-gate.sh <N> 60
```

The script (`.claude/scripts/pr-merge-gate.sh <PR> [interval] [--once]`) polls every 60s, prints a status line when the composite state changes, and **exits with a decision code the moment a decision is needed** — the exit wakes you. Never sleep-loop or manually re-poll `gh pr view` between wakes (same rule as `/pr-grind`).

Env knobs (set in the Monitor command only on explicit user instruction): `GREPTILE_MIN=<n>` overrides the score threshold (default 4; `0` disables the Greptile gate); `REQUIRED_CHECKS="..."` overrides the checks that must be present on the head SHA before the gate can go green (default: `merge_ready`, the dev ruleset's sole required check); `FRESHNESS=always` makes any `behind_by > 0` exit 3 regardless of PR class (default `migration`: only a PR touching `cc_db/cc_db/alembic/` must carry the latest `dev`; an unreadable files list fails closed to "required").

### 3. React to the gate's exit code

| exit | RESULT | meaning | action |
| ---- | ------ | ------- | ------ |
| 0 | READY | all gates pass for the printed head SHA | merge now |
| 2 | BLOCKED | PR closed/merged/draft, or repeated API errors | read the message; "already merged" = done |
| 3 | NEEDS_DEV_MERGE | merge conflict, or behind dev on a migration-bearing PR (or `FRESHNESS=always`) | merge dev in, push, restart gate |
| 4 | CHECKS_FAILED | >=1 check failed AND every check has concluded | triage failures (below) |
| 5 | GREPTILE_LOW | latest score below threshold | stop and report |
| 6 | NO_GREPTILE | no Greptile run on head SHA, or no score comment | restart once if transient, else report |
| 10 | WAITING | `--once` recheck only: state changed under you | restart the gate (step 2) |

**exit 0 — READY → merge:**

1. Final recheck to guard the wake-to-merge window: `.claude/scripts/pr-merge-gate.sh <N> --once` — proceed only on exit 0; any other code, handle per this table.
2. Merge, pinned to the exact SHA the gate scored (the READY line prints the full `head=<sha>`):
   `gh pr merge <N> --merge --match-head-commit <full-head-sha>`
   Repo convention is merge commits — no `--squash`, no `--delete-branch` (branch cleanup is `/cleanup-my-branches`), no `--admin`. `--match-head-commit` makes the merge fail if anyone pushed after the recheck; treat that failure as exit 10. (Dev moving in the seconds between recheck and merge is an accepted residual race — the recheck makes the window a few seconds wide.)
   **Once the merge queue is enabled** (see the section below), this step becomes `gh pr merge <N> --merge --auto` instead — it enqueues rather than merges directly, and `--match-head-commit` is no longer the freshness mechanism for this path.
3. Confirm the merge. Direct-merge path: `gh pr view <N> --json state,mergeCommit` (state MERGED), report the merge commit SHA, done. Queue path (`--auto` enqueued): the PR stays OPEN while its queue entry builds, so do NOT treat a still-open state as failure. The Step 2 gate monitor is the WRONG wait mechanism here — it scores the PR's own head SHA, which is already READY, so it returns immediately and cannot see the queue's temporary merge-group run. Instead poll `gh pr view <N> --json state,autoMergeRequest` (≥60s interval, under a Monitor — never a sleep loop in the main thread) and wait for one of two outcomes: **state MERGED** (report the merge commit SHA, done), or **state still OPEN with `autoMergeRequest` gone null** — GitHub disabled auto-merge. That is NOT automatically an eviction: read the PR timeline to see WHY. A failed `merge_ready` merge_group run on the queue's temporary merge commit = a real **eviction** — diagnose that run's failure like any red check (it usually means a semantic conflict with a PR that merged ahead of this one), fix or re-merge dev, and re-enter the loop. No failed merge_group run in the timeline (operator cancelled auto-merge, the queue rule was removed/rolled back, or the enqueue itself failed) = the queue is out of the picture — re-verify the gates with a `--once` recheck and use the direct-merge path above. Either way, never fall through to `--admin` just because auto-merge dropped once.

**exit 3 — NEEDS_DEV_MERGE → update the branch, wait again:**

1. On the PR branch: `git fetch origin dev && git merge origin/dev --no-edit`. If the current checkout is on a different branch, do NOT switch it under the user — do the merge in a temporary worktree (`git worktree add <scratch-dir> <branch>`, merge, push, `git worktree remove`).
2. Conflicts: resolve simple ones (adjacent-line, no conflicting intent) and commit; for complex ones (overlapping logic or intent), stop and report — same classification as `/merge-review-loop`.
3. `git push`, then restart the gate (step 2). The push resets CI, so a fresh wait is expected.
4. **Max 5 dev re-merge cycles.** On a hot dev day the branch can ping-pong; after the 5th cycle, stop and report instead of looping forever.

**exit 4 — CHECKS_FAILED → read the failing names from the monitor output.** The gate only reports failures once every check has concluded, so you are always looking at the full picture. Strict up-to-date is OFF in the dev ruleset, so a behind-dev branch never blocks the ruleset's own merge decision — gate 3 above is this command's own advisory, gate-local policy, not a ruleset requirement, and it still applies here on a migration-bearing PR (or under `FRESHNESS=always`): if the detail also says the branch is behind dev on such a PR, never act on the stale head — for the label-family and flaky cases below, first merge `origin/dev` into the branch (the exit-3 procedure), apply the label (if applicable) **before** pushing, then push and restart the gate — one CI cycle covers both. Real failures are reported regardless of behind-ness:

- **Scratch label family (migration-bearing PRs only)**: on a PR that adds or touches a migration, the failures are limited to `scratch_label_gate` plus `migrate-db`/`deploy` failures whose logs show the label gate, and the PR lacks the `deploy-scratch` label → apply it: `gh pr edit <N> --add-label deploy-scratch`, then restart the gate. Applying the label deploys the PR to the **shared** scratch environment; `/pr-grind` Step 6a says to do this only when everything else is green, which the gate's full-picture guarantee has already established. A non-migration PR doesn't need the label to merge — `merge_ready` ignores `migrate-db`/`deploy` state when there's no migration, and the gate script mirrors that: on an unlabeled PR that touches no `cc_db/cc_db/alembic/` file, red `migrate-db`/`deploy`/`scratch_label_gate` checks are counted green when their only failed step is the label read — or, for `migrate-db`, its scratch freshness guard, which a stale non-migration branch trips after classification has already run (the status line names them as `ignored(label-gate/freshness-guard verified, non-migration PR)`), so such a PR reaches READY without the label and without a dev re-merge. Never apply the label just to turn those checks green on a non-migration PR — it deploys to shared scratch for nothing. Note the definitions differ in breadth: `merge_ready`, `scratch_label_gate`, and the gate script key on `cc_db/cc_db/alembic/` paths (any file there for the script; `versions/` for merge_ready), while `migrate-db`'s label read keys on `migration_diff`'s `touches_alembic`, which covers the whole alembic tree including `env.py` and `script.py.mako`. A PR that edits only `env.py` therefore still gets a red `migrate-db` without the label and is NOT carved out by the script (its files include an alembic path) — treat it as migration-bearing and label it. (`ci.yml`'s `migrate-db` also succeeds with `optin=false` on an unlabeled non-migration PR since 2026-08-26, so the red check itself is going away; the script carve-out covers runs from before that and the `scratch_label_gate` variants.)
- **Scratch `deploy` failures**: often shared-env clobber (another PR deployed over this one) rather than a real break. Re-run the failed job once — `gh run rerun <RUN_ID> --failed` — and restart the gate.
- **Clearly infra-flaky** (runner lost, network timeout, unrelated to the diff): `gh run rerun <RUN_ID> --failed`, at most once per check, restart the gate.
- **Real failures**: stop and report — the failing checks, a short excerpt (`gh run view <RUN_ID> --log-failed 2>&1 | tail -40`), and suggest `/pr-grind`. Never merge over a failing check.

**exit 5 — GREPTILE_LOW → stop and report.** Include the score and the concerns from the latest Greptile summary comment, and suggest `/pr-grind` or targeted fixes. Do not nudge `@greptile` for a better score and do not merge — a below-threshold score is a human decision point.

**exit 6 — NO_GREPTILE → check which case the message describes.** Either Greptile never registered a check run on the head SHA (so any score comment would be stale — the gate refuses to honor it), or it ran but posted no score. If the PR normally gets Greptile reviews and this looks transient (e.g. the run just hasn't registered yet), restart the gate **once**; if it recurs, stop and report — the user decides whether to merge without a fresh score (some PRs, e.g. promotion PRs, never get one).

**exit 2 — BLOCKED → read the message.** "already merged" means the work is done — report success and stop. Closed / draft / auth problems: report.

**exit 10 — WAITING** (only from the `--once` recheck, e.g. a push landed in the wake-to-merge window or the head moved mid-evaluation): restart the gate (step 2) and wait for fresh checks.

### 4. Report

Keep it short: outcome (merge commit SHA, or the blocking reason), dev re-merge cycles used, final check summary, Greptile score.

## Once the merge queue is enabled

Everything above describes today's pre-queue merge path. `docs/MERGE_QUEUE_DESIGN.md` is the approved design; the ruleset edit that actually turns the queue on is an operator-run step, not something this command or its caller does. Once that ruleset edit lands (a `merge_queue` rule added to the `dev` ruleset, per the design's rollout plan), the mechanics of "how a green PR actually merges" change:

- **`gh pr merge <N> --merge --auto` enqueues the PR** rather than merging it immediately — this becomes the normal step 2 action above (replacing `--match-head-commit`). The queue itself performs the final merge once its own required-check set (`merge_ready`, evaluated against the queue's temporary merge commit — PR head + current `dev`) goes green. A PR sitting "green" in the PR list may still be waiting in queue position; the merge timestamp is no longer synchronous with "checks went green."
- **This command's gate stays useful.** Everything it polls for — all checks green, Greptile >= threshold, branch contains latest `dev` — is still the right bar to clear *before* enqueueing. The queue does not replace pre-merge review or Greptile; it replaces the final `--match-head-commit` merge step and the freshness role that step's pinning used to serve.
- **`REQUIRED_CHECKS` note.** The ruleset flip to require `merge_ready` alone (see the Notes section below) is a separate, already-planned change from the queue rule itself — don't assume one implies the other happened; check both independently before assuming this command's `REQUIRED_CHECKS` default is stale.
- **`--admin` is demoted to an escape hatch, not eliminated.** With the queue live, `--admin` bypasses the queue entirely (subject to the ruleset's `bypass_actors`) — it is now also the way to skip a stuck/broken queue, not purely a way to skip required-check evaluation. It stays reserved for narrow cases: a migration PR where staleness is judged a real entry-ticket problem (not just a queue freshness question the queue itself already handles), and genuine emergencies. The standing "staleness-only admin merge" convention for ordinary, non-migration PRs is expected to retire once the queue has proven itself through its canary window — see `docs/MERGE_QUEUE_DESIGN.md` §5.3/§6 — because the queue's temporary-merge-commit build re-validates freshness automatically; a routine staleness-only admin merge after that point is a signal something's wrong with the queue, not a normal shortcut.

## Notes

- **`merge_ready` is the sole required check.** Ruleset 1913449 flipped on 2026-08-21: the dev ruleset now requires only `merge_ready` on the head SHA, with strict up-to-date OFF. `ci.yml`'s `merge_ready` job (fail-closed) asserts everything this command's gate polls for individually — `check_branch`/`test`/`docker` green, and, for a migration-bearing PR whose base is `dev`, deploy's `rollout_succeeded`/`migrations_current` outputs (a migration-bearing promotion PR to staging/main gets that coverage from the dev-side apply instead), freshness against `origin/$BASE_REF`, and a single alembic head. A PR with no migration files ignores `migrate-db`/`deploy` state entirely — that migration/non-migration split is also why the `deploy-scratch` label is no longer required to merge a non-migration PR. That freshness/single-head coverage is for the CURRENT promotion flow (a `promote/*` snapshot-branch head); a LEGACY-style promotion PR whose head is literally `dev`/`staging`/`main` exits earlier, at the A5 same-repo fast-pass, before either check runs. This command's `REQUIRED_CHECKS` default is `merge_ready` alone, matching the ruleset.
- **All checks means all.** The dev ruleset now requires only `merge_ready`, so `gh pr merge` would succeed long before this command's gates pass. That's deliberate — don't take the shortcut.
- **Greptile freshness is enforced, not advisory.** Check runs are per-SHA, so every push resets the gate to pending, and the score is only honored when the head SHA's own "Greptile Review" run exists and is green — a score comment from an older SHA can never satisfy the gate (it exits NO_GREPTILE instead).
- **Post-push blind spot is covered.** Right after a push, fast workflows report before slow ones; the gate refuses to go green until `merge_ready` is present on the head SHA (`REQUIRED_CHECKS`), so "nothing pending" can't be mistaken for "everything passed".
- **Long waits are normal.** Full CI takes ~20+ minutes and Greptile re-reviews every push. Do other work or idle; the Monitor exit wakes you.
- If you abort the flow for any reason, stop the Monitor task (`TaskStop`) so it doesn't fire later.
- Never force-push, never `--admin` merge, and never edit code under this command. (Once the merge queue is enabled, `--admin` gains one narrow legitimate use — see the "Once the merge queue is enabled" section above — but it is still never this command's own default action.)
