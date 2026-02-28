# Bormagi

**Bormagi** is a VS Code extension that lets you create and manage named AI coding agents, each powered by your choice of LLM provider. Agents use the Model Context Protocol (MCP) to read and write files, run terminal commands, interact with Git, and deploy to Google Cloud Platform — all within your workspace.

A unified **Dashboard** panel gives you a single place to chat with agents, manage multi-agent workflows, approve handoffs, resolve blockers, and configure the extension — without leaving VS Code.

No admin permissions are required. Install from the VS Code Marketplace or from a `.vsix` file.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Dashboard Overview](#dashboard-overview)
   - [Work Tab](#work-tab)
   - [Chat Tab](#chat-tab)
   - [Review Tab](#review-tab)
   - [Workflows Tab](#workflows-tab)
   - [Setup Tab](#setup-tab)
3. [Workflow Orchestration](#workflow-orchestration)
4. [Installing Predefined Agents](#installing-predefined-agents)
5. [Creating a Custom Agent](#creating-a-custom-agent)
6. [Connecting Agents to LLM Providers](#connecting-agents-to-llm-providers)
   - [OpenAI](#openai)
   - [Anthropic (Claude)](#anthropic-claude)
   - [Google Gemini — API Key](#google-gemini--api-key)
   - [Google Gemini — GCP SSO (Corporate Identity)](#google-gemini--gcp-sso-corporate-identity)
   - [Deepseek](#deepseek)
   - [Qwen (Alibaba Cloud)](#qwen-alibaba-cloud)
7. [Using a Proxy for LLM Calls](#using-a-proxy-for-llm-calls)
8. [Chatting with an Agent](#chatting-with-an-agent)
9. [Skills](#skills)
10. [File and Folder Structure](#file-and-folder-structure)
11. [Agent Configuration Reference](#agent-configuration-reference)
12. [MCP Tools Reference](#mcp-tools-reference)
13. [Security](#security)

---

## Quick Start

1. Open a workspace folder in VS Code.
2. Open the Command Palette (`Ctrl+Shift+P`) and run **`Bormagi: Initialise Workspace`**.
3. Run **`Bormagi: Install Predefined Agents`** to add the built-in agent set.
4. Run **`Bormagi: Open Dashboard`** (or click the robot icon in the Activity Bar sidebar).
5. Go to the **Setup** tab → **Workspace** → **Agent Settings Panel** to add your API keys.
6. Switch to the **Chat** tab, select an agent, and start typing.

---

## Dashboard Overview

Open the dashboard with **`Ctrl+Shift+P` → `Bormagi: Open Dashboard`**, or via the sidebar icon.

The dashboard is a full-width VS Code panel with five tabs and a status bar footer. It uses your active VS Code colour theme automatically.

```
┌─────────────────────────────────────────────────────────────────────┐
│  [B] Bormagi  │ Work │ Chat │ Review [2] │ Workflows │ Setup │ ws/ │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                        (active tab content)                         │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  No active workflow  •  advanced-coder  •  ↑ 1.2k  ↓ 3.4k  •  ● Ready │
└─────────────────────────────────────────────────────────────────────┘
```

The footer status bar shows the active workflow name, active agent, cumulative token counts, and extension readiness at a glance. The **Review** tab badge shows the count of pending items needing your attention.

---

### Work Tab

The Work tab is the landing view. It shows the most recently active workflow, its stage progress, the current running task, and any items that need your attention (blockers, pending reviews, pending handoffs).

```
┌─────────────────────────────────────────────────────────────────────┐
│  Work                                          [Open Chat] [↺ Refresh] │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─── Active Workflow ─────────────────────────────────────────────┐│
│  │  Add dark mode support                         status: active   ││
│  │  ● requirements  ● architecture  ◉ implementation  ○ qa  ○ done ││
│  │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  60%        ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  ┌── Current Task ─────────────────────────────────────────────────┐│
│  │  Implement colour token system             advanced-coder        ││
│  │  Status: active                                                  ││
│  │                       [Open Chat]  [Review Items]               ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  ┌── Attention ────────────────────────────────────────────────────┐│
│  │  ⚠ Blocker: Unclear design spec for high-contrast mode  [View]  ││
│  │  🔗 Handoff: Delegate QA validation to software-qa      [View]  ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  ┌─ KPIs ──────────┐ ┌─ KPIs ──────────┐ ┌─ KPIs ──────────────┐  │
│  │  Total Workflows │ │  Active          │ │  Pending Reviews     │  │
│  │       3          │ │      1           │ │        2             │  │
│  └──────────────────┘ └──────────────────┘ └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

When no workflow is running, the Work tab shows an empty state with a prompt to create one.

---

### Chat Tab

The Chat tab provides a full streaming chat experience with the selected agent.

```
┌─────────────────────────────────────────────────────────────────────┐
│  [advanced-coder ▾]  [anthropic · claude-sonnet-4-6]  [Clear] [Export] │
│                                              ↑ 4,210  ↓ 1,830  $0.04 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  You                                                         14:22  │
│  Refactor the colour system to use CSS custom properties.           │
│                                                                     │
│  advanced-coder                                              14:22  │
│  I'll refactor the colour system now. Let me start by reading       │
│  the current implementation…                                        │
│                                                                     │
│  ▶ Tool calls  (2 calls — click to expand)                          │
│    read_file  src/styles/colours.css                                │
│    write_file src/styles/colours.css  [approved]                    │
│                                                                     │
│  Done. All 14 colour values are now CSS custom properties           │
│  under :root { --color-* }. No functional changes.                  │
│                                                                     │
│  ···                                                                │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐ [Send]    │
│  │ Message… (↑/↓ history · Enter to send · Shift+Enter │           │
│  │ for newline)                                         │           │
│  └─────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

| Feature | Detail |
|---|---|
| Agent selector | Dropdown listing all enabled agents; switches instantly |
| Provider pill | Shows current provider and model; click to switch model mid-session |
| Token stats | Running totals of prompt/completion tokens and estimated cost |
| Thought trace | Collapsible section under each response showing every tool call and result |
| Input history | `↑` / `↓` keys cycle through previously sent messages |
| Clear / Export | Clear the visible history, or export the chat as plain text |

**File writes** always open a VS Code diff editor for your approval. **Shell commands** show an explicit confirmation prompt before executing.

---

### Review Tab

The Review tab aggregates everything waiting for your attention across all active workflows. Items appear automatically; a badge on the tab header shows the count.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Review                                                  [↺ Refresh] │
├─────────────────────────────────────────────────────────────────────┤
│  [All]  [Handoffs]  [QA Reviews]  [Blockers]                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌── HANDOFF ─────────────────────────────────────────────────────┐ │
│  │  "Add dark mode support"  →  Delegate architecture design       │ │
│  │  From: advanced-coder   To: solution-architect                  │ │
│  │  Agent delegation request                          task #t-002  │ │
│  │                                          [Approve]  [Reject]    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌── QA REVIEW ───────────────────────────────────────────────────┐ │
│  │  "Add dark mode support"  →  QA Review                         │ │
│  │  Colour token refactor ready for validation      task #t-005   │ │
│  │  Requested by: advanced-coder                                   │ │
│  │              [Approved]  [Approved with comments]  [Rejected]   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌── BLOCKER  high ───────────────────────────────────────────────┐ │
│  │  "Add dark mode support"                         task #t-003   │ │
│  │  Unclear design spec for high-contrast mode                    │ │
│  │                                                  [Resolve]     │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

| Item type | Available actions |
|---|---|
| Handoff | **Approve** (agent proceeds) or **Reject** (prompt for reason) |
| QA Review | **Approved**, **Approved with comments**, or **Rejected** |
| Blocker | **Resolve** (enter resolution note) |

All actions are logged to the workflow audit trail with a timestamp and the acting identity.

---

### Workflows Tab

The Workflows tab has two sub-views: **Board** (kanban) and **New Workflow** (creation form).

#### Board view

```
┌─────────────────────────────────────────────────────────────────────┐
│  Workflows                                               [↺ Refresh] │
│  [Board]  [+ New Workflow]                                          │
├──────────┬────────────┬───────────────┬────────────┬───────────────┤
│ Backlog  │   Active   │ Waiting Review│  Blocked   │     Done      │
├──────────┼────────────┼───────────────┼────────────┼───────────────┤
│          │ ┌────────┐ │ ┌───────────┐ │            │ ┌───────────┐ │
│          │ │Impl.   │ │ │Arch. rev. │ │            │ │Req. phase │ │
│          │ │task    │ │ │           │ │            │ │           │ │
│          │ │adv-cdr │ │ │sol-arch   │ │            │ │           │ │
│          │ └────────┘ │ └───────────┘ │            │ └───────────┘ │
│          │            │               │            │               │
└──────────┴────────────┴───────────────┴────────────┴───────────────┘
```

Click any task card to open the **task detail overlay**, which shows the objective, owner agent, handoff context, child tasks, blockers, reviews, and a full audit timeline. From the overlay you can cancel the task.

#### New Workflow form

```
┌─────────────────────────────────────────────────────────┐
│  Create Workflow                                         │
│                                                         │
│  Template  ┌──────────────────────────────────────────┐ │
│            │ New Feature Delivery               ▾      │ │
│            └──────────────────────────────────────────┘ │
│  Title     ┌──────────────────────────────────────────┐ │
│            │ Add dark mode support                     │ │
│            └──────────────────────────────────────────┘ │
│  Owner     ┌──────────────────────────────────────────┐ │
│            │ alice                                     │ │
│            └──────────────────────────────────────────┘ │
│  Linked    ┌──────────────────────────────────────────┐ │
│  Issue     │ #123                                      │ │
│            └──────────────────────────────────────────┘ │
│                                                         │
│  [Create Workflow]                                      │
└─────────────────────────────────────────────────────────┘
```

Available templates:

| Template | Stages |
|---|---|
| **New Feature Delivery** | requirements → architecture → data-design → implementation → qa-validation → release-readiness → done |
| **Bug Fix** | triage → implementation → qa-validation → release-readiness → done |
| **Architecture Spike** | problem-framing → option-analysis → decision → done |

---

### Setup Tab

The Setup tab has three sub-views: **Agents**, **Workspace**, and **Tools & Log**.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Setup                                                              │
│  [Agents]  [Workspace]  [Tools & Log]                               │
├─────────────────────────────────────────────────────────────────────┤
│  Agents                               [+ New Agent] [Install Predefined] │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  advanced-coder          anthropic · claude-sonnet-4-6  [Edit] ││
│  │  Production-ready code, refactoring, code review                ││
│  └─────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  solution-architect      openai · gpt-4o                [Edit] ││
│  │  Architecture decisions, C4 diagrams, system design             ││
│  └─────────────────────────────────────────────────────────────────┘│
│  ...                                                                │
│                                                                     │
│  Full configuration (providers, system prompts, MCP servers)        │
│  is available in the Agent Settings panel.                          │
└─────────────────────────────────────────────────────────────────────┘
```

**Workspace sub-tab** provides one-click access to: initialise the `.bormagi` folder, install predefined agents, and open the full Agent Settings panel.

**Tools & Log sub-tab** shows the list of all built-in MCP tools and a button to open the audit log file.

---

## Workflow Orchestration

Bormagi includes a multi-agent workflow orchestration engine. Workflows let you coordinate several AI agents through a structured pipeline — with human approval gates, handoff tracking, blocker management, and a full audit trail.

### Core concepts

| Concept | Description |
|---|---|
| **Workflow** | A named project with a template (e.g. Feature Delivery), owned stages, and a human owner |
| **Stage** | A phase of the workflow (e.g. requirements, implementation). Each has required inputs and outputs |
| **Task** | A unit of work assigned to an agent within a stage. One task is active at a time |
| **Handoff** | A structured request for one agent to delegate work to another agent |
| **Review** | A lightweight peer check — the reviewer gives `approved`, `approved_with_comments`, or `rejected` without taking ownership |
| **Blocker** | An impediment raised by an agent or human, with severity and resolution notes |
| **Artifact** | A file or document produced during a stage, with an approval lifecycle (draft → submitted → approved) |
| **Decision** | An architecture or business decision logged with rationale, alternatives, and impact |

### Workflow commands

Available via the Command Palette (`Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `Bormagi: Open Dashboard` | Open the unified dashboard panel |
| `Bormagi: Initialise Workspace` | Create the `.bormagi/` folder structure |
| `Bormagi: Install Predefined Agents` | Install agents from the built-in library |
| `Bormagi: Open Agent Settings` | Open the agent configuration panel |

Workflow actions are also available via chat commands once a workflow is active:

| Chat command | Description |
|---|---|
| `/wf-list` | List all workflows and their status |
| `/wf-status` | Show a summary of the active workflow |
| `/wf-resume <task-id>` | Resume a paused task |
| `/wf-cancel <task-id>` | Cancel a task (prompts for reason) |
| `/wf-reassign <task-id> <agent-id>` | Reassign a task to a different agent |

### Human approval checkpoints

Workflows can require explicit human approval before key transitions. The **Review** tab shows all pending approvals. Approvals are logged with the approver identity and timestamp. A human can also force a stage transition via an override (override reason is mandatory and visible in the audit trail).

### Persistence and crash recovery

Workflow state is persisted to disk under `.bormagi/workflows/<workflow-id>/`. If VS Code restarts mid-workflow, the engine recovers all active tasks, pending reviews, unresolved blockers, and execution locks on next activation. Tasks that were active at the time of restart are marked `requires_attention` so you can review and resume them.

---

## Installing Predefined Agents

Bormagi ships with seven ready-to-use agents. Run **`Bormagi: Install Predefined Agents`** and select which ones to install. Each agent is installed into `.bormagi/agents-definition/<agent-id>/`.

| Agent ID | Role |
|---|---|
| `solution-architect` | Overall solution design, architecture decisions, C4 diagrams |
| `data-architect` | Data modelling, ER diagrams, data flows, database design |
| `business-analyst` | Requirements, user stories, BRDs, functional specifications |
| `cloud-architect` | GCP/AWS/Azure architecture, Terraform, deployment strategies |
| `software-qa` | Test plans, test cases, BDD scenarios, bug reports |
| `frontend-designer` | HTML/CSS/JS, React, responsive design, professional UI/UX |
| `advanced-coder` | Production-ready code, refactoring, code review, debugging |

After installation, add API keys via **Setup → Workspace → Agent Settings Panel**.

---

## Creating a Custom Agent

1. In the Dashboard, go to **Setup → Agents → + New Agent**, or run **`Bormagi: Open Agent Settings`**.
2. Fill in the Agent ID (used for `@mention`), Display Name, Category, and Description.
3. Select your LLM Provider and Model.
4. Enter your API Key (stored in VS Code's encrypted secret storage — never written to disk).
5. Click **Save Agent**.

The agent folder is created at `.bormagi/agents-definition/<agent-id>/` with a default `system-prompt.md`. Edit this file to customise the agent's behaviour.

---

## Connecting Agents to LLM Providers

### OpenAI

1. Obtain an API key from [platform.openai.com](https://platform.openai.com).
2. In Agent Settings, set Provider to `openai` and select a model (`gpt-4o` recommended).
3. Paste your API key in the API Key field.

### Anthropic (Claude)

1. Obtain an API key from [console.anthropic.com](https://console.anthropic.com).
2. Set Provider to `anthropic` and select a model (`claude-sonnet-4-6` recommended).
3. Paste your API key.

### Google Gemini — API Key

1. Obtain an API key from [aistudio.google.com](https://aistudio.google.com).
2. Set Provider to `gemini`, Auth Method to `API Key`, and select a model.
3. Paste your API key.

### Google Gemini — GCP SSO (Corporate Identity)

This method allows you to authenticate using your corporate Google Workspace identity — no separate API key required.

**Prerequisites:**

```bash
# Install the Google Cloud CLI
# https://cloud.google.com/sdk/docs/install

# Sign in with your corporate SSO account
gcloud auth application-default login

# Set your GCP project
gcloud config set project YOUR_PROJECT_ID
```

This creates a local credential file (`~/.config/gcloud/application_default_credentials.json`). Bormagi reads this automatically.

**In Agent Settings:**

- Provider: `gemini`
- Auth Method: `GCP Application Default Credentials (SSO)`
- API Key: leave blank

### Deepseek

1. Obtain an API key from [platform.deepseek.com](https://platform.deepseek.com).
2. Set Provider to `deepseek`, select model (`deepseek-chat` or `deepseek-coder`).
3. Paste your API key. The base URL (`https://api.deepseek.com/v1`) is set automatically.

### Qwen (Alibaba Cloud)

1. Obtain an API key from Alibaba Cloud DashScope.
2. Set Provider to `qwen`, select model (`qwen-max` recommended).
3. Paste your API key. The base URL is set automatically.

---

## Using a Proxy for LLM Calls

If your organisation requires all outbound API traffic to pass through a GCP-hosted proxy (e.g. for logging, rate limiting, or policy enforcement), configure the **Proxy URL** field in Agent Settings. Below are four GCP proxy patterns.

### Option 1: Cloud Run Proxy

A lightweight reverse proxy container deployed on Cloud Run that forwards requests to the LLM provider.

**Architecture:** `VS Code → Cloud Run proxy (HTTPS) → LLM provider API`

```bash
# Deploy a simple Cloud Run proxy (example using a Node.js reverse proxy image)
gcloud run deploy llm-proxy \
  --image gcr.io/YOUR_PROJECT/llm-proxy:latest \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars TARGET_URL=https://api.openai.com
```

In Agent Settings, set **Proxy URL** to your Cloud Run service URL (e.g. `https://llm-proxy-xxxx-ew.a.run.app`).

**Pros:** Simple, serverless, scales to zero. **Cons:** No built-in auth enforcement.

---

### Option 2: Apigee API Gateway

Apigee provides enterprise-grade API management with policies for rate limiting, auth, logging, and quota enforcement.

**Architecture:** `VS Code → Apigee proxy endpoint → LLM provider API`

1. Create an Apigee proxy that targets the LLM provider endpoint.
2. Apply API key validation or OAuth policies.
3. Distribute the Apigee endpoint URL to developers.

In Agent Settings, set **Base URL** to your Apigee proxy URL (e.g. `https://YOUR_ORG-eval.apigee.net/openai-proxy/v1`).

**Pros:** Full enterprise policy control, analytics, developer portal. **Cons:** Requires Apigee subscription.

---

### Option 3: GCP Cloud Endpoints

Cloud Endpoints wraps your backend with a managed API layer using an OpenAPI spec or gRPC service config.

**Architecture:** `VS Code → Cloud Endpoints (ESP) → Cloud Run backend → LLM provider`

```yaml
# openapi.yaml (fragment)
swagger: "2.0"
host: "your-service.endpoints.YOUR_PROJECT.cloud.goog"
paths:
  /v1/chat/completions:
    post:
      operationId: chatCompletion
      security:
        - api_key: []
```

**Pros:** IAM integration, pay-per-use, works with existing GCP infrastructure. **Cons:** More configuration overhead.

---

### Option 4: GCP API Gateway (REST)

GCP API Gateway is a fully managed gateway that can front any HTTP backend with minimal configuration.

```bash
# Create the API gateway
gcloud api-gateway apis create llm-api --project=YOUR_PROJECT

gcloud api-gateway api-configs create llm-config \
  --api=llm-api \
  --openapi-spec=openapi.yaml \
  --project=YOUR_PROJECT

gcloud api-gateway gateways create llm-gateway \
  --api=llm-api \
  --api-config=llm-config \
  --location=europe-west1 \
  --project=YOUR_PROJECT
```

In Agent Settings, set **Base URL** to the gateway URL.

**Pros:** Lightweight, managed, integrates with Cloud IAM. **Cons:** Limited transformation capabilities compared to Apigee.

---

## Chatting with an Agent

Open the Bormagi sidebar (robot icon) for the lightweight sidebar chat, or use the **Chat tab** in the Dashboard for the full experience.

In the input box:

| Syntax | Effect |
|---|---|
| `@advanced-coder refactor this function` | Switch to the `advanced-coder` agent and send the message |
| `@solution-architect design a microservice for X` | Activate the solution architect |
| `/undo` | Undo the last file change made by the active agent |

All subsequent messages go to the last `@mentioned` agent until you mention another. The footer status bar shows the active agent.

**File changes** are always presented as a diff for your approval before being applied.

**Terminal commands** require explicit confirmation before execution.

**Thought trace** (tool calls, tool results, and approval events) is visible under each response — click to expand. This shows every action the agent took, not internal model reasoning text.

---

## Skills

Skills are shared `.md` files available to all agents in the workspace. Place them in `.bormagi/skills/`.

**Example skill file** `.bormagi/skills/code-review-checklist.md`:

```markdown
# Skill: Code Review Checklist

When reviewing code, always check:
1. Error handling is present in all functions.
2. No hardcoded secrets or credentials.
3. SQL queries use parameterised inputs.
4. Functions have clear, single responsibilities.
5. Tests cover happy path and edge cases.
```

Skills are automatically injected into every agent's context.

---

## File and Folder Structure

```
.bormagi/                              ← All Bormagi data (auto-added to .gitignore)
├── project.json                       ← Project name and agent index
├── audit.log                          ← Append-only log of all agent actions
├── skills/
│   └── my-skill.md                    ← Shared skills (all agents)
├── agents-definition/
│   └── <agent-id>/
│       ├── config.json                ← Agent config (provider, model, tools)
│       ├── system-prompt.md           ← Main system prompt
│       ├── [extra-prompt.md]          ← Optional additional prompt files
│       └── Memory.md                  ← Append-only conversation history
└── workflows/
    └── <workflow-id>/
        ├── workflow.json              ← Workflow state
        ├── tasks-snapshot.json        ← Task states
        ├── handoffs-snapshot.json     ← Handoff approvals
        ├── reviews.json               ← QA review outcomes
        ├── blockers.json              ← Active blockers
        ├── artifacts.json             ← Artifact registry
        ├── decisions.jsonl            ← Append-only decision log
        ├── events.jsonl               ← Append-only workflow event log
        └── execution.lock             ← Active task lock (prevents concurrent execution)
```

> `.bormagi/` is automatically added to `.gitignore` on workspace initialisation. Configuration files — including API keys — are never committed to source control. API keys are stored in VS Code's encrypted `SecretStorage`.

---

## Agent Configuration Reference

`config.json` fields:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique agent ID used for `@mention` |
| `name` | string | Display name shown in the UI |
| `category` | string | Agent category (one of the seven predefined types or "Custom Agent") |
| `description` | string | Short description of the agent's role |
| `enabled` | boolean | Whether the agent is active |
| `provider.type` | string | `openai`, `anthropic`, `gemini`, `deepseek`, `qwen` |
| `provider.model` | string | Model identifier (e.g. `gpt-4o`, `claude-sonnet-4-6`) |
| `provider.base_url` | string \| null | Override the default API endpoint |
| `provider.proxy_url` | string \| null | Route all calls through this proxy |
| `provider.auth_method` | string | `api_key` or `gcp_adc` (Gemini SSO) |
| `system_prompt_files` | string[] | List of `.md` files to compose the system prompt |
| `mcp_servers` | array | Custom MCP server configurations (optional) |
| `context_filter.include_extensions` | string[] | File extensions to include in workspace context |
| `context_filter.exclude_patterns` | string[] | Directory/file patterns to exclude |

---

## MCP Tools Reference

Built-in tools available to all agents:

| Tool | Description | Requires Approval |
|---|---|---|
| `read_file` | Read a workspace file | No |
| `write_file` | Write/modify a file (shows diff) | Yes — diff review |
| `list_files` | List directory contents | No |
| `search_files` | Search for text patterns across files | No |
| `run_command` | Execute a shell command | Yes — explicit prompt |
| `git_status` | Show git status | No |
| `git_diff` | Show staged/unstaged diff | No |
| `git_commit` | Stage and commit changes | Yes — explicit prompt |
| `git_log` | Show recent commit history | No |
| `git_create_branch` | Create and switch to a new branch | Yes — explicit prompt |
| `git_push` | Push to remote | Yes — explicit prompt |
| `git_create_pr` | Open a pull request | Yes — explicit prompt |
| `gcp_auth_status` | Check gcloud authentication | No |
| `gcp_deploy` | Run a gcloud deployment command | Yes — explicit prompt |
| `get_diagnostics` | Read VS Code Problems panel diagnostics | No |

Custom MCP servers can be added per-agent in `config.json` under `mcp_servers`.

---

## Security

- **API keys** are stored in VS Code's `SecretStorage` (OS-level encrypted storage). They are never written to any file on disk.
- **File writes** are restricted to the workspace root. Agents cannot write outside the project folder. Path traversal attempts are blocked via `path.relative()` boundary checks.
- **Terminal commands** and **git commits** require your explicit approval before execution. The working directory is validated against the workspace root before any command runs.
- **Shell injection** is prevented: `git`, `gcloud`, and other CLI tools are invoked via `execFileSync` with argument arrays, not shell string concatenation.
- **Audit log** at `.bormagi/audit.log` records every tool call, file write, and command executed by agents in structured JSON Lines (JSONL) format. File contents in `write_file` calls are redacted to a character count. The audit log is append-only.
- **Sensitive files** (`.env`, `*.key`, `*credentials*`) are excluded from workspace context sent to LLMs.
- **Workflow overrides** (forcing a stage gate, reassigning a task) require a mandatory reason which is recorded in the workflow event log alongside the acting identity.
- `.bormagi/` is excluded from source control via `.gitignore`.

---

*Bormagi — professional AI coding agents for your workspace.*
