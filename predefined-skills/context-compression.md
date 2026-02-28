# Skill: Context-Efficient Conversation Management

Long conversations accumulate tokens quickly. Apply this skill proactively to stay within context limits, reduce cost, and keep responses fast — without losing any meaningful information.

## The Core Rule

**Compress prose. Never compress code or structured data.**

| Preserve verbatim | Compress / summarise |
|---|---|
| Code blocks (any language) | Repeated explanations |
| File contents | Verbose reasoning already acted on |
| Structured data (JSON, YAML, CSV) | Closed discussion threads |
| Error messages and stack traces | Approved decisions with no open questions |
| Schema definitions | Earlier conversation turns that are fully resolved |
| Command outputs | Long prose preambles and pleasantries |

## When to Compress

Compress proactively when any of the following is true:

- The conversation is approaching the model's context limit (estimate: > 60% of the token budget is used).
- The same context, file, or decision has been referenced more than twice.
- A task phase is complete (e.g., requirements approved → design approved → now implementing).
- A prior turn contained long reasoning that led to a decision — keep only the decision.

## Rolling Session Summary

At the start of any response where compression is warranted, emit a `[SESSION SUMMARY]` block **before** your response content. This block replaces the need to repeat resolved context.

```
[SESSION SUMMARY]
Project: {{project_name}} | Date: {{date}}
Phase: [current phase, e.g., "Implementation — Task 3 of 5"]
Resolved:
- [Decision or completed task 1, one line]
- [Decision or completed task 2, one line]
Active:
- [Current open task or question, one line]
Open Questions:
- [Any unresolved items requiring user input]
[END SUMMARY]
```

Rules for the summary:
- Each resolved item is **one line** — no sub-bullets.
- Code is **never** included in the summary; reference it by filename and line range if needed.
- The summary replaces, not supplements, the prior verbose context.

## Compression Examples

**Before (verbose, repeated):**
> "As we discussed earlier, the user wants us to use PostgreSQL for the primary store and Redis for caching. We decided that Redis keys will expire after 5 minutes. The schema we agreed on has a `users` table with UUID primary keys and `created_at`/`updated_at` timestamps..."

**After (compressed summary line):**
> `- DB: PostgreSQL primary + Redis cache (5 min TTL); users table: UUID PK, created_at/updated_at`

---

**Before (verbose reasoning):**
> "I considered three options for the auth approach. Option A was session cookies, which would require a Redis session store. Option B was JWT with short-lived access tokens and refresh rotation — this fits the stateless API design. Option C was OAuth2 with a third-party provider. We chose Option B because..."

**After (compressed decision):**
> `- Auth: JWT (15 min access + 7 day refresh rotation) — chosen over session cookies (requires state) and OAuth (out of scope)`

## What Never Gets Compressed

These are always reproduced in full, never summarised:

1. **Code that is currently being worked on** — always show the complete, current version.
2. **Error messages and stack traces** — partial traces mislead debugging.
3. **File contents provided as context** — if the user pasted a file, treat it as ground truth.
4. **Schema or contract definitions** — partial schemas cause subtle bugs.
5. **Test cases and their expected outputs** — truncating these loses correctness guarantees.

## Estimating Token Usage

Use these rough rules to estimate when you are approaching limits:

- 1 token ≈ 4 characters of English prose
- 1 token ≈ 3 characters of code (code is denser)
- A 100-line Python file ≈ 800–1,200 tokens
- A 500-word explanation ≈ 650 tokens

When nearing the limit, compress the oldest resolved turns first, working backwards from the beginning of the conversation.
