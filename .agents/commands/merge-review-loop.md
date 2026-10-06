# merge-review-loop

Fetch the latest `origin/dev`, merge it into the current feature branch, resolve any conflicts, then run a full `/review-pr`. If the review finds issues, fix them, commit, push, and re-review. Repeat until the review is clean (zero 🔴, zero 🟡).

## Steps

1. **Fetch and merge:**
   ```
   git fetch origin dev
   git merge origin/dev --no-edit
   ```

2. **If merge conflicts exist:**
   - Classify each conflict: simple (adjacent-line, no conflicting intent) vs. complex (overlapping logic, conflicting intent).
   - Fix all simple conflicts. For complex conflicts, report them to the user and stop.
   - Run the relevant test suite to verify the merge didn't break anything.
   - Commit the merge resolution and push.

3. **If merge is clean (no conflicts):**
   - Run the relevant test suite to verify no regressions.
   - Push the merge commit (if one was created).

4. **Run `/review-pr`** against `origin/dev` using the full review-pr command protocol.

5. **If the review finds 🔴 Confirmed Issues or 🟡 Possible Risks:**
   - Fix each issue.
   - Run tests + pre-commit.
   - Commit with a descriptive message and push.
   - Go back to step 1 (fetch + merge again in case dev moved while fixing).

6. **If the review is clean (zero 🔴, zero 🟡):**
   - Report the final status to the user.
   - Stop.

## Notes

- Always push after every merge resolution and every fix commit — unpushed work doesn't exist.
- The test suite to run depends on the project area. For `deploy/koloclaw/`, it's `python3 -m pytest tests/test_layered_config.py tests/test_openclaw_config.py -v`. For other areas, check AGENTS.md.
- Don't force-push or amend commits unless explicitly asked.
- If `origin/dev` hasn't changed since the last merge, `git merge` will say "Already up to date" — that's fine, proceed to review.
