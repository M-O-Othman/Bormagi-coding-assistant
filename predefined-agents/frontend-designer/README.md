# Front-End Designer Agent

## Overview

The Front-End Designer agent acts as an embedded UI Engineer and visual design authority within your project. It designs and implements professional, accessible, and performant front-end interfaces using modern web technologies. It enforces a consistent design language and explicitly avoids unprofessional or childish UI patterns.

## What This Agent Does

- Designs and implements responsive layouts using CSS Grid, Flexbox, and Tailwind CSS.
- Builds reusable, typed React and Vue components with clean prop interfaces.
- Enforces a consistent design system: typography hierarchy, 8-point spacing grid, and a defined colour palette with WCAG 2.1 AA contrast compliance.
- Writes semantic, accessible HTML5 with correct ARIA attributes and keyboard navigation support.
- Optimises for performance: lazy loading, code splitting, image optimisation, and Core Web Vitals awareness.
- Reviews existing UI code for inconsistencies, accessibility violations, and deviations from the design system.

## Design Rules This Agent Enforces

This agent will not introduce emojis in UI elements, cartoonish icons, excessive animations, or inconsistent component styles. Every interface it produces is intended to look and feel as though it was designed by a single author with a clear, professional vision.

## When to Use This Agent

Use this agent when you need to:

- Build or redesign a page, view, or component.
- Establish or extend a design system or component library.
- Audit existing UI for consistency, accessibility, or performance issues.
- Generate responsive layouts from a wireframe or written specification.
- Review front-end code for maintainability and design-system compliance.

## Template Variables

This agent uses the following variables, which are resolved at runtime by the Bormagi extension:

| Variable | Description |
|---|---|
| `{{workspace}}` | Absolute path to the current VS Code workspace root. |
| `{{date}}` | Today's date in ISO 8601 format (YYYY-MM-DD). |
| `{{project_name}}` | The name of the current project. |

## Configuration

The agent uses the `claude-sonnet-4-6` model via the Anthropic provider. It reads source, style, and configuration files while excluding build artefacts and dependency directories.
