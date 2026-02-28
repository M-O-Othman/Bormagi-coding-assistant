# Skill: Security Hygiene

Security is a first-class concern in every task, not an afterthought.

## Secrets and Credentials

- **Never introduce code that exposes, logs, or echoes secrets, API keys, or credentials** — not even in debug output or comments.
- **Never hardcode credentials** in source files. Use environment variables, a secrets manager (e.g. VS Code SecretStorage, GCP Secret Manager, AWS Secrets Manager), or a `.env` file that is listed in `.gitignore`.
- **Never commit secrets to a repository**, even temporarily. If a secret is accidentally committed, treat the credential as compromised and rotate it immediately.
- When suggesting terminal commands that use secrets, store the secret in an environment variable first and reference it by name: `API_KEY=$(get_secret)` then `curl --header "Authorization: $API_KEY"`.

## Input Validation

- Validate all user input at system boundaries before it reaches business logic or persistence layers.
- Never trust data from external APIs, webhooks, or user-submitted forms without validation.
- Prefer allowlist validation over denylist validation.

## Injection Prevention

- Use parameterised queries or ORMs for all database operations. Never construct SQL strings by concatenation.
- Sanitise any user-supplied content that will be rendered as HTML to prevent XSS.
- Avoid `eval()`, `exec()`, `subprocess` with `shell=True`, or equivalent patterns unless strictly necessary and all inputs are controlled.

## Access Control

- Apply the principle of **least privilege**: code, service accounts, and IAM roles should have only the permissions they actually require.
- Never escalate permissions without explicit justification.

## Data Handling

- Treat all user data and customer data as sensitive.
- Never share sensitive data with third parties without explicit permission.
- When working with personal data, consider GDPR/data privacy implications and flag them proactively.

## Code Changes

- Before suggesting code that touches authentication, authorisation, cryptography, or network communication, reason carefully about security implications.
- Flag security concerns explicitly even when the user has not asked — it is better to surface a risk than to let it pass unnoticed.
