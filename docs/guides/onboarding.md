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

### Required

| Requirement | Minimum version | Why |
|-------------|-----------------|-----|
| Node.js     | 18.x LTS        | Build toolchain (webpack, ts-jest) |
| npm         | 9.x             | Dependency management and post-session validation |
| VS Code     | 1.85.0          | Extension host API surface |
| Git         | any recent      | Source control, checkpoints, undo |

### Optional (enhance agent capabilities)

| Tool | Purpose | Impact if missing |
|------|---------|-------------------|
| Python 3 | Python project support, Python-based MCP servers | Python MCP servers and Python project validation unavailable |
| gcloud CLI | GCP Vertex AI authentication (ADC/OAuth) | Cannot use Vertex AI auth — use API key for Gemini instead |
| Docker | Sandbox isolation for agent file writes | Sandbox mode unavailable — agents write directly to workspace |

### Platform notes

- **Windows**: Bormagi normalises all file paths to forward slashes internally. Backslash paths are handled automatically. If your `PATH` exceeds ~8000 characters, some tools may fail to resolve — consider cleaning up PATH entries.
- **macOS / Linux**: No special considerations.

> **Tip:** After launching the extension, run **`Bormagi: Check Environment`** from the Command Palette to see a live report of all detected tools, their versions, and what features they enable. This report is also shown automatically at the top of **Agent Settings**.

**Provider credentials (at least one):**

You need at least one provider credential to chat with agents (API key or OAuth identity, depending on provider). Supported options:

