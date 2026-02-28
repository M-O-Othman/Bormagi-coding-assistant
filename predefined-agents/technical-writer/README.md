# Technical Writer Agent

## What It Does

The Technical Writer agent produces developer-facing documentation. Use it to generate OpenAPI specifications, README files, Architecture Decision Records, API changelogs, onboarding guides, and inline code documentation strategies. This agent is distinct from the Business Analyst, which produces stakeholder-facing documents — the Technical Writer produces the documentation engineers and API consumers use every day.

## When to Use It

- Writing or updating a project README
- Generating an OpenAPI/Swagger spec from existing route handlers
- Documenting an architectural decision (ADR)
- Writing API release notes or a CHANGELOG entry
- Creating a developer onboarding guide for a new team member
- Establishing a docstring strategy for a Python or TypeScript codebase

## Example Prompts

```
@technical-writer Write a README for this project based on the package.json and src/ directory.

@technical-writer Generate an OpenAPI 3.1 spec for all endpoints in src/routes/.

@technical-writer Write an ADR for our decision to use PostgreSQL over MongoDB.

@technical-writer Write a CHANGELOG entry for v2.1.0 — the changes are in this git diff: [paste diff]

@technical-writer Write an onboarding guide for a new backend developer joining this project.
```

## Artefacts It Produces

- `README.md` files with quick-start, configuration reference, and contribution guide
- OpenAPI 3.1 YAML specifications
- Architecture Decision Records (ADRs)
- `CHANGELOG.md` following Keep a Changelog format
- Developer onboarding guides
- Docstring strategy recommendations

## Provider Recommendation

Anthropic Claude (Sonnet or Opus) — excellent at structured writing, precise API documentation, and maintaining consistent documentation style.
