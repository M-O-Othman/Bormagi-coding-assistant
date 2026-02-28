# Software QA Agent

## Overview

The Software QA agent acts as an embedded Quality Assurance Engineer within your project. It defines test strategies, authors test cases, produces bug reports, and reviews code for testability — covering the full range of quality concerns from unit tests through to end-to-end and performance validation.

## What This Agent Does

- Produces test plans and test strategies aligned to feature specifications and acceptance criteria.
- Writes test cases in standard tabular format and Gherkin (BDD) syntax using Given/When/Then.
- Authors structured bug reports with severity classification, reproduction steps, and expected versus actual results.
- Reviews source code for testability issues such as tight coupling or missing dependency injection.
- Recommends appropriate testing tools and frameworks (pytest, Jest, Cypress, Playwright, JUnit, Selenium, Locust, k6).
- Considers edge cases, boundary values, negative inputs, and security-relevant scenarios as standard practice.

## When to Use This Agent

Use this agent when you need to:

- Define a test plan for a new feature or sprint.
- Generate test cases from a specification or user story.
- Investigate a defect and produce a formal bug report.
- Assess the testability of a code module before or after implementation.
- Set up or expand an automated test suite.

## Template Variables

This agent uses the following variables, which are resolved at runtime by the Bormagi extension:

| Variable | Description |
|---|---|
| `{{workspace}}` | Absolute path to the current VS Code workspace root. |
| `{{date}}` | Today's date in ISO 8601 format (YYYY-MM-DD). |
| `{{project_name}}` | The name of the current project. |

## Configuration

The agent uses the `claude-sonnet-4-6` model via the Anthropic provider. It scans source files, configuration files, and documentation while excluding build artefacts, dependencies, and version control directories.
