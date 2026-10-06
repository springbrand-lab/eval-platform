# pre-standup-notes-create

Generate a **Team Daily Summary** of all GitHub activity in the `CarbonCoreAI/chocolate_chip` repo since the **previous standup**. Output the result in **Slack mrkdwn format** ready to paste into a Slack channel.

## Time window

### Override (optional)

If the user provides a custom time range in their message (e.g. "last 48 hours", "since Monday", "since 2026-03-10"), use that instead of the default. Parse natural language into the appropriate `$SINCE` UTC timestamp.

### Default — "since last standup"

If no override is given, calculate the cutoff automatically. Standups are at **6:00 PM Pacific Time**, Monday through Friday:

1. Determine today's day of week.
2. **Tuesday–Friday**: the previous standup was **yesterday at 6 PM Pacific**.
3. **Monday**: the previous standup was **Friday at 6 PM Pacific** (covers the weekend).
4. **Saturday/Sunday** (rare): use **Friday at 6 PM Pacific**.

Compute the UTC timestamp with Python (the GNU `date -u -d "... 18:00"` form silently parses `18:00` as UTC instead of PT, which truncates the window and drops authors):
```bash
SINCE=$(python3 - <<'PY'
from datetime import datetime, timedelta
import zoneinfo
pt = zoneinfo.ZoneInfo("America/Los_Angeles")
utc = zoneinfo.ZoneInfo("UTC")
now = datetime.now(pt)
dow = now.isoweekday()  # 1=Mon … 7=Sun
if dow == 1:
    days_back = 3   # Monday → Friday
elif dow <= 5:
    days_back = 1   # Tue–Fri → yesterday
elif dow == 6:
    days_back = 1   # Saturday → Friday
else:
    days_back = 2   # Sunday → Friday
target_pt = (now - timedelta(days=days_back)).replace(hour=18, minute=0, second=0, microsecond=0)
print(target_pt.astimezone(utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)
echo "SINCE=$SINCE"
```

Sanity check: at any standup time on a weekday, `$SINCE` should land on the previous business day at 18:00 PT — e.g. when the cron fires Friday 17:45 PT, `$SINCE` should be `Thursday 18:00 PT` ≈ `01:00 UTC Friday`, **not** `Friday 11:00 AM PT`. If the value looks wrong, stop and re-check before running any `gh` queries.

Use `$SINCE` in all queries below wherever a time cutoff is needed.

## Data to collect

**Persist every query's output to a file under `/tmp/`.** Do not try to keep this data in your head — when you have to enumerate authors at output time, you will read these files. The completeness check at the end depends on these files existing.

Use `gh` CLI commands to gather the following:

1. **All PRs updated since last standup** (merged, open, closed) — write the JSON to `/tmp/standup-prs.json`. `gh pr list --limit N` silently caps the result at N with no warning; a Monday window can easily exceed 100, so use 300 and assert we did not hit the ceiling:
   ```bash
   PR_LIMIT=300
   gh pr list --state all --limit "$PR_LIMIT" \
     --json number,title,author,state,createdAt,updatedAt,mergedAt,closedAt,url,additions,deletions \
     --search "updated:>=$SINCE" \
     > /tmp/standup-prs.json
   PR_COUNT=$(jq 'length' /tmp/standup-prs.json)
   echo "PR count: $PR_COUNT (limit $PR_LIMIT)"
   if [ "$PR_COUNT" -ge "$PR_LIMIT" ]; then
     echo "WARNING: hit --limit $PR_LIMIT cap; list may be truncated. Raise PR_LIMIT or split the window." >&2
   fi
   ```

