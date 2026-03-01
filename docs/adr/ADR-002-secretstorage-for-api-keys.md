# ADR-002: VS Code `SecretStorage` for API Key Persistence

**Date:** 2026-01-15
**Status:** Accepted
**Deciders:** Core team

## Context

Bormagi agents call external AI provider APIs (OpenAI, Anthropic, Gemini, DeepSeek, Qwen, GCP). Each call requires an API key. These keys must be persisted between VS Code sessions but must never be written to disk in plain text or committed to version control.

Options considered:
- Store keys in `.bormagi/config.json` (plain text on disk)
- Store keys in VS Code settings (`settings.json`)
- Store keys in VS Code `SecretStorage` (OS keychain-backed)
- Environment variables (not persistent across restarts)

## Decision

Use VS Code's `SecretStorage` API (`context.secrets`) exclusively for API key storage, accessed through the `SecretsManager` class (`src/config/SecretsManager.ts`).

Keys are namespaced as `bormagi.apikey.<agentId>`. The workspace default key is stored as `bormagi.apikey.__default__`. Keys are read at agent invocation time and passed in-memory only.

## Consequences

### Positive
- Keys are backed by the OS keychain (Windows Credential Manager, macOS Keychain, Linux `libsecret`).
- Keys survive VS Code restarts without ever touching disk.
- Zero risk of accidental commit — keys are never in the workspace file tree.
- `SecretStorage` is encrypted at rest by the OS.

### Negative / Trade-offs
- Keys are not portable across machines. Users must re-enter on each machine.
- In CI/CD environments without a GUI keychain, keys must be supplied via environment variables (not handled automatically by this extension; out of scope).
- Key rotation requires manual re-entry through the settings panel.

### Neutral
- The `SecretsManager` wrapper (`get`, `set`, `delete`, `list`) provides a stable API independent of the VS Code secrets internals.

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| Plain text in `config.json` | Unacceptably insecure — trivially committed to git |
| VS Code `settings.json` | Plain text; synced via Settings Sync — keys could leak to cloud |
| Environment variables | Not persistent across VS Code restarts |
| Encrypted local file with user passphrase | Complex UX; re-implements functionality OS already provides |
