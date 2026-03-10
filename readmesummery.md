# Bormagi README Summary

This document provides a concise summary of the Bormagi VS Code extension, based on the main `README.md` file.

## What is Bormagi?

Bormagi is a powerful VS Code extension that allows developers to create, manage, and interact with named AI coding agents directly within their workspace. These agents are configurable with various LLM providers (including OpenAI, Anthropic, Google Gemini, and custom OpenAI-compatible services like local Ollama instances) and can perform a wide range of tasks.

## Core Features

-   **AI Agents & Skills**: Create custom agents or install a predefined set (e.g., Solution Architect, Advanced Coder). Agents can use a shared knowledge base of "skills" located in `.bormagi/skills/`.
-   **Unified Dashboard**: A central panel in VS Code to chat with agents, orchestrate multi-agent workflows, manage a queue for reviews and approvals, and configure the extension.
-   **Workflow Orchestration**: Coordinate multiple agents through structured pipelines (e.g., "New Feature Delivery," "Bug Fix"). Workflows include stages, human approval gates, handoffs, and a complete audit trail.
-   **Virtual Meetings**: Host structured discussions with multiple AI agents simultaneously to collaborate on a specific agenda, record decisions, and generate meeting minutes.
-   **Core Capabilities (Tools)**: Agents can perform actions such as:
    -   Reading and writing files.
    -   Executing terminal commands.
    -   Interacting with Git (status, commit, push, PR creation).
    -   Deploying to Google Cloud Platform.
    -   Creating Word (`.docx`) and PowerPoint (`.pptx`) documents.
-   **Security & Safety**: Bormagi prioritises safety:
    -   API keys are stored securely in VS Code's encrypted `SecretStorage`.
    -   All potentially destructive actions, like file writes and shell commands, require explicit user approval via diff views or prompts.
    -   Agents operate in a sandboxed environment (`.bormagi/sandboxes/`) to prevent unintended changes to the project.
-   **Advanced Git Integration**: The extension provides a safety net by automatically creating "Shadow Checkpoints" before an agent modifies files, allowing for easy one-click rollbacks. It can also manage the full GitHub PR lifecycle.

## Quick Start

1.  Open a workspace and run **`Bormagi: Initialise Workspace`**.
2.  Run **`Bormagi: Install Predefined Agents`** to get started with a built-in agent set.
3.  Open the **Dashboard**, navigate to the **Setup** tab, and configure an LLM provider (either a workspace default or per-agent).
4.  Go to the **Chat** tab to begin interacting with an agent.

All Bormagi-related configuration and data are stored within the `.bormagi/` directory at the root of your workspace, which is automatically added to `.gitignore`.