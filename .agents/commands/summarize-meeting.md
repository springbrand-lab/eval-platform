# summarize-meeting

Summarize a recorded meeting from its Google Meet notes doc and (by default) post
the summary to Slack — as a **Canvas** with a person-grouped follow-up checklist
plus per-person **thread replies** with the detail.

This is the generic, parameterized version of the team's meeting-summary routine.
It works for **any** meeting type (Daily Sync, standup, design review, 1:1, etc.).
Pass what you know on the command line; the command asks for anything essential it
can't infer and fills the rest from sensible defaults. The original Kolo "Daily
Sync" routine is reproduced verbatim as a one-liner under
[Worked example](#worked-example--kolo-daily-sync).

---

## How to invoke

```
/summarize-meeting [free-form description of the meeting + where to post]
```

Everything after the command name is free-form natural language. Examples:

- `/summarize-meeting Daily Sync, 11am Pacific, post to #product-discussion`
- `/summarize-meeting yesterday's standup → #eng-standup`
- `/summarize-meeting design review from this doc <google-doc-url>, post to #design`
- `/summarize-meeting the 2pm 1:1 — just summarize it here, don't post anywhere`
- `/summarize-meeting` (no args → the command asks which meeting and where)

Parse the args into the [parameters](#parameters) below. Do **not** demand a rigid
syntax from the user — infer intent (meeting name, date/time, channel, output mode)
from natural language, then confirm anything ambiguous.

---

## Parameters

| Parameter | What it is | Default if unspecified |
|---|---|---|
| **Meeting name** | Title fragment to match the notes doc (e.g. `Daily Sync`, `Standup`). | **Ask** — there is no safe default. |
| **Date** | Which day's meeting. | **Today**, in `America/Los_Angeles` (Pacific). |
| **Start time + tolerance** | Approx. meeting start, used to disambiguate when several docs match name+date. | None required. If multiple match, prefer the closest in time, else ask. Default tolerance ±15 min when a time is given. |
| **Source doc** | An explicit Google Doc URL/ID for the notes/transcript. | None — locate it by searching the Drive folder. |
| **Drive folder** | Where to search for the notes doc. | **`Meet Recordings`** (the folder Google Meet auto-creates for recordings/transcripts/notes). Accepts a folder name, URL, or ID. |
| **Slack channel** | Destination channel (name or ID). | **Ask** if posting and none given. |
| **Output mode** | What to produce — see below. | **Full Slack treatment** (canvas + channel message + per-person thread replies) when a channel is known; otherwise a chat-only summary. |
| **Enrichment** | Fix mis-transcriptions / add PR links via the **code repo relevant to this meeting** + GitHub (`gh`). | **On** when a relevant repo is known/available (default: the repo you're invoked in, *if* it's the project under discussion); gracefully skipped if none is resolvable or `gh` auth is missing. |

### Output modes (reasonable defaults, none forced)

The defaults mirror the common case but are independently toggleable — honor what
the user asks for:

- **`canvas`** — main notes as a Slack Canvas (checkable follow-ups). *Default on when posting.*
- **`channel-message`** — a channel post linking the canvas. *Default on when a canvas is posted.*
- **`thread-replies`** — per-person detail as replies under the channel message. *Default on when a channel message is posted.*
- **`chat-only`** — render the summary in this chat, post nothing. *Default when no channel is known/requested.*

If the user says e.g. "just the canvas" or "don't bother with the per-person
threads", drop the corresponding pieces. If they say "just summarize it here",
use `chat-only` and skip Slack entirely.

---

## Resolving parameters (do this first)

1. Parse the args into the table above.
2. Determine **today** in Pacific and the target **date** (resolve "yesterday",
   "Monday", explicit dates against `America/Los_Angeles`):
   ```bash
   python3 - <<'PY'
   from datetime import datetime
   import zoneinfo
   now = datetime.now(zoneinfo.ZoneInfo("America/Los_Angeles"))
   print("today_pacific:", now.strftime("%Y-%m-%d (%A) %H:%M %Z"))
   # Numeric Pacific offset (PDT -0700 / PST -0800) for use as <UTC-OFFSET> in the
   # Drive createdTime filter below — format with a colon (-07:00 / -08:00). For a
   # target date in a different DST period than today, use that date's offset.
   print("utc_offset:", now.strftime("%z"))
   PY
   ```
3. Collect the **missing essentials** and ask for them in **one** batched
   question (use `AskUserQuestion`), not one at a time:
   - Meeting name (always, if not given).
   - Channel (only if the user wants to post and didn't name one).
   - Output mode (only if genuinely ambiguous — otherwise apply the default and
     state it).
   Anything with a safe default (date, folder, tolerance, enrichment) is applied
   silently and **stated back** to the user; don't ask about those.

---

## Execution (DAG; foreground subagents when warranted)

Plan the work as a small DAG. **Use foreground subagents only when the task
warrants it** (per `/use-subagents` — don't spawn a subagent for work you can do in
a few tool calls): for a simple run (one explicit doc, a single recipient) just do
the steps inline. When you *do* delegate — a long transcript to distill, several
independent lookups to fan out — keep subagents **foreground** (never
`run_in_background`, since later steps depend on earlier IDs/URLs and the user is
waiting) and pin each to this chat's model. The dependency graph:

```
[1 locate doc] ──▶ [2 fetch transcript+tabs] ──┬─▶ [4 enrich (optional)] ─┐
                                               ├─▶ [3 map people→Slack IDs] ┤
                                               └────────────────────────────┴─▶ [5 canvas] ─▶ [6 channel msg] ─▶ [7 thread replies]
        └──▶ [early-exit checks: "no doc" gates after 1; "already posted"/recording-link after 2 — all before 5]
```

Steps 2→{3,4} can fan out in parallel once the doc text is in hand. Steps 5–7
are sequential (each needs the prior step's IDs/URLs) and are main-agent work, not
subagent work. Keep each subagent's return **small** (distilled findings, not raw
transcript) per the token-efficiency rule.

---

## Step 1 — Locate the notes doc

If the user gave an explicit doc URL/ID, extract the file ID and skip the search.

Otherwise search Drive. Prefer scoping to the **Drive folder** (default
`Meet Recordings`):

1. Resolve the folder to an ID with `Google_Drive.search_files`:
   ```
   query: mimeType = 'application/vnd.google-apps.folder' and title = 'Meet Recordings'
   ```
   (If the user passed a folder URL, extract the ID from `/folders/<ID>` instead.)
2. Search inside it for the day's notes doc:
   ```
   query: parentId = '<FOLDER_ID>'
          and mimeType = 'application/vnd.google-apps.document'
          and title contains '<MEETING NAME>'
          and createdTime > '<DATE>T00:00:00<UTC-OFFSET>'
          and createdTime < '<NEXT-DATE>T00:00:00<UTC-OFFSET>'
   ```
   (`<UTC-OFFSET>` is the Pacific offset for `<DATE>` from the script above —
   `-07:00` in summer / `-08:00` in winter; `<NEXT-DATE>` is `<DATE>` + 1 day, so
   the window covers exactly that Pacific day.)
   Meet typically creates docs titled like
   `<Meeting> - <YYYY/MM/DD HH:MM TZ> - Notes by Gemini` and a separate
   `… - Transcript`. Match on the meeting name + date; if both a Notes and a
   Transcript doc exist, you want the one(s) that contain the transcript and the
   Gemini notes (often one doc with multiple **tabs**).
3. If the folder can't be found or returns nothing, fall back to a global search
   by `title contains '<MEETING NAME>'` + `createdTime` within the day (drop the
   `parentId` clause).
4. Disambiguate by start time when a time was given (±tolerance); confirm with the
   user if more than one plausible doc remains.

Use `get_file_metadata` to confirm `createdTime`/`title` before committing to a doc.

---

## Early-exit conditions (gate BEFORE posting)

1. **No matching doc.** If no Google Doc matches the meeting name within the
   date/time window, **stop** and report what you searched (folder, name, date,
   window) so the user can correct a parameter. Do not invent a summary.
2. **Already posted.** If the summary for this meeting+date was already posted to
   the target channel, don't double-post. Detect this by reading recent channel
   history (`slack_read_channel`) or searching (`slack_search_public_and_private`)
   for **either** a canvas titled like the one below **or** its linking message for
   that date.
   - If **both** the canvas and its linking message exist, **stop** — it's complete.
   - **Partial post (crash between Steps 5–6).** If only one exists — e.g. the
     canvas was created but the channel message never posted — **do not create a
     second canvas** (it cannot be deleted or renamed; see Gotchas). Reuse the
     existing canvas and post only the missing piece: the channel message (Step 6)
     and/or the per-person thread replies (Step 7).
   - **Exception — recording link now available.** Because this turns on the doc's
     current contents, run **Step 2** (fetch the doc, capture any recording link)
     before finalizing this exit. If the notes were already posted but a **Google
     Meet recording link** is now present in the doc and was missing from the
     original post, take the **[Update path](#update-path)**
     instead of exiting: add the recording link to the canvas and post it as a new
     thread reply (you cannot edit the original message — see Gotchas).

---

## Step 2 — Fetch transcript + tabs

Read the **full** notes doc with `Google_Drive.read_file_content` (pass the file
ID). Google Docs with multiple **tabs** (e.g. a raw Transcript tab + a Gemini
Notes tab) are returned in the text representation — capture **all** tabs:
the raw transcript (for timestamps/quotes) **and** the Gemini-generated notes
(for the pre-digested summary). If a separate Transcript doc exists, read it too.

Capture the **Google Meet recording link** if present (often near the top of the
notes doc). You'll cite it in the canvas.

---

## Step 3 — Map participants → Slack users

1. Verify the target channel exists and get its ID. For a private channel, search
   with `slack_search_channels` (`channel_types: public_channel,private_channel`),
   or use the known ID directly.
2. List members with `slack_list_channel_members` (paginate via `cursor`; max 30
   per page). Use `slack_read_user_profile` / `slack_search_users` as needed to
   resolve display names.
3. Build a **speaker → Slack user ID** map by matching transcript speaker names to
   channel members. Keep it as a small table `{ "Full Name": "U…" }`. Note any
   speaker you couldn't confidently map (don't guess a wrong @mention).

---

## Step 4 — Content enrichment (optional, gracefully skipped)

Determine the **code repo relevant to this meeting** (the project under discussion).
Default to the repo you're invoked in *if* it's the right project; otherwise use a
repo the user names. If that repo is cloned locally and `gh` / GitHub auth are
available, use the codebase + GitHub to:

- **Correct likely mis-transcriptions** — product, model, service, and person
  names the transcript garbled (e.g. internal product/model names).
- **Pull PR / issue links** that make follow-ups actionable (search `gh pr list`
  / `gh issue list` / `gh search` for the work items discussed).

If no relevant repo is known, the repo isn't cloned, or `gh`/auth aren't available,
**note in the output that enrichment was skipped** and proceed — never block the
summary on it. **Never enrich against an unrelated repo**: a wrong-repo name
"correction" or PR link is worse than none. (This command file lives inside the
`CarbonCoreAI/chocolate_chip` checkout, so that repo is usually present — only use
it when the meeting is actually about that project; see the Worked example.)

---

## Step 5 — Build & post the Canvas

Create the canvas with `slack_create_canvas`. **Get the title and wording right on
the first try** — there is no rename and no edit-title (see Gotchas).

**Title:** `<Meeting> Notes — <date in Pacific>`
(e.g. `Daily Sync Notes — June 16, 2026`). Do **not** repeat the title inside the
content body.

**Content — Canvas-flavored Markdown** (this is *not* Slack message mrkdwn — see
the [cheat-sheet](#formatting-cheat-sheet)):

- A line linking the **Google Doc** notes/transcript, and the **Google Meet
  recording** link if available: `[Notes & transcript](<doc-url>) · [Recording](<meet-url>)`.
- **`## Follow-ups`** — a checklist **grouped by person**, using real `- [ ]`
  checkboxes so they're checkable in the canvas. Mention people with the
  **canvas** format `![](@U…)` (NOT `<@U…>`). Put each person's `![](@U…)` on its
  own line as a sub-heading, then their `- [ ]` items beneath.
- **`## Summary & decisions`** — a brief, durable summary (decisions made, things
  to remember), **citing transcript timestamps** where relevant (e.g. `[00:12:30]`).

Channel references inside a canvas use `![](#C…)`, never `<#C…>`. Only `http(s)`,
`mailto:`, `tel:`, `slack://`, and relative links are allowed.

Keep the returned **canvas URL** and canvas/file **ID** for the next steps and the
update path.

---

## Step 6 — Channel message

Post a message to the channel with `slack_send_message` that links the canvas.
Use **Slack mrkdwn** here (the connector converts standard markdown):

```
<canvas_url|<Meeting> Notes — <date>>
```

Keep the **message `ts`** from the response — the thread replies hang off it.

---

## Step 7 — Per-person thread replies

Reply to the Step 6 message (`thread_ts` = its `ts`) with **one person's detailed
summary per reply**: everything related to them (their follow-ups, what they
raised, decisions affecting them) for their own reference and the team's.

These are normal messages → **Slack mrkdwn**:
- `**bold**`, `_italic_`, `` `code` ``
- Links: `<url|text>` or `[text](url)`
- Mentions: `<@U…>` (NOT the canvas `![](@…)` form)

**Length:** the connector caps a text element at ~5,000 chars; keep each reply
**≤ 4,000 chars** for safety and readability. **Validate before sending**: write
each reply to a file and run a short script to check length (and a quick sanity
pass on mrkdwn), splitting a long person across multiple replies:

```bash
for f in /tmp/meeting-reply-*.md; do
  n=$(wc -m < "$f")
  printf '%s: %s chars %s\n' "$f" "$n" "$([ "$n" -le 4000 ] && echo OK || echo TOO_LONG)"
done
```

Send replies in a stable order (e.g. most-active first, matching the canvas
follow-ups order).

---

## Update path

(For early-exit exception: notes already posted, but the recording link is now
available and was missing.) You **cannot** edit or delete messages, and you
**cannot** rename a canvas — but you **can** edit canvas *content*:

1. `slack_read_canvas` to get section IDs, then `slack_update_canvas` with the
   appropriate `section_id` to add the `[Recording](<meet-url>)` link to the links
   line. **Never** call `action=replace` without a `section_id` (it overwrites the
   entire canvas).
2. Post a **new thread reply** under the original channel message that **contains
   the recording link** (`<meet-url|Recording>` in mrkdwn) — not merely a note that
   it exists — since the original message can't be edited.

---

## Formatting cheat-sheet

| | **Canvas** (`slack_create_canvas`/`update_canvas`) | **Message / thread reply** (`slack_send_message`) |
|---|---|---|
| Flavor | Canvas-flavored Markdown | Standard markdown → mrkdwn |
| Bold | `**bold**` / `# H1` / `- [ ]` checkboxes | `**bold**`, `_italic_` |
| User mention | `![](@U123)` | `<@U123>` |
| Channel ref | `![](#C123)` | `<#C123>` |
| Link | `[text](url)` | `<url|text>` or `[text](url)` |
| Checkboxes | ✅ real `- [ ]` | ❌ not interactive |
| Length cap | none (large docs OK) | ~5,000/element; keep ≤ 4,000 |

---

## Gotchas

- **No edit / no delete / no rename.** This Slack connector has no edit-message or
  delete-message tool, and `slack_update_canvas` has no `title` parameter — you
  **cannot** rename a canvas after creation. Get every title and the wording right
  on first creation. Canvas *content* (not title) can be updated via section IDs.
- **Canvas ≠ message formatting.** `![](@U…)`/`![](#C…)` in canvases; `<@U…>`/
  `<#C…>` in messages. Mixing them renders as literal broken text.
- **Verify the channel before posting** (especially private channels) so you don't
  post into the void or the wrong place.
- **Don't @mention a guessed user.** If a speaker can't be confidently matched to a
  channel member, use their plain name rather than a wrong `<@U…>`.
- **Foreground subagents only.** Never `run_in_background` for this command — the
  user is waiting on the result and later steps depend on earlier IDs/URLs.
- **Re-running is safe** because of the already-posted early-exit; rely on it
  rather than assuming a fresh run.

---

## Worked example — Kolo Daily Sync

The original routine, expressed as defaults for this command:

- **Meeting name:** `Daily Sync` (a.k.a. Product Discussion)
- **Start time:** 11:00 AM Pacific, tolerance ±10 min
- **Drive folder:** `Meet Recordings` (default), or the team's specific notes
  folder URL if the user supplies one
- **Channel:** `#product-discussion` (private, `C08V8VDD3F0`) — verify via search
  before posting
- **Doc title:** `Daily Sync - <Date…>` with a raw transcript tab + a Gemini-notes
  tab
- **Output:** full treatment — canvas `Daily Sync Notes — <date PT>` + channel
  message linking it + per-person thread replies
- **Enrichment:** correct mis-transcribed Kolo product/model names and attach
  relevant `CarbonCoreAI/chocolate_chip` PR/issue links

Invocation:

```
/summarize-meeting Daily Sync, started 11am Pacific, post to #product-discussion (C08V8VDD3F0)
```
