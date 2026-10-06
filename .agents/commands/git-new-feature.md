# git-new-feature

Create a new feature branch named `<initials>/<kebab-case-feature-name>` from the current branch. The feature name is derived from conversation context (or from `$ARGUMENTS` if provided).

## Argument

- `$ARGUMENTS` — optional. If provided and it already reads as a branch-name slug (a few words at most), use it directly as the feature slug (kebab-cased if not already). If it is a whole task description instead — a sentence, or a goal forwarded verbatim by another command such as `/orchestrate` (rough test: more than ~6 words) — treat it as context and derive the short slug from it, exactly as if no argument was given; never kebab-case an entire sentence into a branch name. If empty, derive a short kebab-case slug from the current conversation context describing the feature being worked on.

## Steps

### 1. Determine the user's branch prefix

Read `git config user.name` and compute:

```
prefix = lowercase(first letter of first word) + lowercase(last word)
```

Examples:
- `Will Werst` → `wwerst`
- `Jane Q. Doe` → `jdoe` (treat single-letter middles like `Q.` as ignorable; use first word's first letter and the last word)
- `Alice` → fallback: ask the user for the prefix

If `git config user.name` is empty or only one word that doesn't yield a clean prefix, **ask the user** what prefix to use. Do not guess.

### 2. Determine the feature slug

- If `$ARGUMENTS` is provided and already reads as a short branch-name slug (a few words at most): lowercase it, replace whitespace and underscores with `-`, strip non `[a-z0-9-]` chars, collapse repeated `-`, and use it directly.
- If `$ARGUMENTS` is provided but reads as a whole task description instead — a sentence, or a goal forwarded verbatim by another command such as `/orchestrate` (rough test: more than ~6 words) — treat it as context, not a literal slug, and derive a 2–5-word kebab-case slug from it the same way as the next bullet; never kebab-case an entire sentence into a branch name.
- Otherwise (no `$ARGUMENTS`): derive a 2–5-word kebab-case slug from the most recent conversation context describing the feature. Be specific enough to identify the work later (e.g., `add-user-role-push`, not `update-backend`). If context is too thin to name it, **ask the user** for a slug rather than guessing.

### 3. Check for uncommitted changes

```bash
git status --porcelain
```

If non-empty, surface the output to the user and explain that `git switch -c` carries the working-tree changes onto the new branch by default — which is usually the right thing when starting a feature branch from in-progress edits. Ask the user to either:
- **confirm** carrying the changes forward, in which case proceed to step 4, or
- **commit or stash manually first** on the current branch, then re-run this command.

Do not commit or stash on the user's behalf — this command only creates and switches branches. Do not silently carry uncommitted work onto a new branch without explicit confirmation.

### 4. Create and switch to the new branch

First, check that the branch name isn't already taken — locally or remotely:

```bash
git branch --list <prefix>/<slug>
git ls-remote --heads origin <prefix>/<slug>
```

If either is non-empty, stop and report which one matched. Ask the user whether to pick a new slug or switch to the existing branch. Do not run `git switch -c` against a name that exists on `origin` — it will create a diverged tracking relationship and fail to push later.

Otherwise, create and switch:

```bash
git switch -c <prefix>/<slug>
```

### 5. Report

State the new branch name and what it was created from (e.g., "Created `wwerst/add-user-role-push` from `dev`").

## Notes

- This command does **not** push. The branch is local until the user (or `/create-pr-link`) pushes it.
- This command does **not** switch to `dev` first. If the user wants to start from a fresh `dev`, they should run `/git-switch-and-pull` before this command.
- The slug is for humans — keep it short and specific. Avoid generic words like `update`, `fix`, `change` without a noun.
