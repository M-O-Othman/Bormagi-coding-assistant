/**
 * DataStore — runtime loader for all static extension configuration.
 *
 * All hardcoded model lists, pricing tables, regex patterns, tool schemas,
 * category lists, provider presets, and prompt templates have been moved to
 * files under `data/` and `prompts/` in the extension root.  This module
 * reads those files once at activation time and exposes a typed `AppData`
 * object via `getAppData()`.
 *
 * Usage:
 *   1. Call `await initDataStore(context.extensionPath)` as the first line
 *      of `activate()` in extension.ts.
 *   2. Call `getAppData()` anywhere in production code to access the data.
 *   3. Call `__setTestData(partial)` in unit tests to inject test fixtures.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MCPToolDefinition } from '../types';
import type { ProviderType, AuthMethod } from '../types';

// ─── Public data types ────────────────────────────────────────────────────────

export interface ProviderPreset {
  label: string;
  type: ProviderType;
  defaultModel: string;
  authMethod: AuthMethod;
  keyPlaceholder: string;
}

export interface OnboardingRole {
  id: string;
  description: string;
  recommendedAgents: string[];
  recommendedWorkflows: string[];
}

export interface ArtifactCommand {
  id: string;
  label: string;
  promptFile: string;
}

/** Raw `{ pattern, flags }` object as stored in JSON. */
export interface PatternDef {
  pattern: string;
  flags: string;
}

export interface AppData {
  // data/models.json
  providerModels:  Record<string, string[]>;
  contextLimits:   Record<string, number>;
  pricing:         Record<string, { in: number; out: number }>;

  // data/providers.json
  providerPresets: ProviderPreset[];

  // data/onboarding.json
  onboarding: {
    roles: OnboardingRole[];
    availableAgents: string[];
  };

  // data/agent-categories.json
  agentCategories: string[];

  // data/tools.json
  virtualTools:  MCPToolDefinition[];
  toolServerMap: Record<string, string>;
  approvalTools: Set<string>;

  // data/file-scanner.json
  includeExtensions: Set<string>;
  excludePatterns:   string[];
  sensitivePatterns: RegExp[];

  // data/security.json
  contextWindow:    { trimThreshold: number; keepTurns: number };
  secretPatterns:   RegExp[];
  injectionPatterns: RegExp[];

  // data/artifact-commands.json
  artifactCommands: ArtifactCommand[];

  // data/architecture-patterns.json
  architecturePatterns: Record<string, unknown>;

  // data/validator-rules.json
  validatorRules: { rules: Record<string, { code: string; severity: string; autoFixable: boolean; message: string }> };

  // data/execution-messages.json
  executionMessages: {
    toolBlocked: { bormagiPath: string; reread: string; budgetExhausted: string; offBatch: string };
    toolSummary: { format: string; formatNoPath: string };
    continueResume: Record<string, string>;
    stateContextNote: Record<string, string>;
    validatorIssues: Record<string, string>;
    promptAssembly?: Record<string, string>;
    artifactRedirect?: Record<string, string>;
    terminalStates?: Record<string, string>;
    recovery?: Record<string, string>;
  };

  // prompts/default-system-prompt.md
  defaultSystemPrompt: string;

