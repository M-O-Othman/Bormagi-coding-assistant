# Bormagi

**Bormagi** is a VS Code extension that lets you create and manage named AI coding agents, each powered by your choice of LLM provider. Agents use the Model Context Protocol (MCP) to read and write files, run terminal commands, interact with Git, deploy to Google Cloud Platform, and produce Word/PowerPoint documents — all within your workspace.

A unified **Dashboard** panel gives you a single place to chat with agents, manage multi-agent workflows, run virtual meetings, approve handoffs, resolve blockers, and configure the extension — without leaving VS Code.

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
4. [Virtual Meetings](#virtual-meetings)
5. [Document and Presentation Creation](#document-and-presentation-creation)
6. [Installing Predefined Agents](#installing-predefined-agents)
7. [Creating a Custom Agent](#creating-a-custom-agent)
8. [Workspace Default Provider](#workspace-default-provider)
9. [Connecting Agents to LLM Providers](#connecting-agents-to-llm-providers)
   - [OpenAI](#openai)
   - [Anthropic (Claude)](#anthropic-claude)
   - [Google Gemini — API Key](#google-gemini--api-key)
   - [Google Gemini — OAuth via Proxy (No API Key)](#google-gemini--oauth-via-proxy-no-api-key)
   - [Google Gemini — GCP Vertex AI (ADC/OAuth)](#google-gemini--gcp-vertex-ai-adcoauth)
   - [Deepseek](#deepseek)
   - [Qwen (Alibaba Cloud)](#qwen-alibaba-cloud)
   - [Custom (OpenAI-compatible)](#custom-openai-compatible)
10. [Using a Proxy for LLM Calls](#using-a-proxy-for-llm-calls)
11. [Chatting with an Agent](#chatting-with-an-agent)
12. [Skills](#skills)
13. [File and Folder Structure](#file-and-folder-structure)
14. [Agent Configuration Reference](#agent-configuration-reference)
15. [MCP Tools Reference](#mcp-tools-reference)
16. [Security](#security)
17. [Publishing to the Marketplace](#publishing-to-the-marketplace)
18. [Recent Enhancements](#recent-enhancements-nf2-batch--all-complete)
19. [Building Agents](#building-agents)

---

## Quick Start

1. Open a workspace folder in VS Code.
2. Open the Command Palette (`Ctrl+Shift+P`) and run **`Bormagi: Initialise Workspace`**.
3. Run **`Bormagi: Install Predefined Agents`** to add the built-in agent set.
4. Run **`Bormagi: Open Dashboard`** (or click the robot icon in the Activity Bar sidebar).
5. Go to the **Setup** tab → **Workspace** → **Agent Settings Panel**.
   - Set a **Default Provider** (provider, model, API key) and click **Apply to all agents** to configure every agent at once.
   - Or configure each agent's provider individually.
6. Switch to the **Chat** tab, select an agent, and start typing.
7. *(Optional)* Run **`Bormagi: Start Virtual Meeting`** to hold a multi-agent discussion.

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
| `Bormagi: Start Virtual Meeting` | Open the virtual meeting room |

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

### Further reading

| Document | Contents |
|---|---|
| [docs/workflow-examples.md](docs/workflow-examples.md) | End-to-end walkthroughs: creating a workflow, handoffs, reviews, blockers, overrides, and custom templates — with real JSON payloads |
| [docs/workflow-developer-api.md](docs/workflow-developer-api.md) | Template schema reference, engine API, storage layout, agent completion protocol |

---

## Virtual Meetings

Bormagi can run a **virtual meeting** — a structured multi-agent discussion where several of your installed agents each contribute their perspective to a shared agenda.

### Starting a meeting

Open a meeting in one of two ways:

- **Command Palette** (`Ctrl+Shift+P`) → **`Bormagi: Start Virtual Meeting`**
- Click the **meeting button** (group icon) in the chat toolbar

### Setup tab

Before the meeting starts, configure:

| Field | Description |
|---|---|
| **Meeting title** | A short description of what the meeting is about |
| **Agenda items** | One discussion point per line |
| **Participants** | Select which installed agents should attend |
| **Resource files** | Optional — attach workspace files as shared context (e.g. a spec, an ERD, a README) |

Click **Start Meeting** to begin.

### Meeting tab

Agents respond sequentially per agenda item — each agent sees all prior responses for that item before composing its own. Responses stream in real-time.

The left column shows the agenda with live status indicators (`pending` → `discussing` → `resolved`). The right column shows all agent responses for the selected item.

For each agenda item you can:

- **Record a Decision** — type the outcome and click **Mark resolved**
- **Add an Action Item** — assign follow-up work to a specific agent

### Action Items tab

All action items for the meeting are listed here with their assigned agent. Action items appear in this tab as you add them during the meeting.

### Minutes tab

Click **Generate Minutes** to produce a complete Markdown summary of the meeting: agenda, all agent responses, decisions, and action items. Click **Save to File** to persist the minutes to `.bormagi/virtual-meetings/<meeting-id>/minutes.md`.

### Storage

Each meeting is saved under:

```
.bormagi/
└── virtual-meetings/
    └── <meeting-id>/
        ├── meeting.json    ← full meeting state (agenda, rounds, action items)
        └── minutes.md      ← generated minutes (after saving)
```

---

## Document and Presentation Creation

Agents can produce Word documents (`.docx`) and PowerPoint presentations (`.pptx`) directly from their Markdown output.

### How to request a document

In chat, ask the agent to create a document. For example:

> "Write an architecture decision record for our API gateway choice and save it as a Word document."

> "Create a slide deck summarising the onboarding process."

The agent will call the `create_document` or `create_presentation` tool. You will see an approval prompt before the file is written to the workspace.

### Markdown format for documents

Use standard Markdown in the agent's content:

| Markdown | Output |
|---|---|
| `# Heading 1` | Heading 1 style |
| `## Heading 2` | Heading 2 style |
| `### Heading 3` | Heading 3 style |
| `- bullet item` | Bullet list |
| Plain text | Normal paragraph |

### Markdown format for presentations

Use `## Slide Title` to start each slide. The first `##` becomes the title slide. Subsequent slides use `- bullets` for content:

```markdown
## My Presentation

## Problem Statement
- Current process takes 3 days
- Manual handoffs cause errors

## Proposed Solution
- Automate via API
- Zero manual steps
```

### Output files

Documents and presentations are saved to the workspace root with the filename the agent specifies. Both tools require your approval before writing.

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

## Workspace Default Provider

If you want all agents to share a single LLM provider and API key, use the **Workspace Default Provider** instead of configuring each agent individually.

### Setting up

1. In the Dashboard, go to **Setup → Workspace → Agent Settings Panel**.
2. In the **Default Provider** section at the top, select your provider and model, and enter the API key.
3. Click **Save Default Provider**.
4. Click **Apply to all agents** — this sets every installed agent to use the workspace default provider.

From now on, changing the default provider and clicking **Apply to all agents** updates all agents at once.

### How it works

- Agents with `useDefaultProvider: true` in their config always use the workspace default.
- If an agent has no own API key configured, Bormagi automatically falls back to the workspace default when one is available.
- The default API key is stored under the key `__default__` in VS Code `SecretStorage` — never written to disk.

### Per-agent override

Any agent can have its own provider configured independently via Agent Settings. Per-agent settings take priority over the workspace default.

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

### Google Gemini — OAuth via Proxy (No API Key)

Use this mode when your organisation requires requests to pass through a proxy and identity is enforced via OAuth (Bearer token), not API keys.

**Prerequisites:**

```bash
# Install Google Cloud CLI first:
# https://cloud.google.com/sdk/docs/install

gcloud auth application-default login
```

**In Agent Settings:**

- Provider: `gemini`
- Auth Method: `OAuth Identity via Proxy (no API key)`
- API Key: leave blank
- Proxy URL: set your proxy endpoint (optional if Base URL already points at your proxy)
- Base URL: optional override for the Gemini endpoint your proxy exposes

### Google Gemini — GCP Vertex AI (ADC/OAuth)

This method allows you to authenticate using your corporate Google Workspace identity — no separate API key required.

**Prerequisites:**

```bash
# Install the Google Cloud CLI
# https://cloud.google.com/sdk/docs/install

# Sign in with your corporate SSO account
gcloud auth application-default login

# Set your GCP project
gcloud config set project YOUR_PROJECT_ID

# Bind ADC quota/billing to your project
gcloud auth application-default set-quota-project YOUR_PROJECT_ID

# Ensure Vertex AI API is enabled
gcloud services enable aiplatform.googleapis.com --project YOUR_PROJECT_ID
```

This creates a local credential file (`~/.config/gcloud/application_default_credentials.json`). Bormagi reads this automatically.

**In Agent Settings:**

- Provider: `gemini`
- Auth Method: `GCP Vertex AI (ADC/OAuth)`
- API Key: leave blank
- Base URL: optional (defaults to `https://<LOCATION>-aiplatform.googleapis.com/v1`)
- Proxy URL: optional (use only if your org routes Vertex through a proxy)

### Deepseek

1. Obtain an API key from [platform.deepseek.com](https://platform.deepseek.com).
2. Set Provider to `deepseek`, select model (`deepseek-chat` or `deepseek-coder`).
3. Paste your API key. The base URL (`https://api.deepseek.com/v1`) is set automatically.

### Qwen (Alibaba Cloud)

1. Obtain an API key from Alibaba Cloud DashScope.
2. Set Provider to `qwen`, select model (`qwen-max` recommended).
3. Paste your API key. The base URL is set automatically.

### Custom (OpenAI-compatible)

Any service that exposes an OpenAI-compatible chat completions API can be used — including local models via Ollama, hosted routing services like OpenRouter, and many other providers (Mistral, Groq, Together AI, Cohere, etc.).

1. In Agent Settings, select **Custom (OpenAI-compatible)** as the provider.
2. Set the **Base URL** to the endpoint's chat completions base (the path up to but not including `/chat/completions`).
3. Enter a model name exactly as the endpoint expects it.
4. Paste your API key, or leave it blank for endpoints that do not require authentication (e.g. a local Ollama instance).

**Common base URLs:**

| Service | Base URL |
|---|---|
| Ollama (local) | `http://localhost:11434/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| Together AI | `https://api.together.xyz/v1` |
| LiteLLM proxy | `http://your-server:4000` |

**Using Ollama with a local model:**

```bash
# Install Ollama (https://ollama.ai)
ollama pull llama3.2        # or: mistral, codellama, phi4, etc.
ollama serve                 # starts the API server on port 11434
```

In Agent Settings:
- Provider: `Custom (OpenAI-compatible)`
- Base URL: `http://localhost:11434/v1`
- Model: `llama3.2` (must match the name used in `ollama pull`)
- API Key: leave blank

**Using OpenRouter (200+ hosted models):**

```
Base URL:  https://openrouter.ai/api/v1
Model:     anthropic/claude-3.5-sonnet  (or any slug from openrouter.ai/models)
API Key:   your OpenRouter key
```

> If the endpoint requires a specific HTTP header that is not an `Authorization` header, set up a lightweight proxy and point the Base URL at it.

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
├── project.json                       ← Project name, agent index, default provider config
├── audit.log                          ← Append-only log of all agent actions (JSONL)
├── skills/
│   └── my-skill.md                    ← Shared skills (all agents)
├── agents-definition/
│   └── <agent-id>/
│       ├── config.json                ← Agent config (provider, model, tools)
│       ├── system-prompt.md           ← Main system prompt
│       ├── [extra-prompt.md]          ← Optional additional prompt files
│       └── Memory.md                  ← Append-only conversation history
├── workflows/
│   └── <workflow-id>/
│       ├── workflow.json              ← Workflow state
│       ├── tasks-snapshot.json        ← Task states
│       ├── handoffs-snapshot.json     ← Handoff approvals
│       ├── reviews.json               ← QA review outcomes
│       ├── blockers.json              ← Active blockers
│       ├── artifacts.json             ← Artifact registry
│       ├── decisions.jsonl            ← Append-only decision log
│       ├── events.jsonl               ← Append-only workflow event log
│       └── execution.lock             ← Active task lock (prevents concurrent execution)
└── virtual-meetings/
    └── <meeting-id>/
        ├── meeting.json               ← Full meeting state (agenda, rounds, action items)
        └── minutes.md                 ← Generated minutes (saved after meeting)
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
| `provider.type` | string | `openai`, `anthropic`, `gemini`, `deepseek`, `qwen`, `openai_compatible` |
| `provider.model` | string | Model identifier (e.g. `gpt-4o`, `claude-sonnet-4-6`) |
| `provider.base_url` | string \| null | Override the default API endpoint |
| `provider.proxy_url` | string \| null | Route all calls through this proxy |
| `provider.auth_method` | string | `api_key`, `oauth_proxy`, or `vertex_ai` (`gcp_adc` accepted as legacy alias) |
| `system_prompt_files` | string[] | List of `.md` files to compose the system prompt |
| `mcp_servers` | array | Custom MCP server configurations (optional) |
| `context_filter.include_extensions` | string[] | File extensions to include in workspace context |
| `context_filter.exclude_patterns` | string[] | Directory/file patterns to exclude |
| `useDefaultProvider` | boolean | If `true`, agent uses the workspace default provider instead of its own `provider` config |

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
| `create_document` | Create a Word document (`.docx`) from Markdown | Yes — approval prompt |
| `create_presentation` | Create a PowerPoint presentation (`.pptx`) from slide Markdown | Yes — approval prompt |

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

---

## Publishing to the Marketplace

Bormagi can be published to the VS Code Marketplace as a packaged `.vsix` extension.

### Prerequisites

- Node.js ≥ 18
- A Microsoft account
- An Azure DevOps organisation (free — only needed to generate a Personal Access Token)
- A unique publisher name on [marketplace.visualstudio.com](https://marketplace.visualstudio.com/manage)

### Quick steps

```bash
# 1. Generate the marketplace icon (128×128 PNG)
npm run generate-icon

# 2. Authenticate vsce with your publisher ID and PAT
npx vsce login <your-publisher-id>

# 3. Package locally and test
npm run vsce:package
# → installs the .vsix in VS Code: Extensions → ··· → Install from VSIX

# 4. Publish
npm run vsce:publish
```

For the full step-by-step guide — including how to create an Azure DevOps organisation, generate a PAT, and set up automated publishing via GitHub Actions — see [PUBLISHING.md](PUBLISHING.md).

---

---

## Recent Enhancements (NF2 batch — all complete)

The following 12 improvements were delivered as the NF2 enhancement batch, sourced from a multi-agent architecture review (`docs/newfeatures2.md`). All are implemented and shipped. See `tasks/task_plan.md` (Phase NF2-*) for full task notes.

| ID | Title | Theme | What was delivered |
|----|-------|-------|--------------------|
| NF2-UX-002 | Unified Status Panel | UX | Persistent `#status-bar` on chat, meeting, and workflow panels with pulse animation, error state, and auto-dismiss |
| NF2-AI-001 | Context Window Management | AI Quality | Character-based token estimation; oldest turns trimmed when within 10% of model limit; badge shown in thought trace |
| NF2-SEC-001 | Secrets & Dependency Audit | Security | CI gates: gitleaks secrets scan + `npm audit --audit-level=high`; `.gitleaks.toml` allowlist |
| NF2-QA-001 | Integration Test Harness | Testing | 57 tests across 7 suites: meeting storage, meeting flow, context-window logic, workflow state machine, e2e workflow, restart recovery, contract tests |
| NF2-UX-001 | Design System | UX | `media/styles.css` canonical component library; overflow toolbar and slide-out log drawer in chat panel |
| NF2-DOC-001 | Developer Onboarding Guide | Docs | `docs/guides/onboarding.md`: prerequisites, build, F5 dev mode, E2E verification, common errors |
| NF2-AI-002 | Structured Output Validation | AI Quality | 9 prompt-injection patterns; `sanitiseExecutionResult()` strips offending lines; `PROMPT_INJECTION_DETECTED` audit event |
| NF2-UX-003 | Role-Based Onboarding | UX | First-launch setup wizard: role selection → provider → API key → agent pre-selection; role persisted in config |
| NF2-DOC-002 | Architecture Decision Records | Docs | `docs/adr/` with template + 4 ADRs (workspace folder, SecretStorage, JSONL dual-store, webpack CommonJS) |
| NF2-SEC-002 | Audit Log Integrity | Security | Rolling HMAC-SHA256 chain on every audit log entry; `bormagi.verifyAuditLog` command reports broken links |
| NF2-DOC-003 | Agent Protocol Contract | Docs | `docs/agent-protocol.md` + `schemas/agent-completion.schema.json` (JSON Schema Draft 07); see Building Agents section below |
| NF2-QA-002 | Acceptance Criteria in Specs | Testing | All feature specs converted to Given/When/Then; spec-lint CI gate added |

---

## Building Agents

Bormagi agents communicate with the workflow orchestration engine using a structured completion protocol. When an agent runs inside a workflow task, it can signal one of four outcomes by embedding a JSON block in its response:

| Outcome | When to use |
|---------|-------------|
| `completed` | The agent finished its objective |
| `delegated` | A specialist agent should take over or collaborate |
| `review_requested` | A reviewer agent should validate the work before proceeding |
| `blocked` | The agent cannot proceed without human input or a missing dependency |

**Example — delegation:**

````
```json
{
  "__bormagi_outcome__": true,
  "outcome": "delegated",
  "summary": "Requirements approved. Handing off to the solution architect.",
  "toAgentId": "solution-architect",
  "objective": "Design the system architecture based on the approved requirements.",
  "reasonForHandoff": "Requirements phase complete.",
  "expectedOutputs": ["Architecture diagram", "ADR"],
  "doneCriteria": ["All components defined", "ADRs written"]
}
```
````

Agents that produce no structured payload are treated as **completed** automatically — all existing plain-text agents work without modification.

Full protocol reference: [`docs/agent-protocol.md`](docs/agent-protocol.md)
JSON Schema (Draft 07): [`schemas/agent-completion.schema.json`](schemas/agent-completion.schema.json)

---

*Bormagi — professional AI coding agents for your workspace.*
