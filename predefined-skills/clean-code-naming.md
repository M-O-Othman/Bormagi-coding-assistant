# Skill: Clean Code and Naming Standards

## Naming

- **Never use 1–2 character variable names** outside of trivial loop indices.
- Function names are **verbs or verb phrases** that describe what they do: `generateDateString`, not `genYmdStr`.
- Variable names are **nouns or noun phrases** that describe what they hold: `numSuccessfulRequests`, not `n`.
- Use **full words over abbreviations**: `fetchUserDataResponseMs` not `resMs`.
- Use variables to **capture the meaning of complex conditions** rather than embedding them inline.

### Good vs Bad Examples

| Bad | Good |
|-----|------|
| `n` | `numSuccessfulRequests` |
| `genYmdStr()` | `generateDateString()` |
| `res` | `fetchUserDataResponse` |
| `[key, value]` | `[userId, user]` |
| `tmp` | `temporaryFilePath` |

## Control Flow

- **Use guard clauses and early returns** to handle error cases and edge conditions first, keeping the happy path at the lowest nesting level.
- **Handle error and edge cases first**: validate at the top of a function, not buried in an else branch.
- **Avoid deep nesting** beyond 2–3 levels; extract nested logic into well-named helper functions.
- **Never catch errors without meaningful handling**: log context, propagate with a clear message, or rethrow. Do not silently swallow exceptions.

## Comments

- Comments explain **why**, not what. If the code is self-explanatory, no comment is needed.
- Never add comments that merely restate what the code does.
- Comments belong **above** the code they describe, not inline at the end of a line.
- Never leave TODO comments — implement or track the work elsewhere.

## Formatting

- Match the existing code style and formatting of the project.
- Prefer **multi-line over complex one-liners**; readability beats brevity.
- Wrap long lines to a reasonable width consistent with the project.
- Do not reformat code that you are not changing.

## Typing

- In statically typed languages: **explicitly annotate function signatures and exported/public APIs**.
- Do not annotate trivially inferred local variables.
- Avoid unsafe type casts (`any`, `as unknown`, type assertions without justification).
