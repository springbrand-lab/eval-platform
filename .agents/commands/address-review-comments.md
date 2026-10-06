# address-review-comments

You are addressing code review feedback on an existing pull request. The user will describe which review comments to address and may reference specific files, findings, or reviewer suggestions.

**CRITICAL — Branch discipline**: All changes MUST be pushed directly to the PR's branch. Do NOT create a new branch. You are committing follow-up fixes to the same branch the PR was opened from.

---

## Step 0 — Sync with upstream

Before starting any work, pull the latest state of the PR branch:

```
git fetch origin
git pull origin <PR-branch-name>
```

If the PR branch is not currently checked out, check it out first:

```
git fetch origin <PR-branch-name>
git checkout <PR-branch-name>
git pull origin <PR-branch-name>
```

Verify you are on the correct branch before making any changes:

```
git status
```

---

## Step 1 — Understand the review feedback

1. Read the user's description of which review comments to address.
2. If a PR number or URL is available, read the review comments directly:
   ```
   gh pr view <number> --json reviews,comments --jq '.reviews[] | {author: .author.login, state: .state, body: .body}'
   ```
3. Cross-reference the feedback with the actual code — read the relevant files and diffs to understand the context of each comment.

---

## Step 2 — Plan and implement fixes

1. For each review comment to address, understand the root issue and plan the fix.
2. Make the changes. Follow all project rules (`.claude/rules/`, `AGENTS.md`).
3. Run pre-commit hooks: `pre-commit run`.
4. Make small, focused commits — one per logical fix or per review comment addressed. Use descriptive commit messages that reference what feedback is being addressed (e.g., "Fix null check in auth middleware per review feedback", "Extract helper function as suggested in review").

---

## Step 3 — Sync and push

Before pushing, pull again to pick up any changes that may have landed on the PR branch while you were working:

```
git pull origin <PR-branch-name> --no-edit
```

If there are merge conflicts, resolve them (prefer the review-fix version for files you just changed; prefer upstream for unrelated changes). Then push:

```
git push origin <PR-branch-name>
```

**Do NOT push to any other branch.** All commits go directly to the PR branch.

---

## Step 4 — Summarize

After pushing, summarize what was done:

- List each review comment addressed and the corresponding commit(s).
- Note any review comments that were NOT addressed and why (e.g., disagreement, needs clarification, out of scope).
- If any changes went beyond what the reviewer asked for (e.g., you found a related issue while fixing), call it out explicitly.

---

## Principles

- **Stay on the PR branch.** Never create a new branch. Never push to a different branch.
- **Pull before starting, pull before pushing.** The PR branch may have other contributors or CI commits.
- **Small commits.** One logical fix per commit. Don't batch all review fixes into a single commit.
- **Respect the reviewer.** Address what they asked for. If you disagree with a suggestion, explain why in the summary — don't silently skip it.
- **Follow project rules.** All `.claude/rules/` and `AGENTS.md` guidelines apply. Run pre-commit hooks before committing.
