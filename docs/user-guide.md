# Bormagi User Guide

## 1) What Bormagi does
Bormagi is a VS Code extension for multi-agent coding workflows. It helps you:
- configure providers and models,
- run specialized agents,
- switch execution modes (Ask / Plan / Code),
- track state and progress in `.bormagi/`.

---

## 2) First-time setup (simplified)
On first launch in a workspace with no `.bormagi/config.json`, Bormagi runs setup.

### Setup flow
The setup wizard now intentionally skips role and manual agent-picking steps:
1. Choose default provider.
2. Confirm model and auth method.
3. Enter API key/token if required.
4. Bormagi installs **all predefined agents automatically**.

### Post-setup defaults
After setup completes, Bormagi now:
- refreshes the chat agent list,
- sets active agent to **Advanced Coder** (fallback: first installed),
- sets mode to **Code**.

---

## 3) Core UI surfaces

### Chat panel
- Send requests to the active agent.
- Use `@agent-id` mention to switch active agent inline.
- Watch status for provider/model/mode.

### Agent Settings
- Configure workspace default provider.
- Configure per-agent provider overrides.
- Set auth methods for supported providers.

### Commands
Use Command Palette:
- `Bormagi: Open Chat`
- `Bormagi: Open Agent Settings`
- `Bormagi: Select Active Agent`
- `Bormagi: Switch Mode (Ask / Plan / Code)`

---

## 4) Modes and intended usage

### Ask mode
- Read-oriented responses.
- No source-file mutation expected.

### Plan mode
- Produce plans/specification artifacts first.
- Lower mutation surface.

### Code mode
- Direct implementation and edits.
- Best for feature work and bug fixes.

---

## 5) Execution process and reliability controls
Bormagi uses process-level controls to reduce looping and inconsistent state:
- step-contract guidance per turn,
- contract-aware tool narrowing,
- deterministic execution state,
- fallback recovery only when needed.

### Logging
Per-agent logs are written to:
- `.bormagi/logs/<agent-id>.log`

System prompt content is redacted in logs and represented by source references.

---

## 6) Project state folder
Bormagi stores workspace state under `.bormagi/`:
- `config.json` for project/provider settings,
- execution and audit artifacts,
- logs and plan/state files.

Secrets are stored in VS Code Secret Storage (not plain text in project files).

---

## 7) Troubleshooting

### Setup did not appear
- Run `Bormagi: Initialise Workspace` manually.

### Agent not writing files
- Ensure mode is **Code**.
- Check `.bormagi/logs/<agent>.log` for tool activity.
- Verify provider credential is configured.

### Provider/auth errors
- Re-open Agent Settings.
- Validate auth method and credential/token.

### Stale behaviour after update
- Reload VS Code window.
- Rebuild/reinstall VSIX if testing packaged artifact.

---

## 8) Recommended quick start
1. Open workspace.
2. Complete setup (provider/model/auth).
3. Start in Chat with default **Advanced Coder** in **Code** mode.
4. Ask for a concrete implementation task.
5. Review written files and run tests.

---

## 9) Notes for teams
- Use workspace default provider to keep configuration consistent.
- Keep `.bormagi/` in `.gitignore` where applicable.
- Use explicit mode changes for predictable behaviour.