  // prompts/artifacts/<id>.md  (keyed by artifact command id)
  artifactPrompts: Record<string, string>;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _data: AppData | null = null;

/**
 * Load all data files from the extension root.
 * Must be called once as the first statement of `activate()`.
 */
export async function initDataStore(extensionPath: string): Promise<void> {
  _data = loadAll(extensionPath);
}

/**
 * Return the loaded app data.
 * Throws if `initDataStore` has not been called yet.
 */
export function getAppData(): AppData {
  if (!_data) {
    throw new Error('DataStore has not been initialised. Call initDataStore() first.');
  }
  return _data;
}

/**
 * Override specific AppData fields for unit tests.
 * Safe to call before `initDataStore` — will initialise `_data` with defaults
 * for any fields not provided.
 */
export function __setTestData(data: Partial<AppData>): void {
  _data = { ...emptyAppData(), ..._data, ...data };
}

// ─── Loader (synchronous — all files are small and local) ─────────────────────

function loadAll(extensionPath: string): AppData {
  const dataDir    = path.join(extensionPath, 'data');
  const promptsDir = path.join(extensionPath, 'prompts');

  // ── models.json ────────────────────────────────────────────────────────────
  const modelsJson = readJson<{
    providerModels: Record<string, string[]>;
    contextLimits:  Record<string, number>;
    pricing:        Record<string, { in: number; out: number }>;
  }>(path.join(dataDir, 'models.json'));

  // ── providers.json ─────────────────────────────────────────────────────────
  const providerPresets = readJson<ProviderPreset[]>(path.join(dataDir, 'providers.json'));

  // ── onboarding.json ────────────────────────────────────────────────────────
  const onboarding = readJson<AppData['onboarding']>(path.join(dataDir, 'onboarding.json'));

  // ── agent-categories.json ──────────────────────────────────────────────────
  const agentCategories = readJson<string[]>(path.join(dataDir, 'agent-categories.json'));

  // ── tools.json ─────────────────────────────────────────────────────────────
  const toolsJson = readJson<{
    virtualTools:  MCPToolDefinition[];
    toolServerMap: Record<string, string>;
    approvalTools: string[];
  }>(path.join(dataDir, 'tools.json'));

  // ── file-scanner.json ──────────────────────────────────────────────────────
  const scannerJson = readJson<{
    includeExtensions:        string[];
    excludePatterns:          string[];
    sensitiveFilenamePatterns: PatternDef[];
  }>(path.join(dataDir, 'file-scanner.json'));

  // ── security.json ──────────────────────────────────────────────────────────
  const securityJson = readJson<{
    contextWindow:    { trimThreshold: number; keepTurns: number };
    secretPatterns:   PatternDef[];
    injectionPatterns: PatternDef[];
  }>(path.join(dataDir, 'security.json'));

  // ── artifact-commands.json ─────────────────────────────────────────────────
  const artifactCommands = readJson<ArtifactCommand[]>(path.join(dataDir, 'artifact-commands.json'));

  // ── execution-messages.json ───────────────────────────────────────────────
  const executionMessages = readJson<AppData['executionMessages']>(path.join(dataDir, 'execution-messages.json'));

  // ── architecture-patterns.json ────────────────────────────────────────────
  const architecturePatterns = readJson<AppData['architecturePatterns']>(path.join(dataDir, 'architecture-patterns.json'));

  // ── validator-rules.json ──────────────────────────────────────────────────
  const validatorRules = readJson<AppData['validatorRules']>(path.join(dataDir, 'validator-rules.json'));

  // ── prompts/ ───────────────────────────────────────────────────────────────
  const defaultSystemPrompt = readText(path.join(promptsDir, 'default-system-prompt.md'));

  const artifactPrompts: Record<string, string> = {};
  for (const cmd of artifactCommands) {
    const promptPath = path.join(promptsDir, 'artifacts', cmd.promptFile);
    artifactPrompts[cmd.id] = readText(promptPath);
  }

  return {
    providerModels:    modelsJson.providerModels,
    contextLimits:     modelsJson.contextLimits,
    pricing:           modelsJson.pricing,

    providerPresets,

    onboarding,

    agentCategories,

    virtualTools:  toolsJson.virtualTools,
    toolServerMap: toolsJson.toolServerMap,
    approvalTools: new Set(toolsJson.approvalTools),

    includeExtensions: new Set(scannerJson.includeExtensions),
    excludePatterns:   scannerJson.excludePatterns,
    sensitivePatterns: toRegexArray(scannerJson.sensitiveFilenamePatterns),

    contextWindow:     securityJson.contextWindow,
    secretPatterns:    toRegexArray(securityJson.secretPatterns),
    injectionPatterns: toRegexArray(securityJson.injectionPatterns),

    artifactCommands,
    executionMessages,
    architecturePatterns,
    validatorRules,

    defaultSystemPrompt,
    artifactPrompts,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function toRegexArray(defs: PatternDef[]): RegExp[] {
  return defs.map(d => new RegExp(d.pattern, d.flags));
}

/** Returns a zero-valued AppData for use as a merge base in tests. */
function emptyAppData(): AppData {
  return {
    providerModels:     {},
    contextLimits:      {},
    pricing:            {},
    providerPresets:    [],
    onboarding:         { roles: [], availableAgents: [] },
    agentCategories:    [],
    virtualTools:       [],
    toolServerMap:      {},
    approvalTools:      new Set(),
    includeExtensions:  new Set(),
    excludePatterns:    [],
    sensitivePatterns:  [],
    contextWindow:      { trimThreshold: 0.9, keepTurns: 10 },
    secretPatterns:     [],
    injectionPatterns:  [],
    artifactCommands:   [],
    architecturePatterns: {} as Record<string, unknown>,
    validatorRules: { rules: {} },
    executionMessages:  {
      toolBlocked: { bormagiPath: '', reread: '', budgetExhausted: '', offBatch: '' },
      toolSummary: { format: '', formatNoPath: '' },
      continueResume: {},
      stateContextNote: {},
      validatorIssues: {},
    },
    defaultSystemPrompt: '',
    artifactPrompts:    {},
  };
}
