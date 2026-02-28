# Skill: Git Workflow Conventions

Apply these conventions when working with git — creating commits, naming branches, writing PR descriptions, and deciding on merge strategies. Consistent git hygiene makes the history readable, bisectable, and release-note-friendly.

## Commit Message Format (Conventional Commits)

Every commit message follows the Conventional Commits specification:

```
<type>(<scope>): <short summary>

[Optional body — explain WHY, not what]

[Optional footer — breaking changes, issue refs]
```

### Types

| Type | Use when |
|---|---|
| `feat` | A new feature visible to users or API consumers |
| `fix` | A bug fix |
| `refactor` | Code restructuring with no behaviour change |
| `perf` | Performance improvement |
| `test` | Adding or fixing tests |
| `docs` | Documentation only |
| `chore` | Build scripts, dependency updates, tooling |
| `ci` | CI/CD pipeline changes |
| `style` | Formatting only (no logic change) |
| `revert` | Reverting a previous commit |

### Rules

- **Subject line**: 50 characters or fewer. Imperative mood. No full stop. Lowercase after the colon.
  - Good: `feat(auth): add refresh token rotation`
  - Avoid: `Added the refresh token rotation feature.`
- **Body** (optional): wrap at 72 characters. Explain *why* the change was made, not what the diff shows.
- **Breaking changes**: prefix the footer with `BREAKING CHANGE:` — this triggers a major version bump in semantic-release.
- **Issue references**: `Closes #123` or `Fixes #456` in the footer.

### Examples

```
feat(documents): add cursor-based pagination to list endpoint

Replaces offset pagination which was causing inconsistent results
under concurrent writes. Cursor is base64-encoded JSON of the last
seen id and created_at timestamp.

Closes #88
```

```
fix(auth): prevent refresh token reuse after rotation

A rotated token was remaining valid for 30 seconds due to a Redis
TTL race condition. Now invalidated immediately on first use.

Fixes #102
```

```
chore(deps): upgrade openai sdk to 4.28.0

Resolves CVE-2025-1234 in the streaming parser.
```

## Branch Naming

```
<type>/<short-description>
```

- Use the same type prefixes as commits: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`.
- Use kebab-case for the description.
- Include a ticket reference where applicable: `feat/AUTH-42-refresh-token-rotation`.
- Keep it short — branch names appear in PR titles, merge commits, and CI logs.

| Good | Avoid |
|---|---|
| `feat/cursor-pagination` | `feature/addCursorPaginationToDocuments` |
| `fix/auth-token-race` | `johns-branch` |
| `chore/upgrade-openai-sdk` | `fix` |

## Pull Request Template

```markdown
## Summary
[1–3 bullet points describing what changed and why]

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation

## Testing
[Describe how you tested this change]
- [ ] Unit tests added / updated
- [ ] Integration tests pass
- [ ] Manually tested: [describe scenario]

## Checklist
- [ ] Code follows the project's style guide
- [ ] Self-review completed
- [ ] Tests cover the changed logic
- [ ] No secrets or credentials committed
- [ ] Documentation updated if behaviour changed
```

## Merge Strategy

| Scenario | Strategy | Why |
|---|---|---|
| Feature branch → main | **Squash merge** | One clean commit per feature in the history |
| Release branch → main | **Merge commit** | Preserves the release branch history |
| Hotfix → main + release | **Cherry-pick** | Apply the fix to both branches without merging unrelated changes |
| Long-lived fork diverged from main | **Rebase** (locally) then merge | Linear history; do not merge in both directions |

### Squash Merge Rules

When squashing, the resulting commit message must follow Conventional Commits — use the PR title as the subject line (this is why PR titles must also follow the format).

## What to Never Commit

- `.env` files or any file containing real secrets or credentials
- Build artefacts (`dist/`, `build/`, `__pycache__/`, `.class` files)
- IDE settings that are personal, not project-wide (`.idea/`, `.vscode/settings.json`)
- `package-lock.json` or `yarn.lock` changes that are not part of a dependency update
- Files over 5 MB (use Git LFS or external storage)

Add these to `.gitignore` before the first commit — removing them from history after the fact is painful.

## Tagging and Releases

Follow **Semantic Versioning** (semver): `MAJOR.MINOR.PATCH`

- `PATCH` bump: bug fixes, no new API surface
- `MINOR` bump: new backwards-compatible features
- `MAJOR` bump: breaking changes (deprecated in CHANGELOG first)

Tag format: `v1.2.3` (prefix `v` is conventional and supported by most tooling).

Create tags only from the main/release branch, never from feature branches.
