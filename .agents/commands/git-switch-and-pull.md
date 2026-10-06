---
description: Switch to a branch (default dev) and pull latest from origin; refuses if the working tree is dirty, and pauses for confirmation if the current branch has unpushed commits.
argument-hint: "[branch]"
allowed-tools: Bash(git status:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git switch:*), Bash(git pull:*)
---

# git-switch-and-pull

Switch to a target branch (default: the repo's default branch, `dev`) and pull the latest from `origin`. Refuses to proceed if the current working tree has uncommitted changes or the current branch has unpushed commits — surfaces them and stops so the user can decide.

## Argument

- `$ARGUMENTS` — optional branch name to switch to. If empty, defaults to `dev`.

## Steps

### 1. Check for uncommitted changes

```bash
git status --porcelain
```

If the output is **non-empty**, stop. Print the output to the user and explain that this command will not switch with a dirty working tree. The user must resolve the state themselves (e.g. commit, stash, or discard manually) and then re-run `/git-switch-and-pull`.

Do not commit, stash, or modify the working tree on the user's behalf — this command only detects and reports.

### 2. Check for unpushed / local-only commits on the current branch

Determine whether the current branch has an upstream:

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
```

If it **has** an upstream, list unpushed commits:

```bash
git log @{u}..HEAD --oneline
```

If it **does not** have an upstream (a purely local branch), fall back to comparing against `origin/dev` — anything not in `origin/dev` exists only on this branch by name and would be lost if the branch is later deleted:

```bash
git log origin/dev..HEAD --oneline
```

In either case, if the output is **non-empty**, stop. Show the commits and ask the user whether to:
- **keep them on the branch and proceed** — switching away is safe; the commits stay on the current branch and are reachable when the user switches back,
- or **push them first** (publishing or setting an upstream), then re-run this command.

Do not push or rewrite history on the user's behalf. If the user wants to drop the commits, they must do that manually (e.g. `git reset`) before re-running.

### 3. Switch to the target branch

```bash
git switch <target>
```

Where `<target>` is `$ARGUMENTS` if provided, otherwise `dev`.

### 4. Pull the latest

```bash
git pull --ff-only
```

If the pull is not fast-forward (rare on a tracking-only branch), stop and report — do not merge or rebase automatically.

### 5. Report

One sentence: which branch we're on now and how many commits were pulled (or "already up to date").

## Notes

- The default branch for this repo is `dev` (confirmed via `git remote show origin`). If the user passes a different branch as `$ARGUMENTS`, use that instead.
- Never use `git checkout -- .`, `git reset --hard`, `git stash drop`, or any destructive operation to "make room" for the switch. If the working tree isn't clean, ask the user.
- Do not create commits, stash, or push as part of this command. The command only switches and pulls.