| Provider  | Model examples | Where to get a key |
|-----------|----------------|--------------------|
| OpenAI    | gpt-4o, gpt-4o-mini | [platform.openai.com](https://platform.openai.com/api-keys) |
| Anthropic | claude-sonnet-4-6, claude-haiku-4-5-20251001 | [console.anthropic.com](https://console.anthropic.com/) |
| Google    | gemini-2.0-flash, gemini-1.5-pro | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| DeepSeek  | deepseek-chat, deepseek-reasoner | [platform.deepseek.com](https://platform.deepseek.com/) |
| Qwen      | qwen-plus, qwen-max | [bailian.console.aliyun.com](https://bailian.console.aliyun.com/) |
| GCP Vertex AI (ADC/OAuth) | gemini-* via Vertex | `gcloud auth application-default login` |
| Ollama (local) | llama3.2, mistral, phi4 | `ollama pull <model>` — no key required |
| OpenRouter | any of 200+ models | [openrouter.ai/keys](https://openrouter.ai/keys) |

The last two rows use non-key auth patterns:
- **GCP Vertex AI (ADC/OAuth)** uses the `gemini` provider with auth method `vertex_ai`.
- **Ollama/OpenRouter** use the **Custom (OpenAI-compatible)** provider type.
See [§5 below](#5-configure-a-workspace-default-provider) for setup steps.

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

### Gemini auth modes (no project-specific secrets)

When using `provider = gemini`, choose one auth method:

1. `api_key`
2. `oauth_proxy`
3. `vertex_ai`

#### A) Gemini `api_key`

1. Create an API key in Google AI Studio.
2. In Agent Settings, set:
   - Provider: `gemini`
   - Auth Method: `API Key`
   - API Key: paste key

#### B) Gemini `oauth_proxy` (OAuth via proxy, no API key)

1. Sign in to Google Cloud CLI with ADC:
   - `gcloud auth application-default login`
2. In Agent Settings, set:
   - Provider: `gemini`
   - Auth Method: `OAuth Identity via Proxy (no API key)`
   - API Key: leave blank
   - Proxy URL: your proxy endpoint (optional if Base URL already points to proxy)
   - Base URL: optional endpoint override

#### C) Gemini `vertex_ai` (GCP Vertex AI + ADC/OAuth)

1. Authenticate and configure project:
   - `gcloud auth application-default login`
   - `gcloud config set project YOUR_PROJECT_ID`
   - `gcloud auth application-default set-quota-project YOUR_PROJECT_ID`
2. Enable Vertex API:
   - `gcloud services enable aiplatform.googleapis.com --project YOUR_PROJECT_ID`
3. In Agent Settings, set:
   - Provider: `gemini`
   - Auth Method: `GCP Vertex AI (ADC/OAuth)`
   - API Key: leave blank
   - Base URL: optional (defaults to `https://<LOCATION>-aiplatform.googleapis.com/v1`)
   - Proxy URL: optional (only if your org requires proxy routing)

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

### Check your environment first

Run **`Bormagi: Check Environment`** from the Command Palette. This scans your machine and reports:

- **OS** — Platform, version, architecture
- **Tools** — Git, npm, Node.js, Python, gcloud, Docker — each with status, version, and impact if missing
- **Path** — Separator, Windows-specific warnings

The same report appears automatically at the top of **Agent Settings**.

If any required tools are missing, install them before proceeding. Optional tools can be installed later.

### Verify provider connectivity

After completing step 5:

![Bormagi chat panel example](../assets/screenshots/chat-tab.svg)

Expected: A streaming response appears in the chat. Token usage stats appear at the top of the chat panel after the response completes.

If you see an error banner:

- Check that the API key is saved (see [§9 Common errors](#9-common-first-run-errors)).
- Check that the model name matches a model supported by your provider.
- For Gemini `vertex_ai`, confirm ADC is active:
  - `gcloud auth application-default print-access-token`
- For Gemini `oauth_proxy`, confirm your proxy accepts OAuth Bearer tokens and forwards Gemini streaming responses.

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
│   ├── mcp/             MCPHost, built-in MCP servers (filesystem, git, terminal, gcp, collaboration)
│   ├── meeting/         MeetingOrchestrator, MeetingStorage, types
│   │                    See "Meeting module" note below
│   ├── memory/          TurnMemory, Consolidator, DecisionManager, EnhancedSessionMemory
│   ├── collaboration/   FileMessageBus, DelegationManager
│   ├── knowledge/       KnowledgeManager, RetrievalService (Vector/RAG Storage)
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
| `.bormagi/memory/` | Semantic memory, decision logs, local vector DB for RAG |
| `.bormagi/shared/bus/` | Async inter-agent `.json` message bus |
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

### Meeting module architecture

The meeting module (`src/meeting/`) consists of three files:

| File | Responsibility |
|---|---|
| `types.ts` | All shared interfaces: `Meeting`, `AgendaItem`, `MeetingRound`, `SummaryRound`, `ActionPolicy`, `InterruptRequest` |
| `MeetingStorage.ts` | Read/write meeting JSON to `.bormagi/virtual-meetings/<id>/meeting.json` |
| `MeetingOrchestrator.ts` | All meeting runtime logic |

**Key orchestrator methods:**

| Method | What it does |
|---|---|
| `checkAgentsAvailability(ids)` | Calls `setupProvider()` per agent and returns `{ online, offline }` arrays |
| `runIntroductionRound(meeting, cb)` | Silent intro loop; stores rounds with `isIntroduction: true` |
| `runRound(meeting, agendaItemId, opts)` | One full round-robin turn for a given agenda item. Calls `rewriteGate` and `checkOffTopic` per agent |
| `rewriteGate(provider, systemPrompt, raw, policy?, agentId?)` | Validates the raw agent response for banned tags, code-change claims, and `ActionPolicy` violations; reprompts once if needed |
| `checkOffTopic(response, agendaItemId, meeting)` | Keyword heuristic that returns a violation string if the response is more about a different agenda item |
| `buildStrictMeetingRules(agentId, meeting, item?)` | Generates the rules section of the system prompt. Injects TOPIC GUARD, ACTION POLICY, and INTERRUPT POLICY when `item` is provided |
| `generateStructuredSummary(meeting, agendaItemId, closeoutHint?)` | Runs the moderator to produce a structured summary. `closeoutHint` forces a `deferred` status with a reason (used for human defer-intent) |
| `parseSummaryFields(raw)` | Regex-extracts all structured fields from a moderator summary including `itemStatus`, `deferReason`, and `blocker` |

**ActionPolicy modes** (`src/meeting/types.ts`):

| Mode | Behaviour |
|---|---|
| `NORMAL` | No restriction |
| `BLOCK_ALL_ACTIONS` | All agents blocked from emitting `ACTION:` |
| `ALLOW_ONLY_ACTIONS` | Only whitelisted agent IDs may emit `ACTION:` |
| `ALLOW_ONLY_TAGS` | All agents restricted to a specific set of output tags |

**SummaryRound.itemStatus values** (machine-readable, drives UI transitions):

`open` · `ready_for_human_decision` · `blocked` · `deferred` · `resolved`

---

### Adding a new agent

1. Create `predefined-agents/<your-agent-id>.json` following the schema of an existing agent.
2. Optionally add a system prompt file at `predefined-agents/<your-agent-id>/system_prompt.md`.
3. The agent appears automatically in the Agent Settings panel on next extension reload.

### Adding a new workflow template

See [`docs/workflow-developer-api.md`](../workflow-developer-api.md) for the full template schema and examples.

### Adding a new LLM provider

There are two ways to add a new provider, depending on whether it uses an OpenAI-compatible API or a unique wire protocol.

#### Option A — OpenAI-compatible endpoint (data only, no code change)

If the provider exposes an OpenAI-compatible `/chat/completions` API (Ollama, OpenRouter, Groq, Mistral, Together AI, LiteLLM, and many others), no code change is needed at all. Users select **Custom (OpenAI-compatible)** in Agent Settings and supply the base URL.

To make the provider appear as a named preset in the setup wizard and Agent Settings dropdown, add one entry to `data/providers.json`:

```json
{
  "label": "My New Provider",
  "type": "openai_compatible",
  "defaultModel": "my-model-v1",
  "authMethod": "api_key",
  "keyPlaceholder": "your-api-key"
}
```

No TypeScript changes. No rebuild required — `data/providers.json` is read at runtime.

#### Option B — Native provider (unique wire protocol)

Use this path only when the provider's streaming format cannot be expressed as an OpenAI-compatible endpoint (e.g. a new proprietary streaming protocol).

**Step 1 — Add the provider type.**

In [src/types.ts](../../src/types.ts), extend the `ProviderType` union:

```typescript
export type ProviderType =
  | 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'qwen'
  | 'openai_compatible'
  | 'my_new_provider';   // ← add here
```

**Step 2 — Implement the provider class.**

Create `src/providers/MyNewProvider.ts` implementing `ILLMProvider`:

```typescript
import { ILLMProvider } from './ILLMProvider';
import { ChatMessage, MCPToolDefinition, StreamEvent } from '../types';

export class MyNewProvider implements ILLMProvider {
  readonly providerType = 'my_new_provider';
  readonly model: string;

  constructor(options: { apiKey: string; model: string }) {
    this.model = options.model;
  }

  async *stream(
    messages: ChatMessage[],
    tools?: MCPToolDefinition[],
    maxTokens = 4096
  ): AsyncIterable<StreamEvent> {
    // Translate messages → provider request, stream response,
    // normalise each chunk to StreamEvent (text / tool_use / token_usage / done).
    yield { type: 'done' };
  }
}
```

Key normalisation rules for `stream()`:

| StreamEvent type | When to emit |
|---|---|
| `{ type: 'text', delta: string }` | Each text fragment as it arrives |
| `{ type: 'tool_use', id, name, input }` | Once per complete tool call (after accumulating streamed JSON) |
| `{ type: 'token_usage', usage }` | Once per response, when the provider reports token counts |
| `{ type: 'done' }` | At the end of the response (always last) |

**Step 3 — Wire it into ProviderFactory.**

In [src/providers/ProviderFactory.ts](../../src/providers/ProviderFactory.ts), add a `case` inside the `switch`:

```typescript
import { MyNewProvider } from './MyNewProvider';

// inside ProviderFactory.create():
case 'my_new_provider':
  return new MyNewProvider({
    apiKey,
    model: provider.model
  });
```

**Step 4 — Add provider data.**

Add a model list entry to `data/models.json` under `providerModels`:

```json
"my_new_provider": ["model-name-v1", "model-name-v2"]
```

Add a preset entry to `data/providers.json`:

```json
{
  "label": "My New Provider",
  "type": "my_new_provider",
  "defaultModel": "model-name-v1",
  "authMethod": "api_key",
  "keyPlaceholder": "your-api-key"
}
```

**Step 5 — Verify.**

```bash
npx tsc --noEmit      # must be zero errors (exhaustive switch check enforces this)
npx jest --no-coverage
```

The TypeScript exhaustive-check in `ProviderFactory` (`const exhaustiveCheck: never = provider.type`) will produce a compile error if you add a new `ProviderType` value without also adding a matching `case`. This ensures no provider type is ever silently unhandled.

### Adding a new MCP server

1. Implement the server in `src/mcp/<your-server>.ts` following the pattern of `filesystem-server.ts`.
2. Register it in `src/mcp/MCPHost.ts`.
3. Add tool definitions to the agent's available tools list.

---

*Last updated: 2026-03-02*
