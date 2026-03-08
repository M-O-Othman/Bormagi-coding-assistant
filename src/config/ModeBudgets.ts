// ─── Mode Budget Defaults and Configuration ────────────────────────────────────
//
// Default token budget allocations per assistant mode.
// Spec values (§FR-6 MODE_BUDGETS) are the defaults; every slot is
// overridable via VS Code settings (bormagi.contextPipeline.budgets.<mode>.<slot>).
//
// Single source of truth: this file.
// All values exposed in package.json contributes.configuration.

import * as vscode from 'vscode';
import type { AssistantMode, ModeBudget } from '../context/types';

// ─── Spec defaults ────────────────────────────────────────────────────────────

export const DEFAULT_MODE_BUDGETS: Record<AssistantMode, ModeBudget> = {
  plan: {
    stablePrefix:     1800,
    memory:           1200,
    repoMap:          2400,
    retrievedContext: 4000,
    toolOutputs:      1000,
    conversationTail: 1200,
    userInput:         800,
    reservedMargin:   2500,
  },
  edit: {
    stablePrefix:     1800,
    memory:           1200,
    repoMap:          1200,
    retrievedContext: 7000,
    toolOutputs:      1200,
    conversationTail: 1000,
    userInput:         800,
    reservedMargin:   3000,
  },
  debug: {
    stablePrefix:     1800,
    memory:           1200,
    repoMap:          1200,
    retrievedContext: 5000,
    toolOutputs:      2600,
    conversationTail: 1200,
    userInput:         800,
    reservedMargin:   3000,
  },
  review: {
    stablePrefix:     1800,
    memory:           1000,
    repoMap:          1000,
    retrievedContext: 5000,
    toolOutputs:      2200,
    conversationTail: 1000,
    userInput:         800,
    reservedMargin:   3000,
  },
  explain: {
    stablePrefix:     1800,
    memory:           1000,
    repoMap:          2200,
    retrievedContext: 3500,
    toolOutputs:       800,
    conversationTail: 1200,
    userInput:         800,
    reservedMargin:   2500,
  },
  search: {
    stablePrefix:     1600,
    memory:            800,
    repoMap:          2600,
    retrievedContext: 3200,
    toolOutputs:       800,
    conversationTail:  800,
    userInput:         800,
    reservedMargin:   2200,
  },
  "test-fix": {
    stablePrefix:     1800,
    memory:           1200,
    repoMap:          1200,
    retrievedContext: 5000,
    toolOutputs:      2800,
    conversationTail: 1000,
    userInput:         800,
    reservedMargin:   3200,
  },
  ask: {
    stablePrefix:     1800,
    memory:           1000,
    repoMap:          2200,
    retrievedContext: 3500,
    toolOutputs:       800,
    conversationTail: 1200,
    userInput:         800,
    reservedMargin:   2500,
  },
  code: {
    stablePrefix:     1800,
    memory:           1200,
    repoMap:          1200,
    retrievedContext: 7000,
    toolOutputs:      1200,
    conversationTail: 1000,
    userInput:         800,
    reservedMargin:   3000,
  },
};

// ─── Resolved budget (defaults merged with user settings) ─────────────────────

/**
 * Returns the resolved `ModeBudget` for `mode`, applying any user overrides
 * from VS Code settings (`bormagi.contextPipeline.budgets.<mode>.<slot>`).
 */
export function getModeBudget(mode: AssistantMode): ModeBudget {
  const cfg = vscode.workspace.getConfiguration(`bormagi.contextPipeline.budgets.${mode}`);
  const d = DEFAULT_MODE_BUDGETS[mode];
  return {
    stablePrefix:     cfg.get<number>('stablePrefix',     d.stablePrefix),
    memory:           cfg.get<number>('memory',           d.memory),
    repoMap:          cfg.get<number>('repoMap',          d.repoMap),
    retrievedContext: cfg.get<number>('retrievedContext', d.retrievedContext),
    toolOutputs:      cfg.get<number>('toolOutputs',      d.toolOutputs),
    conversationTail: cfg.get<number>('conversationTail', d.conversationTail),
    userInput:        cfg.get<number>('userInput',        d.userInput),
    reservedMargin:   cfg.get<number>('reservedMargin',   d.reservedMargin),
  };
}

/** Sum all slots in a budget to get the total allocated token count. */
export function totalBudget(budget: ModeBudget): number {
  return (
    budget.stablePrefix +
    budget.memory +
    budget.repoMap +
    budget.retrievedContext +
    budget.toolOutputs +
    budget.conversationTail +
    budget.userInput +
    budget.reservedMargin
  );
}
