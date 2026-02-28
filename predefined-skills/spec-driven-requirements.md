# Skill: Spec-Driven Requirements

Use this skill when translating a rough feature idea into structured, unambiguous requirements that developers can implement and QA can verify.

## Requirement Format — EARS Syntax

Write acceptance criteria using the **Easy Approach to Requirements Syntax (EARS)**:

| Pattern | Template |
|---------|----------|
| Event-driven | `WHEN [event] THEN [system] SHALL [response]` |
| Conditional | `IF [precondition] THEN [system] SHALL [response]` |
| Compound | `WHEN [event] AND [condition] THEN [system] SHALL [response]` |
| Negative | `IF [precondition] IS NOT MET THEN [system] SHALL [response]` |

### Example

```
WHEN a user submits the registration form with a valid email and password
THEN the system SHALL create a new user account and send a verification email.

IF a user attempts to log in with an incorrect password three times in succession
THEN the system SHALL lock the account and notify the user by email.
```

## User Story Format

```
As a [role],
I want [capability],
so that [business value].
```

Every user story must have:
- A clear role (who benefits)
- A specific capability (what they want to do)
- An explicit benefit (why it matters)
- A set of acceptance criteria in EARS format

## Requirements Document Structure

```markdown
# Requirements Document

## Introduction
[Summary of the feature and its business purpose]

## Requirements

### Requirement 1 — [Short Title]

**User Story:** As a [role], I want [feature], so that [benefit].

#### Acceptance Criteria
1. WHEN [event] THEN [system] SHALL [response]
2. IF [precondition] THEN [system] SHALL [response]

### Requirement 2 — [Short Title]
...
```

## Design Document Structure

After requirements are approved, produce a design document with these sections:

1. **Overview** — What is being built and why.
2. **Architecture** — How the components fit together (use Mermaid diagrams).
3. **Components and Interfaces** — Each major component, its responsibility, and its public interface.
4. **Data Models** — Key entities, their attributes, and relationships.
5. **Error Handling** — How errors are surfaced and recovered from.
6. **Testing Strategy** — What will be tested, at what level, and with what tooling.

## Implementation Task Format

Convert approved designs into a checklist of concrete, coding-agent-executable tasks:

```markdown
- [ ] 1. [Short imperative description]
  - [Sub-task detail]
  - _Requirements: 1.1, 2.3_

- [ ] 2. [Short imperative description]
  - [ ] 2.1 [Sub-task]
    - [Detail]
    - _Requirements: 1.2_
```

Each task must:
- Be actionable by a coding agent (write, modify, or test code)
- Build incrementally on previous tasks
- Reference the specific requirement(s) it satisfies
- Not include deployment, user testing, or non-coding activities

## Workflow

1. Generate initial requirements from the user's rough idea — do not ask sequential questions first.
2. Present requirements and ask for explicit approval before proceeding.
3. Produce design document; request approval before producing tasks.
4. Produce task list; request approval before implementation begins.
5. Execute one task at a time; stop after each for user review.
