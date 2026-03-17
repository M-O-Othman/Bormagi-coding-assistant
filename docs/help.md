# Bormagi Help Guide

Welcome to **Bormagi**, a powerful tool that enhances your coding experience within Visual Studio Code. This guide will walk you through how Bormagi works and how to make the most out of its features.

## Creation Date
Today’s date: **2026-03-06**

## What is Bormagi?

Bormagi is a VS Code extension designed to assist you in managing tasks with the help of AI coding agents. These agents can help with everything from writing code to organizing projects, making your development process more efficient and productive.

## Key Features

### 1. Create and Manage AI Agents
With Bormagi, you can create several AI coding agents tailored to your needs. Each agent is designed to handle specific tasks and can communicate with one another to provide solutions.

### 2. Unified Dashboard
Access all functionalities through a single dashboard. This panel allows you to:
- Chat with your agents
- Manage workflows
- Run virtual meetings
- Approve task handoffs

### 3. Multi-Agent Workflows
Bormagi supports the coordination of multiple agents. You can create workflows that involve several user-defined stages, ensuring tasks are completed in an organized way.

### 4. Virtual Meetings
You can hold structured discussions with your agents through virtual meetings, where tasks can be discussed, assigned, and reviewed collaboratively.

### 5. Document Generation
Agents can generate Word documents and PowerPoint presentations directly from your conversations, making it easy to keep records of discussions and decisions.

### 6. Predefined Agents
Bormagi comes with a set of predefined agents that can be installed for immediate use. These agents are ready-made to assist with common development tasks, such as coding, architecture decisions, and documentation.

### 7. Agent Knowledge Base & Semantic Memory
Agents feature Local File-Based Vector Retrieval (RAG). Before an agent responds, they automatically query their designated Knowledge Base (`.bormagi/memory/vectors/`) for injected context. Fact extraction happens automatically at the end of sessions to persist learnings.

### 8. Multi-Agent Collaboration
Agents can delegate sub-tasks to each other or broadcast shared knowledge using the local file-based Message Bus (`.bormagi/shared/bus/`). Agents enforce permissions and constraints defined in the `AgentRegistry`.

### 9. Sandbox Separated Work Environment
Agents execute all file modifications and terminal commands within an isolated "Sandbox" (`.bormagi/sandboxes/`). This ensures zero risk to your host project during agent orchestration. 
- You can review the agent's work and gracefully merge it into your codebase using the **`Bormagi: Apply Sandbox Changes`** command. 
- A granular Policy Engine (`.bormagi/policies/sandbox.policy.yaml`) automatically intercepts dangerous actions (e.g., `rm -rf /`) and enforces interactive approvals for sensitive directories.

## Host Environment

Bormagi adapts to what's installed on your machine. Run **Bormagi: Check Environment** from the Command Palette to see a live report.

| Component | Required? | What it enables | What happens without it |
|-----------|-----------|-----------------|------------------------|
| **VS Code 1.85+** | Yes | Extension host | Extension cannot run |
| **Node.js 18+** | Yes | Runtime (bundled with VS Code) | Extension cannot run |
| **LLM credential** | Yes | Agent responses | Agents cannot respond |
| **Git** | Recommended | Checkpoints, undo, diffs | Git features disabled |
| **npm** | Recommended | Post-session lint/test/typecheck | Validation skipped; file writes unaffected |
| **Python 3** | Optional | Python MCP servers, Python projects | Python features unavailable |
| **gcloud CLI** | Optional | GCP Vertex AI auth (ADC/OAuth) | Use API key for Gemini instead |
| **Docker** | Optional | Sandbox isolation | Agents write directly to workspace |

**Windows users:** Bormagi handles backslash paths automatically — no manual conversion needed.

## Getting Started

1. **Install the Extension**: You can download Bormagi from the Visual Studio Code Marketplace or install it using a `.vsix` file.
2. **Initialize Workspace**: Once installed, open Bormagi from the Command Palette and initialize your workspace.
3. **Check Environment**: Run **Bormagi: Check Environment** to see what tools are available and what features are enabled.
4. **Create Agents**: Use the dashboard to create or install agents that fit your project needs.
5. **Start Using Agents**: Interact with your agents through the chat function, or set up workflows to make the best use of their capabilities.