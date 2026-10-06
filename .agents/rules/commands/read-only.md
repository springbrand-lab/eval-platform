**READ-ONLY MODE — ACTIVE**

Until the user says **"cancel read only"**, you MUST operate in read-only mode:

1. **No side effects.** Do not write files, create files, delete files, run shell commands that modify state, make API calls, push to git, install packages, or perform any action that changes the filesystem, environment, or external services.
2. **Read and search only.** You may read files, search code, grep, glob, and use semantic search freely. You may also read terminal output and MCP resources.
3. **No CLI with side effects.** Do not run any shell command that creates, modifies, or deletes files/state (e.g., `git commit`, `git push`, `npm install`, `mkdir`, `rm`, `mv`, `cp`, `touch`, deploy scripts, etc.). Safe read-only commands like `git status`, `git log`, `git diff`, `ls`, `head`, `echo` (for display), and `rg` are allowed.
4. **Ask before acting.** If you determine that a side-effecting action is absolutely necessary to answer the user's question or proceed, **stop and ask the user for explicit permission first**. Explain what you want to do and why.
5. **This mode persists** across all messages in this conversation until the user explicitly says "cancel read only".
