# No Em Dashes in User-Visible Web Copy

Applies to user-visible copy under `web/src/**`.

Do not add an em dash (`—`), `&mdash;`, `&#8212;`, or prose `--` as an
em-dash substitute. Restructure the sentence with a period, comma, colon,
parentheses, or two sentences.

Examples:

| Instead of | Write |
| --- | --- |
| `Sync failed — check your connection` | `Sync failed. Check your connection.` |
| `Everything you need — in one place` | `Everything you need, in one place` |
| `Pro plan — $20/month` | `Pro plan: $20/month` |

Normal hyphens in compound words, ranges, minus signs, and CLI flags are
allowed. The rule does not apply to source syntax, comments, identifiers, or
fixtures that reproduce third-party output.
