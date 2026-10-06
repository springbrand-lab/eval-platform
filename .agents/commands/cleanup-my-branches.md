# cleanup-my-branches

Identify, list, and (with the user's explicit confirmation) delete the user's stale remote branches.

This command is a safe wrapper around `scripts/cleanup_my_branches.py`. It NEVER deletes a branch
without first showing the user the full list and asking for confirmation. All analysis and deletion
is performed by the Python script — do **not** invent your own deletion logic.

## What counts as a "safe-to-delete" branch

A branch is safe to delete when ALL of the following are true:

1. It is not a base branch (`origin/dev` and `origin/main` by default).
2. It has no OPEN pull request.
3. The branch tip is older than `--min-branch-age-days` (default: 7).
4. AT LEAST ONE of:
    - It is merged into `origin/dev` or `origin/main`, OR
    - It has a PR that was MERGED at least `--min-pr-age-days` ago (default: 30), OR
    - It has a PR that was CLOSED at least `--min-pr-age-days` ago.

Branch ownership is matched by:
- Branch name prefix `<github-login>/`, OR
- Branch tip's author/committer email or name passed via `--also-match-email` / `--also-match-name`.

## Steps

### 1. Resolve the GitHub user

Default to the user owning the gh CLI session:

```bash
gh api user --jq '.login'
```

Fallback order if `gh api user` fails:
1. `KOLO_GITHUB_USER` env var.
2. `git config user.email` / `user.name` (use these as hints to ask the user).

If you cannot determine the user, **ask** the user for their GitHub login before continuing.
Do not guess.

### 2. Fetch & generate the deletion plan (no deletes happen here)

```bash
python3 scripts/cleanup_my_branches.py plan \
  --user <login> \
  --min-branch-age-days 7 \
  --min-pr-age-days 30 \
  --print-branches \
  --plan /tmp/branch_cleanup_plan.json
```

Optional: pass `--also-match-email "<email1>,<email2>"` and/or `--also-match-name "<name>"` to
catch branches the user owns that don't follow the `<login>/` prefix. Suggest this when you see
branches in the report whose names don't match the prefix but whose author email matches the user.

The script:
- Runs `git fetch origin --prune` (skip with `--no-fetch`).
- Reads all `refs/remotes/origin/` refs and their committer metadata.
- Calls `gh pr list` to load every PR's state and close/merge timestamps.
- Computes merge state against the configured base branches.
- Writes `/tmp/branch_cleanup_plan.json` containing both the **safe-to-delete** list and the
  **skipped** list (with reasons).

### 3. Show the plan and ASK for confirmation

Surface to the user, in chat:
- The total **safe-to-delete** count and breakdown by reason.
- The breakdown by age bucket.
- The full safe-to-delete list (or, if very long, the head and tail with a pointer to the JSON).
- The skipped count and reason breakdown (so the user can adjust thresholds).
- The exact path to the plan file: `/tmp/branch_cleanup_plan.json`.

Then ask the user **explicitly**:

> Should I delete these N branches? Reply with one of:
> - `yes` — delete all branches in the plan
> - `no` — abort
> - `edit` — adjust thresholds (e.g. only branches >30 days old) and regenerate the plan

**Do not proceed to step 4 without an explicit `yes` from the user.** Treat silence, "looks good",
or "go ahead with the safe ones" as ambiguous — clarify before deleting.

### 4. Apply the plan (deletes branches)

Only after explicit user approval:

```bash
python3 scripts/cleanup_my_branches.py apply \
  --plan /tmp/branch_cleanup_plan.json \
  --yes
```

The script runs `git push origin --delete <branch>` per entry, prints progress, and writes an
apply log to `/tmp/branch_cleanup_plan.applied.json`.

### 5. Report

Show the user:
- How many branches were deleted.
- Any failures (with the per-branch error from `git push --delete`).
- The path to the apply log.

## Critical rules

- **Never** delete a branch without showing the full list and getting an explicit `yes`.
- **Never** invent your own merge / PR logic — always use `scripts/cleanup_my_branches.py`.
- **Never** delete `origin/dev`, `origin/main`, or any base branch. The script already excludes these.
- **Never** force-delete or modify history on remote branches that aren't in the plan.
- If the user wants tighter or looser thresholds, regenerate the plan with adjusted
  `--min-branch-age-days` / `--min-pr-age-days` rather than hand-filtering the list.
- If a branch has any open PR, the script keeps it — don't override that.

## Common variations

- **Only branches older than 30 days, fully merged**: `--min-branch-age-days 30`.
- **Skip the fetch (offline / already fetched)**: `--no-fetch`.
- **Different remote** (fork workflow): `--remote upstream --base-branch upstream/main --base-branch upstream/dev`. The base-branch overrides MUST match the remote — the defaults (`origin/dev`, `origin/main`) won't match branches in `refs/remotes/upstream/`, which quietly disables the "merged into a base" detection path and skips more branches than intended.
- **Different base branches**: `--base-branch origin/main --base-branch origin/release`.
- **Match alternate emails**: `--also-match-email "alt@example.com,old@corp.com"`.
- **Different user**: `--user otherlogin`.

## Notes

- The plan file is the single source of truth for the apply step. Re-run `plan` if the user
  changes thresholds.
- The script paginates `gh pr list` results twice (descending and ascending) to work around the
  1000-row API cap. Repos with thousands of PRs per user may still need a stricter
  `head:<login>/` filter — the script already passes that.
- Tests / CI never call this command; it is interactive only.
