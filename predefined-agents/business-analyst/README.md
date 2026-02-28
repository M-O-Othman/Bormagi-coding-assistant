# Business Analyst Agent

## Overview

The Business Analyst agent is a predefined Bormagi agent that produces professional business documentation directly within your VS Code workspace. It bridges the gap between stakeholder intent and technical delivery by translating business needs into structured, unambiguous artefacts that development teams can act upon with confidence.

## What This Agent Does

The Business Analyst agent assists with the full spectrum of requirements engineering and business analysis tasks, including:

- **Business Requirements Documents (BRDs):** Scoped, structured documents capturing objectives, assumptions, constraints, and prioritised requirements.
- **User Stories:** Written in standard format (As a... I want... So that...) with acceptance criteria in Given/When/Then notation.
- **Functional Specifications:** Detailed descriptions of system behaviour, data flows, and business rules suitable for developer handoff.
- **Gap Analysis:** Structured comparisons of AS-IS and TO-BE states, with a prioritised remediation roadmap.
- **Feature Definitions:** Concise descriptions of features, their business justification, target users, and exclusions.
- **Process Flow Diagrams:** Text-based representations of business processes, decision points, and actor swimlanes.

## Configuration

| Setting | Value |
|---|---|
| Provider | Anthropic |
| Model | claude-sonnet-4-6 |
| Auth Method | API Key |

The agent reads source files with common code and document extensions and excludes build artefacts, dependencies, and version control directories.

## Usage

Activate this agent in the Bormagi panel and provide a description of the business problem, feature, or process you need documented. For best results, include relevant context such as existing specifications, stakeholder notes, or related source files.

## Output Style

All output is written in formal British English with professional documentation structure. The agent does not use informal language or emojis.
