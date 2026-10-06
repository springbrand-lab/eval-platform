# create-pr-link

Fetch the latest `origin/dev`, merge it into the current branch, push, and output a clickable GitHub PR creation URL targeting `dev`.

## Steps

1. **Fetch and merge origin/dev:**
   ```
   git fetch origin dev
   git merge origin/dev --no-edit
   ```

2. **If merge conflicts exist:**
   - Classify each conflict: simple (adjacent-line, no conflicting intent) vs. complex (overlapping logic, conflicting intent).
   - Fix all simple conflicts. For complex conflicts, report them to the user and stop.
   - Commit the merge resolution.

3. **Push the branch:**
   ```
   git push
   ```

4. **Output the PR link in the chat response:**
   - Get the current branch name: `git rev-parse --abbrev-ref HEAD`
   - Print a clickable URL in this format:
     ```
     https://github.com/CarbonCoreAI/chocolate_chip/compare/dev...<BRANCH_NAME>?expand=1
     ```
   - **CRITICAL:** The URL **MUST** be provided directly in the chat message so the user can click it. Do not rely on tool outputs or PR creation tools alone — always include the URL as visible text in the chat response.

## Notes

- Always push before generating the link — unpushed commits won't appear in the PR.
- Don't force-push or amend commits unless explicitly asked.
- If `origin/dev` hasn't changed since the last merge, `git merge` will say "Already up to date" — that's fine, proceed to push and link.
