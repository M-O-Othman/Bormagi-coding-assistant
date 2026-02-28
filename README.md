# Bormagi

**Bormagi** is a VS Code extension that lets you create and manage named AI coding agents, each powered by your choice of LLM provider. Agents use the Model Context Protocol (MCP) to read and write files, run terminal commands, interact with Git, and deploy to Google Cloud Platform — all within your workspace.

No admin permissions are required. Install from the VS Code Marketplace or from a `.vsix` file.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Installing Predefined Agents](#installing-predefined-agents)
3. [Creating a Custom Agent](#creating-a-custom-agent)
4. [Connecting Agents to LLM Providers](#connecting-agents-to-llm-providers)
   - [OpenAI](#openai)
   - [Anthropic (Claude)](#anthropic-claude)
   - [Google Gemini — API Key](#google-gemini--api-key)
   - [Google Gemini — GCP SSO (Corporate Identity)](#google-gemini--gcp-sso-corporate-identity)
   - [Deepseek](#deepseek)
   - [Qwen (Alibaba Cloud)](#qwen-alibaba-cloud)
5. [Using a Proxy for LLM Calls](#using-a-proxy-for-llm-calls)
   - [Option 1: Cloud Run Proxy](#option-1-cloud-run-proxy)
   - [Option 2: Apigee API Gateway](#option-2-apigee-api-gateway)
   - [Option 3: GCP Cloud Endpoints](#option-3-gcp-cloud-endpoints)
   - [Option 4: GCP API Gateway (REST)](#option-4-gcp-api-gateway-rest)
6. [Chatting with an Agent](#chatting-with-an-agent)
7. [Skills](#skills)
8. [File and Folder Structure](#file-and-folder-structure)
9. [Agent Configuration Reference](#agent-configuration-reference)
10. [MCP Tools Reference](#mcp-tools-reference)
11. [Security](#security)

---

## Quick Start

1. Open a workspace folder in VS Code.
2. Open the Command Palette (`Ctrl+Shift+P`) and run **`Bormagi: Initialise Workspace`**.
3. Run **`Bormagi: Install Predefined Agents`** to add the built-in agent set.
4. Open the Bormagi sidebar (robot icon in the Activity Bar).
5. Run **`Bormagi: Open Agent Settings`** to add your API keys.
6. In the chat panel, type `@advanced-coder` followed by your request.

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

After installation, add API keys via **`Bormagi: Open Agent Settings`**.

---

## Creating a Custom Agent

1. Run **`Bormagi: Create New Agent`** or click **+ New Agent** in Agent Settings.
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

Open the Bormagi sidebar (robot icon). In the input box:

| Syntax | Effect |
|---|---|
| `@advanced-coder refactor this function` | Switch to the `advanced-coder` agent and send the message |
| `@solution-architect design a microservice for X` | Activate the solution architect |
| `/undo` | Undo the last file change made by the active agent |

All subsequent messages go to the last `@mentioned` agent until you mention another. The status bar shows the active agent.

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
└── agents-definition/
    └── <agent-id>/
        ├── config.json                ← Agent config (provider, model, tools)
        ├── system-prompt.md           ← Main system prompt
        ├── [extra-prompt.md]          ← Optional additional prompt files
        └── Memory.md                  ← Append-only conversation history
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
| `gcp_auth_status` | Check gcloud authentication | No |
| `gcp_deploy` | Run a gcloud deployment command | Yes — explicit prompt |

Custom MCP servers can be added per-agent in `config.json` under `mcp_servers`.

---

## Security

- **API keys** are stored in VS Code's `SecretStorage` (OS-level encrypted storage). They are never written to any file on disk.
- **File writes** are restricted to the workspace root. Agents cannot write outside the project folder.
- **Terminal commands** and **git commits** require your explicit approval before execution.
- **Audit log** at `.bormagi/audit.log` records every tool call, file write, and command executed by agents in structured JSON Lines (JSONL) format. File contents in `write_file` calls are redacted to a character count.
- `.bormagi/` is excluded from source control via `.gitignore`.

---

*Bormagi — professional AI coding agents for your workspace.*
