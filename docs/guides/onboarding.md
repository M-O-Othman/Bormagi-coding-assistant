# Developer Onboarding Guide

This guide gets you from a fresh checkout to a fully working development environment for the Bormagi VS Code extension.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone and install](#2-clone-and-install)
3. [Build the extension](#3-build-the-extension)
4. [Run in development mode](#4-run-in-development-mode)
5. [Configure a workspace default provider](#5-configure-a-workspace-default-provider)
6. [Verify the extension works end-to-end](#6-verify-the-extension-works-end-to-end)
7. [Run the test suite](#7-run-the-test-suite)
8. [Project structure quick-reference](#8-project-structure-quick-reference)
9. [Common first-run errors](#9-common-first-run-errors)
10. [Contribution workflow](#10-contribution-workflow)

---

## 1. Prerequisites

| Requirement | Minimum version | Why |
|-------------|-----------------|-----|
| Node.js     | 18.x LTS        | Build toolchain (webpack, ts-jest) |
| npm         | 9.x             | Dependency management |
| VS Code     | 1.85.0          | Extension host API surface |
| Git         | any recent      | Source control |

**API key (at least one):**

You need at least one AI provider API key to chat with agents. Supported providers:

| Provider  | Model examples | Where to get a key |
|-----------|----------------|--------------------|
| OpenAI    | gpt-4o, gpt-4o-mini | [platform.openai.com](https://platform.openai.com/api-keys) |
| Anthropic | claude-sonnet-4-6, claude-haiku-4-5-20251001 | [console.anthropic.com](https://console.anthropic.com/) |
| Google    | gemini-2.0-flash, gemini-1.5-pro | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| DeepSeek  | deepseek-chat, deepseek-reasoner | [platform.deepseek.com](https://platform.deepseek.com/) |
| Qwen      | qwen-plus, qwen-max | [bailian.console.aliyun.com](https://bailian.console.aliyun.com/) |
| GCP (ADC) | gemini-* via Vertex | `gcloud auth application-default login` |

---

## 2. Clone and install

```bash
git clone https://github.com/bormagi/bormagi-extension.git
cd bormagi-extension
npm install
```

This installs all compile-time and runtime dependencies defined in `package.json`.

> **Note:** The `node_modules` directory is excluded from the packaged extension via `.vscodeignore`. Do not commit it.

---

## 3. Build the extension

```bash
# Development build (fast, includes source maps)
npm run compile

# Production build (minified, no source maps — matches what gets packaged)
npm run package
```

Both commands run webpack and output to `dist/extension.js`.

### Type-check only (no output)

```bash
npx tsc --noEmit
```

Use this to check for type errors without emitting files — faster than a full compile.

### Lint

```bash
npm run lint
```

Uses ESLint with TypeScript rules. Must pass before CI will succeed.

---

## 4. Run in development mode

1. Open the `bormagi-extension` folder in VS Code.
2. Press **F5** (or go to **Run → Start Debugging**).
3. A new **Extension Development Host** window opens with Bormagi loaded.
4. In the Extension Development Host window:
   - Open the Bormagi sidebar (click the Bormagi icon in the Activity Bar).
   - The chat panel appears.

> **Hot reload:** After editing a TypeScript source file, run `npm run compile` again, then run the "Reload Window" command in the Extension Development Host to pick up changes.

---

## 5. Configure a workspace default provider

Bormagi stores API keys securely in VS Code's `SecretStorage` (keyring). Keys are never written to disk in plain text.

### Step 1 — Set a workspace default provider

1. In the Extension Development Host window, open the chat panel.
2. Click the **gear icon** (⚙) in the toolbar to open Agent Settings.
3. Click **Workspace Defaults**.
4. Choose a provider (e.g. `openai`) and enter a model name (e.g. `gpt-4o-mini`).
5. Click **Save Default Provider**.
6. Enter your API key when prompted.

### Step 2 — Apply to all agents

In the Agent Settings panel:

1. Click **Apply to all agents**.

This sets `useDefaultProvider: true` on every agent, so they all use the workspace-level provider and API key instead of requiring individual keys.

### Step 3 — Verify

Back in the chat panel:

1. Select any agent from the dropdown.
2. The provider badge (top-right of the toolbar) should appear, showing the provider name.
3. Type a message. If the badge says `[default]`, the workspace default key is being used.

---

## 6. Verify the extension works end-to-end

After completing step 5:

```
Chat panel → select "Business Analyst" agent → type "Hello"
```

Expected: A streaming response appears in the chat. Token usage stats appear at the top of the chat panel after the response completes.

If you see an error banner:

- Check that the API key is saved (see [§9 Common errors](#9-common-first-run-errors)).
- Check that the model name matches a model supported by your provider.

---

## 7. Run the test suite

```bash
# All tests (workflow + integration)
npx jest --no-coverage

# Integration tests only
npx jest "src/tests/integration" --no-coverage

# Workflow unit tests only
npx jest "src/workflow/tests" --no-coverage

# Single test file
npx jest src/tests/integration/meeting-storage.test.ts --no-coverage
```

### Test configuration

- **Runner:** Jest + ts-jest
- **Config:** `jest.config.js`
- **tsconfig for tests:** `tsconfig.test.json`
- **VS Code mock:** `src/__mocks__/vscode.ts`
- **Test directories:**
  - `src/workflow/tests/` — workflow engine unit and integration tests
  - `src/tests/integration/` — meeting, context-window, and storage integration tests

All tests run in Node.js — no VS Code process required.

### CI gates (GitHub Actions)

On every push / pull request to `master` or `main`, the CI workflow (`.github/workflows/ci.yml`) runs:

1. `npm run lint` — ESLint
2. `npm run compile` — webpack build
3. `npm audit --audit-level=high` — dependency vulnerability scan
4. Gitleaks secrets scan

All gates must pass before a PR can merge.

---

## 8. Project structure quick-reference

```
bormagi-extension/
├── src/
│   ├── agents/          AgentRunner, AgentManager, PromptComposer, MemoryManager, UndoManager
│   ├── audit/           AuditLogger (JSONL event log)
│   ├── chat/            ChatController, ChatViewProvider (webview)
│   ├── config/          ConfigManager (reads/writes .bormagi/ config files)
│   ├── mcp/             MCPHost, built-in MCP servers (filesystem, git, terminal, gcp)
│   ├── meeting/         MeetingOrchestrator, MeetingStorage, types
│   ├── providers/       ProviderFactory, OpenAI / Anthropic / Gemini / DeepSeek / Qwen adapters
│   ├── skills/          SkillManager (loads .claude/skills/)
│   ├── ui/              MeetingPanel, AgentSettingsPanel
│   ├── utils/           FileScanner, DocumentGenerator (docx/pptx)
│   ├── workflow/        WorkflowEngine and all sub-components (see workflow-developer-api.md)
│   ├── __mocks__/       vscode.ts — Jest mock for VS Code API
│   ├── extension.ts     Extension entry point
│   └── types.ts         Shared TypeScript types (ChatMessage, StreamEvent, …)
│
├── media/
│   ├── chat.html        Chat panel WebView
│   ├── meeting-room.html Virtual meeting panel WebView
│   ├── workflow-board.html Workflow Kanban board WebView
│   └── styles.css       Shared design system (canonical CSS reference)
│
├── predefined-agents/   JSON definitions for built-in agents
├── predefined-skills/   YAML skill definitions
├── predefined-workflows/ JSON workflow templates (feature-delivery, bug-fix, architecture-spike)
│
├── docs/
│   ├── guides/
│   │   └── onboarding.md        ← You are here
│   ├── workflow-developer-api.md
│   └── workflow-examples.md
│
├── .bormagi/            Created at runtime per workspace (config, memory, audit log)
├── dist/                webpack output (committed for packaging, not for editing)
├── jest.config.js
├── tsconfig.json
├── tsconfig.test.json
├── webpack.config.js
└── package.json
```

### Key runtime paths

| Path | Contents |
|------|----------|
| `.bormagi/config.json` | Workspace provider config (model, type, auth_method) |
| `.bormagi/agents/<id>/` | Per-agent memory and overrides |
| `.bormagi/audit.jsonl` | Append-only structured audit log |
| `.bormagi/Memory.md` | Long-term conversation memory (Markdown) |
| `.bormagi/workflows/<id>/` | Workflow state (JSON + JSONL) |
| `.bormagi/virtual-meetings/<id>/` | Meeting state + minutes |

---

## 9. Common first-run errors

### "No API key configured for agent"

**Symptom:** Error banner in the chat panel after sending a message.

**Fix:**
1. Open Agent Settings (gear icon).
2. Set the Workspace Default Provider with a valid API key.
3. Click **Apply to all agents**.

### "Activation failed: Cannot find module './dist/extension.js'"

**Symptom:** Extension fails to activate; VS Code shows an error notification.

**Fix:** Run `npm run compile` and reload the Extension Development Host window.

### "TypeError: Cannot read properties of undefined"

**Symptom:** Error in the extension host console (Help → Toggle Developer Tools).

**Fix:** Usually caused by running against an older VS Code version. Ensure VS Code ≥ 1.85.0.

### `npm install` fails with peer dependency errors

**Symptom:** `ERESOLVE` errors during `npm install`.

**Fix:** Run `npm install --legacy-peer-deps`. The `docx` package (ESM-only) may conflict with older npm peer resolution algorithms.

### Tests fail with "duplicate manual mock found: vscode"

**Symptom:** Jest warning, possibly failing tests.

**Fix:** Delete the compiled mock at `out/__mocks__/vscode.js` (stale output from a previous `compile-tests` run). The live mock at `src/__mocks__/vscode.ts` is the correct one.

### Secrets scan fails on CI ("gitleaks found a leak")

**Symptom:** The `secrets-scan` CI job fails.

**Fix:** Check that no API keys, tokens, or secrets were committed to the repository. If it is a false positive, add an allowlist entry to `.gitleaks.toml`.

---

## 10. Contribution workflow

1. **Branch** from `main` with a descriptive name: `feat/my-feature` or `fix/bug-description`.
2. **Implement** — follow the code standards in `CLAUDE.md` and `docs/` guides.
3. **Test** — run `npx jest --no-coverage` and confirm all tests pass.
4. **Type-check** — run `npx tsc --noEmit`.
5. **Lint** — run `npm run lint`.
6. **Commit** with a descriptive message.
7. **Open a PR** — CI runs automatically. All gates must pass before review.

### Adding a new agent

1. Create `predefined-agents/<your-agent-id>.json` following the schema of an existing agent.
2. Optionally add a system prompt file at `predefined-agents/<your-agent-id>/system_prompt.md`.
3. The agent appears automatically in the Agent Settings panel on next extension reload.

### Adding a new workflow template

See [`docs/workflow-developer-api.md`](../workflow-developer-api.md) for the full template schema and examples.

### Adding a new MCP server

1. Implement the server in `src/mcp/<your-server>.ts` following the pattern of `filesystem-server.ts`.
2. Register it in `src/mcp/MCPHost.ts`.
3. Add tool definitions to the agent's available tools list.

---

*Last updated: 2026-03-01*