2. **Detailed info for every PR** — batch-fetch ALL of them in one shell loop into `/tmp/standup-pr-details.jsonl`. Do NOT cherry-pick PRs to detail; iterate over every number from step 1. `gh ... -q` emits jq's default pretty-printed multi-line JSON, so pipe through `jq -c .` to enforce one object per line — otherwise the `wc -l` count below will not match the PR count. (Note: `is_bot` is only present on `gh pr list`'s author object, not `gh pr view`'s, so we source it from `/tmp/standup-prs.json` in the Completeness check below — do not add it here.)
   ```bash
   : > /tmp/standup-pr-details.jsonl
   for N in $(jq -r '.[].number' /tmp/standup-prs.json); do
     gh pr view "$N" \
       --json number,title,author,state,body,commits,mergedAt,createdAt,updatedAt,reviews,headRefName \
       -q '{number,title,author:(.author.login),state,mergedAt,createdAt,updatedAt,commits:(.commits|length),branch:.headRefName,body:((.body//"")[:300]),reviews:[.reviews[]|{author:.author.login,state:.state}]}' \
       | jq -c . \
       >> /tmp/standup-pr-details.jsonl
   done
   echo "Detailed: $(wc -l < /tmp/standup-pr-details.jsonl) of $(jq 'length' /tmp/standup-prs.json)"
   ```
   The two counts must match. If they don't, retry the missing PR numbers before continuing.

3. **PR review comments** since last standup — write to `/tmp/standup-pr-comments.json`. Use `--paginate` so comments past the 100th aren't silently dropped (which would re-introduce the same silent-omission class of bug this PR fixes for PR authors):
   ```bash
   gh api --paginate \
     "repos/CarbonCoreAI/chocolate_chip/pulls/comments?since=$SINCE&per_page=100" \
     --jq '.[] | {pr_url: .pull_request_url, author: .user.login, body: (.body[:150]), created_at: .created_at}' \
     | jq -s . \
     > /tmp/standup-pr-comments.json
   echo "PR review comments: $(jq 'length' /tmp/standup-pr-comments.json)"
   ```

4. **Issue/PR conversation comments** since last standup — write to `/tmp/standup-issue-comments.json` (same `--paginate` requirement as step 3):
   ```bash
   gh api --paginate \
     "repos/CarbonCoreAI/chocolate_chip/issues/comments?since=$SINCE&per_page=100" \
     --jq '.[] | {issue_url: .issue_url, author: .user.login, body: (.body[:150]), created_at: .created_at}' \
     | jq -s . \
     > /tmp/standup-issue-comments.json
   echo "Issue comments: $(jq 'length' /tmp/standup-issue-comments.json)"
   ```

5. **Review activity per team member** (who approved/commented on which PRs) — write each team member's review hits to `/tmp/standup-reviews-<login>.json`. **Loop over every login from the team table; do not skip any:**
   ```bash
   for LOGIN in wwerst svott03 Pascal-Bliem carlodizon03 paulkoloai victorkoloai; do
     gh api --paginate \
       "search/issues?q=repo:CarbonCoreAI/chocolate_chip+is:pr+reviewed-by:${LOGIN}+updated:>=${SINCE}&per_page=100" \
       --jq '.items[] | {number, title, user: .user.login}' \
       | jq -s . \
       > "/tmp/standup-reviews-${LOGIN}.json"
   done
   ```
   If you add or remove team members in the table below, you must update **four locations**: this loop and the matching loop in the Completeness check below, **and the same two loops in `.cursor/commands/pre-standup-notes-create.md`** (the mirror copy).

## Completeness check (REQUIRED before output)

Before writing the summary, derive the set of distinct logins that had **any** activity in the window — PR authors, review-comment authors, issue-comment authors, and reviewers. Comment-only and review-only contributors must be included; a PR-author-only check re-introduces the silent-omission bug this command exists to prevent:

```bash
{
  jq -r '.[].author.login'              /tmp/standup-prs.json
  jq -r '.[].author'                    /tmp/standup-pr-comments.json
  jq -r '.[].author'                    /tmp/standup-issue-comments.json
  # Iterate the explicit team list rather than globbing /tmp/, so a
  # stale standup-reviews-<former-member>.json from a previous run can't
  # leak into today's authors set as a ghost reviewer section. Keep this
  # list in sync with the step-5 loop above.
  for LOGIN in wwerst svott03 Pascal-Bliem carlodizon03 paulkoloai victorkoloai; do
    f="/tmp/standup-reviews-${LOGIN}.json"
    [ -f "$f" ] && [ "$(jq 'length' "$f")" -gt 0 ] && echo "$LOGIN"
  done
} | grep -v '^$' | sort -u > /tmp/standup-all-authors.txt
echo "Distinct authors in window: $(wc -l < /tmp/standup-all-authors.txt)"
cat /tmp/standup-all-authors.txt
```

