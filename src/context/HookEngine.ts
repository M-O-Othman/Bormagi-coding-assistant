// ─── Hook Engine ──────────────────────────────────────────────────────────────
//
// Runs deterministic lifecycle hooks at well-defined points in the context
// pipeline.  Hooks are config-driven (.bormagi/config/hooks.json) and support
// two execution models:
//
//   "internal"  — in-process handler identified by a `handler` string.
//                 Built-in internal handlers are registered below.
//   "shell"     — child_process.exec command, supports the {{changedFiles}}
//                 template variable.
//
// Supported hook events (FR-15A):
//   session-start       — fired once when a session begins
//   before-tool         — fired before any tool is called
//   after-tool          — fired after a tool call completes
//   after-edit          — fired after a file write/edit, filtered by glob
//   before-final        — fired before the final LLM response is sent
//   after-compaction    — fired after history compaction; result can inject context
//
// A hook may block the triggering action by returning `allow: false`.
// After-compaction hooks may return `contextToInject` to re-inject content
// into the prompt after the history has been compacted.
//
// Design decisions (from spec answers):
//   OQ-10: Config at .bormagi/config/hooks.json
//   OQ-11: Both in-process and shell hooks are supported
//
// Spec reference: §FR-15A + Phase 5, §5.2.

import * as fs   from 'fs';
import * as path from 'path';
import { exec }  from 'child_process';
import { promisify } from 'util';
import type { HookConfig, HookContext, HookEvent, HookResult } from './types';

const execAsync = promisify(exec);

// ─── Constants ────────────────────────────────────────────────────────────────

const HOOKS_CONFIG_RELATIVE = path.join('.bormagi', 'config', 'hooks.json');
const SHELL_HOOK_TIMEOUT_MS  = 10_000;

// ─── Default allow result ─────────────────────────────────────────────────────

const ALLOW: HookResult = { allow: true };
const DENY: HookResult  = { allow: false };

// ─── Built-in internal hook handlers ─────────────────────────────────────────

/**
 * Registry of built-in in-process hook handlers.
 * Each handler receives the hook context and the matching HookConfig, and must
 * return a HookResult synchronously or asynchronously.
 */
type InternalHandler = (
  ctx: HookConfig & { hookContext: HookContext },
) => HookResult | Promise<HookResult>;

/**
 * protected-path-check — blocks any file write that targets a path matching
 * one of the `match` patterns configured on the hook.
 *
 * Configuration example (in hooks.json):
 *   event: "before-tool", type: "internal", handler: "protected-path-check",
 *   tool: "writeFile", match: ["**\/secrets\/**", "**\/.env"]
 */
function protectedPathCheck(
  cfg: HookConfig & { hookContext: HookContext },
): HookResult {
  const { match, hookContext } = cfg;
  if (!match || match.length === 0) { return ALLOW; }

  const targetFile = (hookContext.payload?.['path'] as string | undefined) ?? '';
  if (!targetFile) { return ALLOW; }

  for (const pattern of match) {
    if (minimatch(targetFile, pattern)) {
      return {
        allow:    false,
        messages: [`Hook blocked write to protected path: ${targetFile}`],
      };
    }
  }
  return ALLOW;
}

/**
 * post-compaction-inject — after compaction, re-inserts a reminder message
 * so the model knows the session history has been compressed.
 */
function postCompactionInject(
  _cfg: HookConfig & { hookContext: HookContext },
): HookResult {
  return {
    allow:            true,
    contextToInject:  [
      '**Note:** The conversation history was automatically compacted. ' +
      'The summary above captures all decisions and pending steps.',
    ],
  };
}

const INTERNAL_HANDLERS: Record<string, InternalHandler> = {
  'protected-path-check': protectedPathCheck,
  'post-compaction-inject': postCompactionInject,
};

// ─── Minimal glob matcher ─────────────────────────────────────────────────────
//
// We intentionally avoid a third-party `minimatch` dependency.  This
// implementation covers the subset used by hook match patterns:
//   *          — any characters except path separator
//   **         — any characters including path separators
//   ?          — single character
//
// File paths are always normalised to forward-slash form before matching.

