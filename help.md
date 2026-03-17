# Bormagi User Guide

> **Version 0.1.0** | AI Coding Agent Manager for Visual Studio Code

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Installation](#2-installation)
3. [First-Time Setup](#3-first-time-setup)
4. [Interface Overview](#4-interface-overview)
5. [Working with Agents](#5-working-with-agents)
6. [Execution Modes](#6-execution-modes)
7. [Chat Interface](#7-chat-interface)
8. [Agent Settings and Provider Configuration](#8-agent-settings-and-provider-configuration)
9. [Sandbox Mode](#9-sandbox-mode)
10. [Virtual Meetings](#10-virtual-meetings)
11. [Checkpoint and History Management](#11-checkpoint-and-history-management)
12. [Execution Engine and Runtime Behaviour](#12-execution-engine-and-runtime-behaviour)
13. [Logging and Diagnostics](#13-logging-and-diagnostics)
14. [Audit Trail](#14-audit-trail)
15. [Knowledge Base](#15-knowledge-base)
16. [Project State and Configuration Reference](#16-project-state-and-configuration-reference)
17. [VS Code Settings Reference](#17-vs-code-settings-reference)
18. [Command Reference](#18-command-reference)
19. [Predefined Agents](#19-predefined-agents)
20. [Predefined Skills](#20-predefined-skills)
21. [Advanced Usage](#21-advanced-usage)
22. [Troubleshooting](#22-troubleshooting)
23. [FAQ](#23-faq)
24. [Support and Feedback](#24-support-and-feedback)

---

## 1. Introduction

**Bormagi** is a Visual Studio Code extension that brings multi-agent AI coding workflows directly into your editor. It allows you to create, configure, and interact with specialised AI agents — each powered by the LLM provider and model of your choice — to accelerate software development tasks such as writing code, reviewing architecture, generating documentation, and more.

### What sets Bormagi apart

- **Multi-agent architecture** — Run multiple specialised agents in the same workspace, each with its own system prompt, provider, and knowledge base.
- **Provider-agnostic** — Works with OpenAI, Anthropic (Claude), Google Gemini, Deepseek, Qwen, and any OpenAI-compatible endpoint (Ollama, OpenRouter, LM Studio, etc.).
- **Three execution modes** — Ask, Plan, and Code modes give you precise control over what the agent is allowed to do.
- **Built-in reliability controls** — Step contracts, discovery budgets, loop detection, and deterministic state management prevent agents from wasting iterations.
- **Full audit trail** — Every action, mode change, and tool call is logged for accountability and debugging.
- **Per-workspace state** — All configuration and state lives in `.bormagi/`, making it portable and team-friendly.

<!-- SCREENSHOT: Bormagi activity bar icon and chat panel overview -->
> **[Screenshot placeholder]** — The Bormagi sidebar showing the Chat panel with an active agent conversation.

---

## 2. Installation

### From VS Code Marketplace

1. Open **VS Code**.
2. Go to the **Extensions** panel (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Search for **Bormagi**.
4. Click **Install**.

### From a VSIX file

1. Download the `.vsix` file from the [Releases page](https://github.com/M-O-Othman/Bormagi-coding-assistant/releases).
2. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Run **Extensions: Install from VSIX...** and select the downloaded file.
4. Reload the window when prompted.

### Requirements

| Requirement | Minimum |
|-------------|---------|
| VS Code | 1.85.0 or later |
| Node.js | 18.x or later (for building from source) |
| API Key | At least one LLM provider key (or a local model via Ollama) |

<!-- SCREENSHOT: VS Code extensions panel showing Bormagi installed -->
> **[Screenshot placeholder]** — The Extensions panel after Bormagi has been installed.

---

## 3. First-Time Setup

When you open a workspace that does not have a `.bormagi/` folder, Bormagi automatically launches the **Setup Wizard**. The wizard consists of two steps:

### Step 1 of 2 — Choose a Default Provider

Select the AI provider you want to use as the workspace default:

| Provider | Default Model | Auth Method |
|----------|--------------|-------------|
| **OpenAI** | gpt-5.1 | API Key |
| **Anthropic (Claude)** | claude-sonnet-4-6 | API Key or Subscription Token |
| **Google Gemini** | gemini-2.5-pro | API Key, OAuth Proxy, or Vertex AI |
| **Deepseek** | deepseek-chat | API Key |
| **Qwen** | qwen-max | API Key |
| **OpenAI-Compatible** | (custom) | API Key (optional) |

After selecting a provider:
- **Confirm or change the model name** — You can type any model identifier supported by your provider.
- **Choose an authentication method** — For Anthropic and Gemini, you can pick between API Key and alternative auth flows (subscription token, OAuth, Vertex AI).
- **Enter a base URL** (OpenAI-Compatible only) — e.g., `http://localhost:11434/v1` for Ollama.

<!-- SCREENSHOT: Setup wizard step 1 — provider selection quick-pick -->
> **[Screenshot placeholder]** — The provider selection dialog during first-time setup.

### Step 2 of 2 — Enter API Key or Token

Enter your API key or authentication token. It is stored securely in **VS Code SecretStorage** — never in plain text on disk.

- For **OpenAI-Compatible** endpoints that do not require a key (e.g., local Ollama), you may leave this field blank.

<!-- SCREENSHOT: Setup wizard step 2 — API key input (password field) -->
> **[Screenshot placeholder]** — The API key entry dialog (input is masked for security).

### Automatic Post-Setup

After the wizard completes, Bormagi automatically:

1. Creates the `.bormagi/` folder structure.
2. Adds `.bormagi/` to `.gitignore` (if not already present).
3. **Installs all 11 predefined agents** — no manual selection needed.
4. Sets the **active agent** to **Advanced Coder** (fallback: first installed agent).
5. Sets the **execution mode** to **Code**.

You are now ready to use Bormagi.

<!-- SCREENSHOT: Information message "Bormagi is ready! 11 agent(s) installed." -->
> **[Screenshot placeholder]** — The confirmation notification after setup completes.

---

## 4. Interface Overview

Bormagi adds a dedicated sidebar to VS Code with two main views:

### Activity Bar

Click the **Bormagi icon** in the Activity Bar (left sidebar) to open the Bormagi panel.

<!-- SCREENSHOT: Activity bar with Bormagi icon highlighted -->
> **[Screenshot placeholder]** — The Bormagi icon in the VS Code Activity Bar.

### Chat View

The primary interaction surface. Features include:
- **Message input** at the bottom for sending requests.
- **Agent responses** displayed as chat bubbles with formatted markdown.
- **Thought trace** (expandable) showing tool calls, execution state, and internal reasoning.
- **Status bar** at the top showing: active agent name, current mode, and provider/model.
- **Mode switcher** for toggling between Ask, Plan, and Code.
- **Agent selector** for switching the active agent.

<!-- SCREENSHOT: Full chat view with a conversation in progress -->
> **[Screenshot placeholder]** — The Chat panel showing a conversation with the Advanced Coder agent.

### History View

The **History** tab displays Git checkpoints created by Bormagi before each task. You can review and restore previous states.

<!-- SCREENSHOT: The History panel showing checkpoint entries -->
> **[Screenshot placeholder]** — The Checkpoint History panel with timestamped entries.

---

## 5. Working with Agents

### What is an agent?

An agent is an AI assistant with a specific persona, system prompt, and optional knowledge base. Each agent is defined by a configuration file (`agent.json`) and a system prompt (`system-prompt.md`) stored under `.bormagi/agents/<agent-id>/`.

### Selecting an agent

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **Bormagi: Select Active Agent**.
3. Pick from the list of installed agents.

Alternatively, type `@agent-id` in the chat input to mention and switch to a specific agent inline.

<!-- SCREENSHOT: The agent selection quick-pick dialog -->
> **[Screenshot placeholder]** — The agent selection dialog listing all installed agents.

### Creating a custom agent

1. Run **Bormagi: Create New Agent** from the Command Palette.
2. Enter an agent ID (lowercase, hyphens allowed, e.g., `my-custom-agent`).
3. Edit the generated `system-prompt.md` to define the agent's persona and instructions.
4. (Optional) Configure a per-agent provider override in Agent Settings.

### Installing predefined agents

If you skipped setup or want to re-install agents:

1. Run **Bormagi: Install Predefined Agents** from the Command Palette.
2. All 11 predefined agents will be installed to your workspace.

### Agent configuration structure

```
.bormagi/
  agents/
    advanced-coder/
      agent.json           # Agent metadata and provider config
      system-prompt.md     # System prompt (persona + instructions)
    solution-architect/
      agent.json
      system-prompt.md
    ...
```

---

## 6. Execution Modes

Bormagi supports three execution modes that control what the agent is permitted to do. Switch modes via the Command Palette: **Bormagi: Switch Mode (Ask / Plan / Code)**.

### Ask Mode

| Property | Value |
|----------|-------|
| **Purpose** | Information retrieval, explanation, Q&A |
| **File reads** | Allowed |
| **File writes** | Not expected |
| **Best for** | Understanding code, getting explanations, exploring options |

The agent can read workspace files and answer questions but will not create or modify source files.

### Plan Mode

| Property | Value |
|----------|-------|
| **Purpose** | Architecture, design, and planning |
| **File reads** | Allowed |
| **File writes** | Plan artifacts only (e.g., `PLAN-<timestamp>.md`) |
| **Best for** | Designing features, creating specifications, breaking down tasks |

The agent produces structured plans and design documents. These plan artifacts can later be approved and used as implementation guides in Code mode.

### Code Mode

| Property | Value |
|----------|-------|
| **Purpose** | Implementation, editing, and file generation |
| **File reads** | Allowed |
| **File writes** | Allowed (source files, configs, etc.) |
| **Best for** | Writing code, fixing bugs, implementing features |

The agent has full read/write access to workspace files. This is the most powerful mode and the default after setup.

<!-- SCREENSHOT: The mode switcher showing Ask / Plan / Code options -->
> **[Screenshot placeholder]** — The mode selection quick-pick in the Command Palette.

---

## 7. Chat Interface

### Sending a message

Type your request in the input box at the bottom of the Chat panel and press **Enter** (or click Send). The active agent will process your request according to the current execution mode.

### Effective prompting tips

| Tip | Example |
|-----|---------|
| **Name specific files** | "Update `clock.html` to add a dark mode toggle" |
| **Be concrete** | "Write a function that validates email addresses in `utils/validation.ts`" |
| **Specify scope** | "Only modify the `handleSubmit` function — do not change anything else" |
| **Reference mode** | "In Plan mode, design the database schema for a user authentication system" |

### Thought trace

When **Show Thought Trace** is enabled (default), you can see the agent's internal operations:

- **Runtime events** — Engine initialisation, mode, phase, and template classification.
- **Context cost** — Token usage per turn (system, history, files, tools).
- **Tool calls** — The exact tool invoked (e.g., `read_file`, `write_file`, `edit_file`) with parameters.
- **Tool results** — Outcomes of each tool call (success, blocked, cached).
- **Step contracts** — Whether the turn was classified as discover, mutate, or validate.
- **Session health** — A 0–100 score summarising session efficiency.

<!-- SCREENSHOT: The thought trace expanded, showing tool calls and results -->
> **[Screenshot placeholder]** — An expanded thought trace showing `read_file` and `write_file` tool calls.

### Continuing a session

If the agent pauses (e.g., after writing a file), you can:
- Type **"continue"** or **"proceed"** to resume from the last action.
- Type **"why did you stop"** to get an explanation and potentially resume.

The agent maintains structured execution state across continuations, so it remembers what files were read, written, and what steps remain.

---

## 8. Agent Settings and Provider Configuration

### Opening Agent Settings

Run **Bormagi: Open Agent Settings** from the Command Palette, or click the settings icon in the Chat panel header.

<!-- SCREENSHOT: The Agent Settings webview panel -->
> **[Screenshot placeholder]** — The Agent Settings panel showing provider configuration.

### Workspace default provider

The workspace default provider is used by all agents unless they have a per-agent override. Configure it in Agent Settings:

- **Provider type** — OpenAI, Anthropic, Gemini, Deepseek, Qwen, or OpenAI-Compatible.
- **Model** — The model identifier (e.g., `claude-sonnet-4-6`, `gpt-5.1`).
- **Auth method** — API Key, Subscription Token, OAuth Proxy, or Vertex AI.
- **Base URL** — (OpenAI-Compatible only) The endpoint URL.

### Per-agent provider override

Each agent can optionally use a different provider/model. In Agent Settings:

1. Select the agent.
2. Toggle **Use custom provider** (disables "Use workspace default").
3. Configure the provider, model, and credentials for that agent.

### Supported providers

| Provider | Type ID | Auth Methods | Notes |
|----------|---------|-------------|-------|
| OpenAI | `openai` | API Key | GPT-4o, GPT-5.1, o1, etc. |
| Anthropic | `anthropic` | API Key, Subscription Token | Claude Sonnet, Opus, Haiku |
| Google Gemini | `gemini` | API Key, OAuth Proxy, Vertex AI | Gemini Pro, Flash, etc. |
| Deepseek | `deepseek` | API Key | Deepseek Chat, Coder |
| Qwen | `qwen` | API Key | Qwen Max, Plus, Turbo |
| OpenAI-Compatible | `openai_compatible` | API Key (optional) | Ollama, OpenRouter, LM Studio, vLLM, etc. |

---

## 9. Sandbox Mode

Sandbox mode provides an isolated environment for agent file operations, preventing direct modifications to your workspace until you explicitly approve them.

### Enabling Sandbox

1. Run **Bormagi: Enable Sandbox** from the Command Palette, or
2. Set `bormagi.sandbox.enabled` to `true` in VS Code Settings.

### How Sandbox works

| Setting | Behaviour |
|---------|-----------|
| **Sandbox enabled** | Agent writes go to an isolated sandbox directory. Use **Bormagi: Apply Sandbox Changes** to promote changes to the workspace. |
| **Sandbox disabled** (default) | Agent writes go directly to the workspace. |
| **Require confirmation** | When sandbox is disabled, the agent asks for confirmation before each write/edit. |

<!-- SCREENSHOT: The sandbox status indicator in the chat panel -->
> **[Screenshot placeholder]** — The chat panel showing "Sandbox disabled. Writing directly to workspace." status.

### Applying sandbox changes

When sandbox is enabled:

1. The agent writes files to `.bormagi/sandbox/`.
2. Review the changes in the sandbox.
3. Run **Bormagi: Apply Sandbox Changes** to copy approved files into the workspace.

---

## 10. Virtual Meetings

Bormagi supports structured multi-agent discussions where agents collaborate to analyse a problem or produce a deliverable.

### Starting a meeting

1. Run **Bormagi: Start Virtual Meeting** from the Command Palette.
2. Provide a meeting topic or agenda.
3. Select the agents to participate.

### Meeting flow

- Each agent contributes based on its specialisation and system prompt.
- The meeting proceeds in structured rounds with topic focus.
- Outputs (decisions, action items, artifacts) are captured in the chat and can be exported.

<!-- SCREENSHOT: A virtual meeting with multiple agents participating -->
> **[Screenshot placeholder]** — A virtual meeting session with Solution Architect and Advanced Coder agents discussing a feature design.

---

## 11. Checkpoint and History Management

Bormagi automatically creates Git checkpoints before starting new tasks, giving you a safety net for reverting changes.

### How checkpoints work

1. Before each new task, Bormagi commits the current workspace state as a lightweight checkpoint.
2. Checkpoints appear in the **History** tab in the Bormagi sidebar.
3. You can view the diff and restore any checkpoint.

### Viewing checkpoints

Click the **History** tab in the Bormagi panel to see all checkpoints with timestamps and descriptions.

<!-- SCREENSHOT: The History panel with checkpoint entries and restore options -->
> **[Screenshot placeholder]** — The Checkpoint History panel showing task-start checkpoints.

---

## 12. Execution Engine and Runtime Behaviour

Bormagi's V2 execution engine provides deterministic, reliable agent behaviour with multiple layers of protection against common LLM pitfalls.

### Execution lifecycle

```
User message
  |
  v
[Mode classification] --> [Context assembly] --> [LLM call]
  |                                                  |
  v                                                  v
[Step contract]                              [Tool dispatch]
  |                                                  |
  v                                                  v
[State update] <-- [Guard checks] <-- [Tool result]
  |
  v
[Next iteration or session end]
```

### Step contracts

Before each LLM call, a **step contract** is computed that tells the model what kind of action to take:

| Contract | Allowed Tools | When |
|----------|--------------|------|
| **DISCOVER** | `read_file`, `list_files`, `search_files`, `grep_content` | Agent needs more information |
| **MUTATE** | `write_file`, `edit_file`, `run_command` | Agent has enough information to act |
| **VALIDATE** | `run_command`, `get_diagnostics`, `git_diff` | After writes, verify correctness |

### Discovery budget

To prevent endless reading without action:
- After **2 consecutive reads** with no writes, the engine transitions to **WRITE_ONLY** phase.
- All further read/search calls are blocked until the agent writes a file.

### Loop detection

If the agent calls the **same tool on the same path** twice, the engine forces a phase transition to WRITE_ONLY and blocks further reads.

### File pre-loading (optimisation)

When your message references specific filenames (e.g., "update `clock.html`"), Bormagi automatically:
1. Detects the file reference.
2. Pre-reads the file content into context before the first LLM call.
3. Eliminates the need for `list_files` and `read_file` warm-up iterations.

### Artifact guard

Files written in previous sessions are tracked in an **artifact registry**. When the agent tries to overwrite an existing artifact:

- **1st attempt**: The existing file is auto-loaded into context, and the agent is guided to use `edit_file` or retry with full content.
- **2nd attempt**: The write is allowed through (the agent clearly intends a full rewrite).

This prevents the previous behaviour where repeated rejections caused session failures.

---

## 13. Logging and Diagnostics

### Per-agent log files

Each agent writes a detailed, human-readable log to:

```
.bormagi/logs/<agent-id>.log
```

Log entries include:
- Session start/end markers
- System prompt references (content is redacted for brevity)
- API call message summaries (first 200 chars per message)
- Tool calls (file writes show path + content length, not full content)
- Tool results (file reads show first 5 lines + total, not full content)
- Model text output (first 500 chars + total)
- Token usage per LLM call
- Execution state snapshots per iteration
- Phase transitions with reasons
- Guard activations (loop detection, discovery budget, WRITE_ONLY)
- Recovery triggers and outcomes
- Runtime events (all UI thought-trace events are also captured)
- Turn summaries and session summaries (structured JSON)

### Logging settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bormagi.logging.enabled` | boolean | `true` | Enable/disable per-agent logging |
| `bormagi.logging.clearOnSession` | boolean | `false` | Clear log file at the start of each session |
| `bormagi.logging.maxContentChars` | number | `4000` | Maximum characters before truncation in log entries |

### Reading logs

Open the log file directly in VS Code:

```
.bormagi/logs/advanced-coder.log
```

Look for these key sections:
- `═══ SESSION START` — Beginning of a new agent session.
- `TOOL CALL: write_file` — File creation/modification events.
- `GUARD:` — Read blocking or phase transition events.
- `SESSION HEALTH: NN/100` — Overall session quality score.
- `SESSION_SUMMARY` — Structured JSON with total tokens, files written, etc.

<!-- SCREENSHOT: A sample log file open in the VS Code editor -->
> **[Screenshot placeholder]** — A `.bormagi/logs/advanced-coder.log` file showing session start, tool calls, and session health.

---

## 14. Audit Trail

Bormagi maintains a tamper-evident audit log of all significant events for accountability and compliance.

### Viewing the audit log

Run **Bormagi: Show Audit Log** from the Command Palette to view the audit trail.

### Verifying audit integrity

Run **Bormagi: Verify Audit Log Integrity** to check that no audit entries have been modified or deleted.

### Audited events

- Mode changes (who changed, from what, to what, how)
- Tool executions (tool name, path, success/failure)
- Agent switches
- Provider changes
- Session starts and ends
- Compaction events
- Error events

---

## 15. Knowledge Base

Agents can have access to a local knowledge base — a set of files or documents that inform their responses beyond the current workspace context.

### Configuring a knowledge base

In the agent's `agent.json`, specify source folders:

```json
{
  "knowledge": {
    "source_folders": ["docs", "specs", "requirements"]
  }
}
```

The agent will index and query these folders, surfacing relevant chunks in the system prompt when answering your questions.

### How it works

1. On first use, Bormagi builds a local index of the specified folders.
2. On each user message, the knowledge base is queried for relevant chunks.
3. Relevant chunks are injected into the agent's context alongside the system prompt.
4. The agent cites knowledge sources in its responses when applicable.

---

## 16. Project State and Configuration Reference

### `.bormagi/` folder structure

```
.bormagi/
  config.json                    # Project configuration (name, default provider)
  agents/
    <agent-id>/
      agent.json                 # Agent metadata and provider overrides
      system-prompt.md           # Agent system prompt
  logs/
    <agent-id>.log               # Per-agent execution log
  state/
    <agent-id>.json              # Execution state (iterations, resolved inputs, etc.)
  audit/
    audit.jsonl                  # Append-only audit trail
  artifact-registry.json         # Cross-session file tracking
  sandbox/                       # (When sandbox enabled) Isolated write target
  plans/                         # Plan artifacts from Plan mode
```

### `config.json` structure

```json
{
  "project": {
    "name": "my-project",
    "created_at": "2026-03-17T10:00:00.000Z"
  },
  "agents": [],
  "defaultProvider": {
    "type": "anthropic",
    "model": "claude-sonnet-4-6",
    "base_url": null,
    "proxy_url": null,
    "auth_method": "api_key"
  },
  "userRole": "Developer"
}
```

### Security

- **API keys and tokens** are stored in **VS Code SecretStorage**, not in `.bormagi/` or any workspace file.
- `.bormagi/` is automatically added to `.gitignore` during setup.
- Audit logs use hash chaining for tamper detection.

---

## 17. VS Code Settings Reference

All settings are prefixed with `bormagi.`. Open VS Code Settings (`Ctrl+,` / `Cmd+,`) and search for "bormagi".

### Provider defaults

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bormagi.defaultProvider.type` | string | `anthropic` | Default LLM provider type |
| `bormagi.defaultProvider.model` | string | `claude-sonnet-4-6` | Default model name |
| `bormagi.defaultProvider.authMethod` | string | `api_key` | Default authentication method |
| `bormagi.defaultModel.openai` | string | `gpt-5.1` | Default OpenAI model |
| `bormagi.defaultModel.anthropic` | string | `claude-sonnet-4-6` | Default Anthropic model |
| `bormagi.defaultModel.gemini` | string | `gemini-2.5-pro` | Default Gemini model |
| `bormagi.defaultModel.deepseek` | string | `deepseek-chat` | Default Deepseek model |
| `bormagi.defaultModel.qwen` | string | `qwen-max` | Default Qwen model |

### Context and retrieval

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bormagi.contextMaxFiles` | number | `50` | Maximum workspace files in agent context |
| `bormagi.contextMaxFileSizeKb` | number | `100` | Maximum single file size (KB) for context inclusion |
| `bormagi.contextCacheTtlSeconds` | number | `120` | Context cache TTL before rescanning |
| `bormagi.contextRepoSummaryChars` | number | `2400` | Maximum chars for repository summary |
| `bormagi.contextRetrievalTopFiles` | number | `6` | Maximum task-relevant files per request |
| `bormagi.contextRetrievalSnippetChars` | number | `900` | Maximum chars per retrieved snippet |

### Execution

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bormagi.maxOutputTokens` | number | `1200` | Maximum output tokens per LLM call |
| `bormagi.executionEngineV2` | boolean | `true` | Enable V2 engine with state management and guards |
| `bormagi.validatorEnforcement` | boolean | `false` | Auto-fix safe issues (requires V2 engine) |
| `bormagi.showThoughtTrace` | boolean | `true` | Show tool calls and reasoning in chat |

### Sandbox

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bormagi.sandbox.enabled` | boolean | `false` | Use isolated sandbox for writes |
| `bormagi.sandbox.requireConfirmation` | boolean | `false` | Require confirmation before writes (when sandbox disabled) |

### Enhanced context pipeline

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bormagi.contextPipeline.enabled` | boolean | `false` | Enable the enhanced context pipeline |
| `bormagi.contextPipeline.hooks.configPath` | string | `""` | Path to hooks configuration JSON |
| `bormagi.contextPipeline.capabilities.dir` | string | `""` | Capability manifests directory |
| `bormagi.contextPipeline.plans.storageLocation` | string | `workspace-root` | Where to write plan artifacts |
| `bormagi.contextPipeline.plans.writePlanMd` | boolean | `true` | Write human-readable plan markdown |

### Developer

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bormagi.developerMode` | boolean | `false` | Enable developer-mode debug commands |

---

## 18. Command Reference

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type "Bormagi" to see all available commands.

| Command | Description |
|---------|-------------|
| **Bormagi: Open Chat** | Open the Chat panel |
| **Bormagi: Open Agent Settings** | Open the settings webview for provider and agent configuration |
| **Bormagi: Open Dashboard** | Open the main dashboard |
| **Bormagi: Initialise Workspace** | Run the setup wizard manually |
| **Bormagi: Select Active Agent** | Switch the currently active agent |
| **Bormagi: Create New Agent** | Create a new custom agent |
| **Bormagi: Install Predefined Agents** | Install all 11 predefined agents |
| **Bormagi: Switch Mode (Ask / Plan / Code)** | Change the execution mode |
| **Bormagi: Start Virtual Meeting** | Begin a multi-agent meeting |
| **Bormagi: Enable Sandbox** | Enable sandbox isolation |
| **Bormagi: Disable Sandbox** | Disable sandbox, write directly to workspace |
| **Bormagi: Apply Sandbox Changes** | Promote sandbox changes to the workspace |
| **Bormagi: Show Audit Log** | View the audit trail |
| **Bormagi: Verify Audit Log Integrity** | Check audit log for tampering |
| **Bormagi: Show Execution State** | (Developer) View current execution state JSON |
| **Bormagi: Reset Execution State** | (Developer) Reset the agent's execution state |

---

## 19. Predefined Agents

Bormagi ships with 11 predefined agents, each with a specialised system prompt and area of expertise.

| Agent ID | Specialisation | Best For |
|----------|---------------|----------|
| **advanced-coder** | Full-stack implementation | Writing code, fixing bugs, implementing features |
| **solution-architect** | System design | Architecture decisions, design patterns, tech stack |
| **software-qa** | Quality assurance | Test writing, test plans, quality review |
| **ai-engineer** | AI/ML engineering | ML pipelines, model integration, data processing |
| **business-analyst** | Requirements analysis | User stories, acceptance criteria, process flows |
| **cloud-architect** | Cloud infrastructure | AWS/Azure/GCP architecture, IaC, scaling |
| **data-architect** | Data systems | Database design, ETL, data modelling |
| **devops-engineer** | CI/CD and operations | Pipelines, Docker, Kubernetes, monitoring |
| **frontend-designer** | UI/UX development | React, CSS, responsive design, accessibility |
| **security-engineer** | Security analysis | Vulnerability assessment, auth, encryption |
| **technical-writer** | Documentation | API docs, user guides, READMEs |

### Customising a predefined agent

You can modify any predefined agent by editing its files in `.bormagi/agents/<agent-id>/`:

- Edit `system-prompt.md` to change the agent's instructions or persona.
- Edit `agent.json` to change provider, model, or knowledge base configuration.

---

## 20. Predefined Skills

Skills are reusable knowledge modules that can be attached to agents to enhance their capabilities.

| Skill | Description |
|-------|-------------|
| **agentic-workflow** | Multi-step task planning and execution |
| **api-design-conventions** | REST/GraphQL API design patterns |
| **clean-code-naming** | Naming conventions and code style |
| **codebase-conventions** | Project-specific coding standards |
| **context-compression** | Efficient context management |
| **document-knowledge** | Documentation generation patterns |
| **git-workflow** | Git branching, commits, and PR workflows |
| **security-hygiene** | Security best practices and OWASP guidelines |
| **spec-driven-requirements** | Specification-first development |

---

## 21. Advanced Usage

### Using multiple agents in a session

You can switch between agents during a conversation:

1. Use `@agent-id` in the chat input to mention and switch to a different agent.
2. Or run **Bormagi: Select Active Agent** from the Command Palette.

Each agent maintains its own execution state, so switching back to an agent resumes where it left off.

### Using local models (Ollama, LM Studio)

1. During setup (or in Agent Settings), select **OpenAI-Compatible** as the provider.
2. Enter your local endpoint URL:
   - **Ollama**: `http://localhost:11434/v1`
   - **LM Studio**: `http://localhost:1234/v1`
3. Leave the API key blank if not required.
4. Enter the model name (e.g., `llama3.1`, `codellama`).

### Execution state management (Developer)

Enable `bormagi.developerMode` in VS Code Settings to access:

- **Show Execution State** — View the raw JSON state (iterations, resolved inputs, artifacts, phase, etc.).
- **Reset Execution State** — Clear the state when an agent is stuck or behaving unexpectedly.

### Plan-to-Code workflow

1. Start in **Plan mode** and describe the feature or change.
2. The agent produces a structured plan artifact (`PLAN-<timestamp>.md`).
3. Review and approve the plan.
4. Switch to **Code mode** — the agent automatically detects the approved plan and implements it file by file.

---

## 22. Troubleshooting

### Setup wizard did not appear

- **Cause**: The workspace already has a `.bormagi/` folder.
- **Fix**: Run **Bormagi: Initialise Workspace** manually from the Command Palette.

### Agent is not writing files

| Check | Action |
|-------|--------|
| Mode is not Code | Switch to **Code** mode via Command Palette |
| Provider not configured | Open **Agent Settings** and verify API key |
| Sandbox is enabled | Run **Bormagi: Apply Sandbox Changes** or disable sandbox |
| Agent is stuck in DISCOVER phase | Type "continue" or check `.bormagi/logs/<agent>.log` for guard activations |

### Agent keeps reading files without writing

- **Cause**: Discovery budget may not be triggering, or step contract is stuck on DISCOVER.
- **Fix**: Type a more specific instruction: "Write the file now, do not read anything else." Or reset execution state via **Bormagi: Reset Execution State** (requires developer mode).

### Provider authentication errors

| Error | Fix |
|-------|-----|
| 401 Unauthorized | Re-enter API key in Agent Settings |
| 403 Forbidden | Check if key has the required permissions/quota |
| Rate limited (429) | Wait and retry, or switch to a different model |
| Connection refused | Verify base URL (for local models) |

### Agent session halted with "token efficiency below 2%"

- **Cause**: The agent spent 3+ turns making no progress (e.g., repeated rejected writes).
- **Fix**: This is now mitigated by the smart artifact guard (auto-loads files on rejection). If it persists, reset execution state and retry with a more specific prompt.

### Stale behaviour after extension update

1. Reload the VS Code window (`Ctrl+Shift+P` > **Developer: Reload Window**).
2. If using a packaged `.vsix`, uninstall and reinstall the new version.

### Log file is too large

- Set `bormagi.logging.clearOnSession` to `true` to auto-clear logs at each session start.
- Or delete `.bormagi/logs/<agent-id>.log` manually.

---

## 23. FAQ

**Q: Where are my API keys stored?**
A: In VS Code's SecretStorage (OS keychain). Never in plain text on disk.

**Q: Is `.bormagi/` committed to Git?**
A: No. Bormagi adds `.bormagi/` to `.gitignore` during setup. If you need team-shared configuration, extract the relevant settings to VS Code workspace settings.

**Q: Can I use different models for different agents?**
A: Yes. Each agent can have a per-agent provider override in Agent Settings.

**Q: What happens if I lose my internet connection mid-session?**
A: The agent's execution state is saved after each tool call. When you reconnect, type "continue" to resume from the last successful action.

**Q: Can multiple team members use Bormagi on the same repo?**
A: Yes. Each developer's `.bormagi/` folder is local and gitignored. Use VS Code workspace settings (`bormagi.*`) for shared configuration.

**Q: How do I change the active agent mid-conversation?**
A: Type `@agent-id` in the chat, or run **Bormagi: Select Active Agent**.

**Q: What models work best with Bormagi?**
A: Bormagi works with any model, but for Code mode, we recommend models with strong tool-use capabilities: Claude Sonnet/Opus, GPT-4o/GPT-5, or Gemini Pro.

**Q: Can I use Bormagi offline with a local model?**
A: Yes. Use the OpenAI-Compatible provider with Ollama or LM Studio running locally.

**Q: How do I update a predefined agent's system prompt?**
A: Edit `.bormagi/agents/<agent-id>/system-prompt.md` directly. Changes take effect on the next message.

---

## 24. Support and Feedback

- **GitHub Issues**: [github.com/M-O-Othman/Bormagi-coding-assistant/issues](https://github.com/M-O-Othman/Bormagi-coding-assistant/issues)
- **Source Code**: [github.com/M-O-Othman/Bormagi-coding-assistant](https://github.com/M-O-Othman/Bormagi-coding-assistant)

---

*This guide was last updated for Bormagi v0.1.0.*