Also compute the bot-author set from `/tmp/standup-prs.json` (the only file where GitHub's `is_bot` flag survives — `gh pr view` strips it):

```bash
jq -r '.[] | select(.author.is_bot) | .author.login' /tmp/standup-prs.json | sort -u \
  > /tmp/standup-bot-authors.txt
```

For every login in `/tmp/standup-all-authors.txt`:

- If the login matches a team member in the table below → that team member **MUST** appear as a section in the output (with their PRs in `Merged` / `Open`, plus any reviews/comments).
- If the login is a bot (appears in `/tmp/standup-bot-authors.txt`, or starts with `app/`, or matches `github-actions`/`cursor`/`dependabot`/`greptile`) → put their PRs in the `Bot-generated` section at the end.
- If the login is a human not in the table → still include them as their own section, using the login as the display name.

**You may NOT skip a team member with non-zero activity in the window for any reason** — not to save space, not because their PRs look similar to someone else's, not because you're running long. Coverage of every author with activity is the single most important rule of this command. If you are tempted to drop a person, write their section anyway, even if it's terse.

## Team members

| Name | GitHub login |
|---|---|
| Will Werst | wwerst |
| Steve Vott | svott03 |
| Pascal Bliem | Pascal-Bliem |
| Carlo Dizon | carlodizon03 |
| Paul Willmes | paulkoloai |
| Victor Delgado | victorkoloai |

## Output format

Output the full summary inside a single code block so it can be copy-pasted into Slack. Use **Slack mrkdwn** syntax:

- `*bold*` for headings and names
- `_italic_` for topic taglines
- `:white_check_mark:` for merged, `:construction:` for open, `:eyes:` for reviews
- For PR links, use bare URLs (e.g. `https://github.com/CarbonCoreAI/chocolate_chip/pull/123`). Slack auto-linkifies bare URLs when pasted into the composer. Do NOT use `<url|label>` syntax — that only works in API-sent messages and produces broken `%7C` encoding when pasted by a human.
- Backtick-wrap inline code references

### Structure

```
*Team Daily Summary — Since Last Standup*
_(from <previous standup date/time PT> to now, <current date/time PT>)_

──────────

*Full Name (github_login)*
_Short topic tagline_

:white_check_mark: Merged (N):
• #number (https://github.com/CarbonCoreAI/chocolate_chip/pull/number) — Title — One-line description.

:construction: Open (N):
• #number (https://github.com/CarbonCoreAI/chocolate_chip/pull/number) (new/updated) — Title — One-line description.

:eyes: Reviews:
• Approved/Commented on #number (https://github.com/CarbonCoreAI/chocolate_chip/pull/number) (Author) — Title

──────────
(repeat for each team member with activity)

:robot_face: *Bot-generated:*
• #number (https://github.com/CarbonCoreAI/chocolate_chip/pull/number) (bot name) — Title — One-line description.
```

### Rules

- Group by **person**, sorted by most activity first.
- Within each person: merged PRs first, then open PRs, then reviews/comments.
- For each PR, write a **concise one-line description** derived from the PR body (not just the title).
- **Bot-authored PRs** (author login `app/cursor`, `app/github-actions`, or any `is_bot: true`) go in a separate section at the end.
- Omit team members with **zero** activity in the window. Anyone with even one PR, comment, or review in the window must appear.
- If a PR was only updated by bot comments (no human activity), still include it under the human author's section.
- Before finalizing the output, re-read the distinct-authors list from the Completeness check and confirm every human author has a section. Treat the check as a hard gate, not a suggestion.