function minimatch(filePath: string, pattern: string): boolean {
  const normPath    = filePath.replace(/\\/g, '/');
  const normPattern = pattern.replace(/\\/g, '/');

  // Convert each glob token to a regex fragment.
  // Process character by character to handle **, *, ?, and literals.
  let regexStr = '^';
  let i = 0;
  while (i < normPattern.length) {
    if (normPattern[i] === '*' && normPattern[i + 1] === '*') {
      // '**' — matches any sequence of characters including '/'.
      // When preceded by '/' (or at start) and followed by '/', it can also
      // match zero path segments (e.g. '**/foo' matches 'foo').
      const preceded  = i === 0 || normPattern[i - 1] === '/';
      const followed  = normPattern[i + 2] === '/';
      if (preceded && followed) {
        // '**/': zero-or-more path segments.
        regexStr += '(.*\/)?';
        i += 3; // skip '**/'
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (normPattern[i] === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (normPattern[i] === '?') {
      regexStr += '[^/]';
      i++;
    } else {
      regexStr += normPattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  regexStr += '$';

  return new RegExp(regexStr).test(normPath);
}

// ─── Config loading ───────────────────────────────────────────────────────────

function loadHookConfigs(workspaceRoot: string): HookConfig[] {
  const configPath = path.join(workspaceRoot, HOOKS_CONFIG_RELATIVE);
  if (!fs.existsSync(configPath)) { return []; }
  try {
    const raw  = fs.readFileSync(configPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) { return []; }
    return data as HookConfig[];
  } catch {
    return [];
  }
}

// ─── Hook matching ────────────────────────────────────────────────────────────

function hooksForEvent(configs: HookConfig[], ctx: HookContext): HookConfig[] {
  return configs.filter(cfg => {
    if (cfg.event !== ctx.event) { return false; }

    // Tool name filter (before-tool / after-tool).
    if (cfg.tool && ctx.toolName && cfg.tool !== ctx.toolName) { return false; }

    // File glob filter (after-edit).
    if (ctx.event === 'after-edit' && cfg.match && cfg.match.length > 0) {
      const files = ctx.changedFiles ?? [];
      const anyMatch = files.some(f => cfg.match!.some(p => minimatch(f, p)));
      if (!anyMatch) { return false; }
    }

    return true;
  });
}

// ─── Shell hook execution ─────────────────────────────────────────────────────

async function runShellHook(cfg: HookConfig, ctx: HookContext): Promise<HookResult> {
  if (!cfg.command) {
    return { allow: true, messages: ['Shell hook has no command — skipped.'] };
  }

  const changedFilesStr = (ctx.changedFiles ?? []).join(' ');
  const command = cfg.command.replace('{{changedFiles}}', changedFilesStr);

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: SHELL_HOOK_TIMEOUT_MS,
    });
    const messages: string[] = [];
    if (stdout.trim()) { messages.push(stdout.trim()); }
    if (stderr.trim()) { messages.push(`[stderr] ${stderr.trim()}`); }
    return { allow: true, messages };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Shell hooks that exit non-zero block the action.
    return { allow: false, messages: [`Shell hook failed: ${msg}`] };
  }
}

// ─── Internal hook execution ──────────────────────────────────────────────────

async function runInternalHook(cfg: HookConfig, ctx: HookContext): Promise<HookResult> {
  if (!cfg.handler) {
    return { allow: true, messages: ['Internal hook has no handler — skipped.'] };
  }

  const handler = INTERNAL_HANDLERS[cfg.handler];
  if (!handler) {
    return {
      allow:    true,
      messages: [`Unknown internal hook handler: ${cfg.handler} — skipped.`],
    };
  }

  return handler({ ...cfg, hookContext: ctx });
}

// ─── Result merging ───────────────────────────────────────────────────────────

/**
 * Merge multiple HookResults into one.
 * A single `allow: false` result vetoes the entire batch.
 */
function mergeResults(results: HookResult[]): HookResult {
  const blocked = results.find(r => !r.allow);
  if (blocked) { return blocked; }

  return {
    allow:            true,
    messages:         results.flatMap(r => r.messages         ?? []),
    contextToInject:  results.flatMap(r => r.contextToInject  ?? []),
    commandsToRun:    results.flatMap(r => r.commandsToRun    ?? []),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class HookEngine {
  private configs: HookConfig[];

  /**
   * @param workspaceRoot  Absolute path to the workspace root used to locate
   *                       `.bormagi/config/hooks.json`.
   */
  constructor(private readonly workspaceRoot: string) {
    this.configs = loadHookConfigs(workspaceRoot);
  }

  /**
   * Reload hook configuration from disk.
   * Call this when the hooks.json file is known to have changed.
   */
  reload(): void {
    this.configs = loadHookConfigs(this.workspaceRoot);
  }

  /**
   * Register an in-process hook handler programmatically (useful for tests and
   * extension-provided hooks that do not need shell access).
   *
   * @param name     Unique handler identifier (used in `handler` field of config).
   * @param handler  The handler function.
   */
  static registerInternalHandler(name: string, handler: InternalHandler): void {
    INTERNAL_HANDLERS[name] = handler;
  }

  /**
   * Run all hooks registered for the given event.
   *
   * Hooks are executed sequentially in config order.  If any hook returns
   * `allow: false` execution halts immediately and the blocking result is
   * returned.
   *
   * @param event  The lifecycle event that fired.
   * @param ctx    Context for the hook (mode, changed files, tool name, etc.)
   * @returns      Merged `HookResult` from all matching hooks.
   */
  async runHooks(event: HookEvent, ctx: Omit<HookContext, 'event'>): Promise<HookResult> {
    const fullCtx: HookContext = { event, ...ctx };
    const matching = hooksForEvent(this.configs, fullCtx);

    if (matching.length === 0) { return ALLOW; }

    const results: HookResult[] = [];

    for (const cfg of matching) {
      const result = cfg.type === 'shell'
        ? await runShellHook(cfg, fullCtx)
        : await runInternalHook(cfg, fullCtx);

      results.push(result);

      // Short-circuit on first block.
      if (!result.allow) { return result; }
    }

    return mergeResults(results);
  }

  /**
   * Convenience method: fire the `session-start` event.
   */
  async onSessionStart(ctx: Omit<HookContext, 'event'>): Promise<HookResult> {
    return this.runHooks('session-start', ctx);
  }

  /**
   * Convenience method: fire the `before-tool` event.
   */
  async onBeforeTool(
    toolName: string,
    payload: Record<string, unknown>,
    ctx: Omit<HookContext, 'event' | 'toolName' | 'payload'>,
  ): Promise<HookResult> {
    return this.runHooks('before-tool', { ...ctx, toolName, payload });
  }

  /**
   * Convenience method: fire the `after-tool` event.
   */
  async onAfterTool(
    toolName: string,
    payload: Record<string, unknown>,
    ctx: Omit<HookContext, 'event' | 'toolName' | 'payload'>,
  ): Promise<HookResult> {
    return this.runHooks('after-tool', { ...ctx, toolName, payload });
  }

  /**
   * Convenience method: fire the `after-edit` event.
   */
  async onAfterEdit(
    changedFiles: string[],
    ctx: Omit<HookContext, 'event' | 'changedFiles'>,
  ): Promise<HookResult> {
    return this.runHooks('after-edit', { ...ctx, changedFiles });
  }

  /**
   * Convenience method: fire the `after-compaction` event.
   */
  async onAfterCompaction(ctx: Omit<HookContext, 'event'>): Promise<HookResult> {
    return this.runHooks('after-compaction', ctx);
  }

  /**
   * Returns the number of hook configs currently loaded.
   * Useful for telemetry and tests.
   */
  configCount(): number {
    return this.configs.length;
  }

  /**
   * Returns a copy of the loaded hook configs (read-only view).
   */
  getConfigs(): ReadonlyArray<HookConfig> {
    return [...this.configs];
  }
}
