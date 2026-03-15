# Bormagi Coding Assistant: Implementation Document

## Document Purpose

This document contains the complete code changes required to fix the infinite read loop, token waste, and context loss issues identified in the advanced-coder session log. Each section specifies the file path, the exact code to add or modify, and the rationale.

The changes are organized by implementation priority. P0 changes fix the immediate failure. P1 changes prevent recurrence. P2 and P3 changes improve the architecture.

---

## 1. New File: `src/context/types.ts` — Add `resolvedInputs` Slot

**Priority:** P0 (ACTION 2)

Find the `ContextEnvelope` interface and add the `resolvedInputs` field.

### Current Code

```typescript
export interface ContextEnvelope {
  editable: ContextCandidate[];
  reference: ContextCandidate[];
  memory: ContextCandidate[];
  toolOutputs: ContextCandidate[];
}
```

### New Code

```typescript
export interface ContextEnvelope {
  editable: ContextCandidate[];
  reference: ContextCandidate[];
  memory: ContextCandidate[];
  toolOutputs: ContextCandidate[];
  /**
   * Files read by the agent whose content must survive budget trimming.
   * The budget engine counts these tokens toward the total but never prunes them.
   * If the budget still overflows after all other remediations, these are
   * compressed to 500-char digests rather than dropped.
   */
  resolvedInputs: ContextCandidate[];
}
```

---

## 2. Modified File: `src/context/BudgetEngine.ts` — Fix Wrong-Slot Trimming and Protect resolvedInputs

**Priority:** P0 (ACTIONS 2, 3)

### 2a. Fix `reduceConversationTail()` — Target `toolOutputs` Instead of `editable`

Find the `reduceConversationTail` function (approximately line 155).

#### Current Code

```typescript
function reduceConversationTail(envelope: ContextEnvelope, budget: ModeBudget): ContextEnvelope {
  const TARGET = budget.conversationTail;
  let remaining = TARGET;
  const kept: ContextCandidate[] = [];

  // Iterate newest-first, accumulate until we hit the target.
  for (const c of [...envelope.editable].reverse()) {
    if (remaining <= 0) { break; }
    kept.unshift(c);
    remaining -= c.tokenEstimate;
  }

  return { ...envelope, editable: kept };
}
```

#### New Code

```typescript
/**
 * Keep only the most recent tool-output candidates up to the budget slot limit.
 * Targets toolOutputs (accumulated results from prior turns), NOT editable files.
 *
 * BUG FIX: Previously targeted envelope.editable which holds files the model
 * can modify. This caused file context to be trimmed instead of old tool results,
 * leading to plan hallucination from filename heuristics.
 */
function reduceConversationTail(envelope: ContextEnvelope, budget: ModeBudget): ContextEnvelope {
  const TARGET = budget.conversationTail;
  let remaining = TARGET;
  const kept: ContextCandidate[] = [];

  // Iterate newest-first through tool outputs, accumulate until target.
  for (const c of [...envelope.toolOutputs].reverse()) {
    if (remaining <= 0) { break; }
    kept.unshift(c);
    remaining -= c.tokenEstimate;
  }

  return { ...envelope, toolOutputs: kept };
}
```

### 2b. Update `cloneEnvelope()` to Include `resolvedInputs`

#### Current Code

```typescript
function cloneEnvelope(envelope: ContextEnvelope): ContextEnvelope {
  return {
    editable: [...envelope.editable],
    reference: [...envelope.reference],
    memory: [...envelope.memory],
    toolOutputs: [...envelope.toolOutputs],
  };
}
```

#### New Code

```typescript
function cloneEnvelope(envelope: ContextEnvelope): ContextEnvelope {
  return {
    editable: [...envelope.editable],
    reference: [...envelope.reference],
    memory: [...envelope.memory],
    toolOutputs: [...envelope.toolOutputs],
    resolvedInputs: [...(envelope.resolvedInputs ?? [])],
  };
}
```

### 2c. Update `estimateEnvelopeTokens()` to Count `resolvedInputs`

#### Current Code

```typescript
export function estimateEnvelopeTokens(
  envelope: ContextEnvelope,
  budget: ModeBudget,
  profile: ModelProfile,
): number {
  const envelopeTokens =
    sumCandidates(envelope.editable) +
    sumCandidates(envelope.reference) +
    sumCandidates(envelope.memory) +
    sumCandidates(envelope.toolOutputs);

  return (
    budget.stablePrefix +
    budget.userInput +
    profile.estimatedToolOverheadTokens +
    envelopeTokens
  );
}
```

#### New Code

```typescript
export function estimateEnvelopeTokens(
  envelope: ContextEnvelope,
  budget: ModeBudget,
  profile: ModelProfile,
): number {
  const envelopeTokens =
    sumCandidates(envelope.editable) +
    sumCandidates(envelope.reference) +
    sumCandidates(envelope.memory) +
    sumCandidates(envelope.toolOutputs) +
    sumCandidates(envelope.resolvedInputs ?? []);

  return (
    budget.stablePrefix +
    budget.userInput +
    profile.estimatedToolOverheadTokens +
    envelopeTokens
  );
}
```

### 2d. Update `degradeToPlanOnly()` to Preserve `resolvedInputs`

#### Current Code

```typescript
function degradeToPlanOnly(envelope: ContextEnvelope): ContextEnvelope {
  return {
    editable: [],
    reference: [],
    memory: envelope.memory,
    toolOutputs: [],
  };
}
```

#### New Code

```typescript
function degradeToPlanOnly(envelope: ContextEnvelope): ContextEnvelope {
  return {
    editable: [],
    reference: [],
    memory: envelope.memory,
    toolOutputs: [],
    resolvedInputs: (envelope.resolvedInputs ?? []).map(c => {
      // Compress to 500-char digest if over budget
      if (c.tokenEstimate > 200) {
        const digest = c.content.slice(0, 500) + '\n[compressed for budget]';
        return { ...c, content: digest, tokenEstimate: estimateTokens(digest) };
      }
      return c;
    }),
  };
}
```

### 2e. Update `buildContextEnvelope()` in `src/context/ContextEnvelope.ts`

Find the function that builds the envelope and add the `resolvedInputs` field:

```typescript
// In buildContextEnvelope():
return {
  editable: editableCandidates,
  reference: referenceCandidates,
  memory: memoryCandidates,
  toolOutputs: toolOutputCandidates,
  resolvedInputs: [],  // populated by AgentRunner after read_file results
};
```

---

## 3. Modified File: `src/agents/execution/ToolDispatcher.ts` — Return Cached Content on Blocked Re-reads

**Priority:** P0 (ACTION 1)

The ToolDispatcher is used in AgentRunner via `this.toolDispatcher.dispatch()`. Based on the imports and usage, it has a `readCache` Map and methods `cacheReadResult()`, `seedReadCache()`, `lockDiscovery()`, and `resetGuardState()`.

### Locate the Re-read Blocking Logic

Find the section in `dispatch()` where it checks whether a file has already been read and returns a `LOOP_DETECTED` or `ALREADY_READ_UNCHANGED` rejection.

### Current Pattern (inferred from log output)

```typescript
// Pseudocode of current behavior:
if (this.isAlreadyRead(normalizedPath) && !this.isWrittenSinceRead(normalizedPath)) {
  return {
    text: `[LOOP DETECTED] "${toolName}" on "${path}" has been called ${count} times with no writes. Stop reading and write a file now.`,
    status: 'blocked',
    reasonCode: 'ALREADY_READ_UNCHANGED',
    toolName,
    path,
  };
}
```

### New Code

```typescript
/**
 * When blocking a re-read, return the cached file content instead of an
 * empty error message. This is the single highest-impact fix: it converts
 * every blocked read from "zero information" to "full information", allowing
 * the model to proceed with the content it needs.
 *
 * If no cached content exists (edge case), fall back to the original
 * rejection message.
 */
if (this.isAlreadyRead(normalizedPath) && !this.isWrittenSinceRead(normalizedPath)) {
  const cachedContent = this.readCache.get(normalizedPath);

  if (cachedContent) {
    return {
      text: `[FROM CACHE — already read, content below. Do not call read_file again.]\n${cachedContent}`,
      status: 'cached',
      reasonCode: 'ALREADY_READ_UNCHANGED',
      toolName,
      path,
    };
  }

  // No cached content available — use the original rejection
  return {
    text: `[ALREADY READ] "${path}" was read earlier this session. Content is not cached. Write a file now — do not re-read.`,
    status: 'blocked',
    reasonCode: 'ALREADY_READ_UNCHANGED',
    toolName,
    path,
  };
}
```

### Also Ensure `cacheReadResult()` Stores Full Content

Verify the method exists and stores the full string:

```typescript
cacheReadResult(filePath: string, content: string): void {
  const normalized = this.normalizePath(filePath);
  this.readCache.set(normalized, content);
}
```

---

## 4. Modified File: `src/agents/ExecutionStateManager.ts` — Readiness Gate, Structured Summaries, Imperative Context Note

**Priority:** P0/P1 (ACTIONS 5, 11, 13, 21)

### 4a. Add `checkReadiness()` Method

Add after the `canReadFile()` method:

```typescript
/**
 * Verify that the agent has sufficient context to begin writing.
 * Called by AgentRunner before the first write attempt in code mode.
 *
 * Returns { ready: true } when all preconditions are met.
 * Returns { ready: false, missing: [...] } listing what needs to be loaded.
 */
checkReadiness(state: ExecutionStateData): { ready: boolean; missing: string[] } {
  const missing: string[] = [];

  // Must have at least one resolved input with substantive content
  const hasContent = (state.resolvedInputSummaries ?? []).some(
    s => s.summary.length > 100
  );
  if (!hasContent && state.resolvedInputs.length === 0) {
    missing.push('No input files read with content');
  }

  // In code mode with an approved plan, the plan must be loaded
  if (state.mode === 'code' && state.approvedPlanPath) {
    if (!state.resolvedInputs.includes(state.approvedPlanPath)) {
      missing.push(`Plan not loaded: ${state.approvedPlanPath}`);
    }
  }

  // Objective must be substantive (not just a filename derivative)
  if ((state.primaryObjective ?? state.objective).length < 20) {
    missing.push('Objective too vague — may be derived from filename only');
  }

  return { ready: missing.length === 0, missing };
}
```

### 4b. Add `extractStructuredSummary()` and Update `markFileRead()`

Replace the existing `markFileRead()` method:

#### Current Code

```typescript
markFileRead(state: ExecutionStateData, filePath: string): void {
  if (!state.resolvedInputs.includes(filePath)) {
    state.resolvedInputs.push(filePath);
    state.updatedAt = new Date().toISOString();
  }
}
```

#### New Code

```typescript
/**
 * Record a file that was read. Optionally extract structured facts from the
 * content and store in resolvedInputSummaries for budget-immune reuse.
 *
 * @param filePath  Normalized workspace-relative path.
 * @param content   Full file content (optional). When provided, structured
 *                  facts are extracted and stored for reuse across turns.
 */
markFileRead(state: ExecutionStateData, filePath: string, content?: string): void {
  if (!state.resolvedInputs.includes(filePath)) {
    state.resolvedInputs.push(filePath);
  }

  if (content) {
    const summary = this.extractStructuredSummary(content, filePath);
    this.upsertResolvedInputSummary(state, {
      path: filePath,
      hash: this.hashContent(content),
      summary,
      kind: this.classifyFileKind(filePath),
      lastReadAt: new Date().toISOString(),
    });
  }

  state.updatedAt = new Date().toISOString();
}

/**
 * Extract structured facts from file content for compact, budget-immune
 * storage. Produces a ~300-500 char summary that captures the essential
 * information the model needs to write correct code.
 */
private extractStructuredSummary(content: string, filePath: string): string {
  const lines = content.split('\n');
  const facts: string[] = [];

  // 1. Title / purpose — first markdown heading or first 200 chars
  const titleLine = lines.find(l => l.startsWith('#'));
  if (titleLine) {
    facts.push(`Title: ${titleLine.replace(/^#+\s*/, '').trim()}`);
  } else {
    facts.push(`Content: ${content.slice(0, 200).replace(/\n/g, ' ').trim()}`);
  }

  // 2. Technology stack mentions
  const techPattern = /\b(React|Python|FastAPI|Express|Django|Flask|Node\.?js|Vue|Angular|TypeScript|JavaScript|PostgreSQL|MongoDB|MySQL|SQLite|Docker|Kubernetes|Redis|GraphQL|REST|gRPC|Jinja2?|pdfplumber|pypdf|Uvicorn|Axios|Tailwind|Next\.?js)\b/gi;
  const techs = [...new Set((content.match(techPattern) ?? []).map(t => t.toLowerCase()))];
  if (techs.length > 0) {
    facts.push(`Tech stack: ${techs.join(', ')}`);
  }

  // 3. Directory structure if present (code blocks with path-like content)
  const dirBlock = content.match(/```(?:text)?\s*\n((?:[\s/].*\n){2,})\s*```/);
  if (dirBlock) {
    facts.push(`Directory structure:\n${dirBlock[1].trim().slice(0, 400)}`);
  }

  // 4. Numbered requirements or objectives (first 6)
  const numbered = lines
    .filter(l => /^\s*\d+\.\s/.test(l))
    .slice(0, 6)
    .map(l => l.trim());
  if (numbered.length > 0) {
    facts.push(`Key requirements:\n${numbered.join('\n')}`);
  }

  // 5. API endpoints if present
  const endpoints = lines
    .filter(l => /\b(GET|POST|PUT|DELETE|PATCH)\s+\//.test(l))
    .slice(0, 5)
    .map(l => l.trim());
  if (endpoints.length > 0) {
    facts.push(`Endpoints:\n${endpoints.join('\n')}`);
  }

  return facts.join('\n');
}

/**
 * Classify a file as requirements, plan, source, config, or other
 * based on its path.
 */
private classifyFileKind(
  filePath: string
): 'requirements' | 'plan' | 'source' | 'config' | 'other' {
  const lower = filePath.toLowerCase();
  if (lower.includes('requirement') || lower.includes('spec')) return 'requirements';
  if (lower.includes('plan') || lower.includes('design') || lower.includes('architecture'))
    return 'plan';
  if (lower.match(/\.(ts|js|py|java|go|rs|rb|cs|cpp|c|h)$/)) return 'source';
  if (
    lower.match(
      /\.(json|ya?ml|toml|ini|env|cfg|conf|dockerfile|docker-compose)$/
    ) ||
    lower.includes('config')
  )
    return 'config';
  return 'other';
}

/**
 * Simple content hash for change detection.
 */
private hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(content.length, 2000); i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(16);
}
```

### 4c. Rewrite `buildContextNote()` to Be Imperative with Content Digests

Replace the entire method:

```typescript
/**
 * Build an authoritative execution state note for injection into the prompt.
 *
 * This note uses imperative language and includes actual content digests
 * (not just filenames) so the model has the information it needs without
 * re-reading files. The note explicitly prohibits re-reads when content
 * has already been resolved.
 */
buildContextNote(state: ExecutionStateData): string {
  const displayObjective = state.primaryObjective ?? state.objective;
  const lines: string[] = [
    '[AUTHORITATIVE EXECUTION STATE — DO NOT OVERRIDE]',
    `Objective: ${displayObjective.slice(0, 300)}`,
    `Mode: ${state.mode} | Iterations: ${state.iterationsUsed}`,
  ];

  if (state.resumeNote) {
    lines.push(`Resume note: ${state.resumeNote}`);
  }

  if (state.techStack && Object.keys(state.techStack).length > 0) {
    lines.push(
      `Committed tech stack: ${JSON.stringify(state.techStack)}. Do NOT use other frameworks.`
    );
  }

  // Resolved inputs with content digests — not just filenames
  const summaries = state.resolvedInputSummaries ?? [];
  if (summaries.length > 0) {
    lines.push('RESOLVED INPUTS (content already available — DO NOT call read_file on these):');
    for (const ris of summaries) {
      // Include the actual summary so the model has the facts
      const digestLines = ris.summary.split('\n').map(l => `    ${l}`).join('\n');
      lines.push(`  ${ris.path} [${ris.kind}]:\n${digestLines}`);
    }
  } else if (state.resolvedInputs.length > 0) {
    // Fallback: just paths (no content captured)
    lines.push(
      `Files already read (DO NOT re-read): ${state.resolvedInputs.join(', ')}`
    );
  }

  if (state.artifactsCreated.length > 0) {
    lines.push(
      `Files already written (use edit_file to modify):\n${state.artifactsCreated.map(f => `  - ${f}`).join('\n')}`
    );
  }

  if (state.completedSteps.length > 0) {
    const recent = state.completedSteps.slice(-5);
    lines.push(`Completed: ${recent.join('; ')}`);
  }

  // Batch progress
  const planned = state.plannedFileBatch ?? [];
  if (planned.length > 0) {
    const completed = state.completedBatchFiles ?? [];
    const remaining = planned.filter(f => !completed.includes(f));
    if (remaining.length > 0) {
      lines.push(
        `Batch: ${completed.length}/${planned.length} done. Remaining: ${remaining.slice(0, 4).join(', ')}${remaining.length > 4 ? ` +${remaining.length - 4} more` : ''}`
      );
    } else {
      lines.push(`Batch: all ${planned.length} files written.`);
    }
  }

  // Next action — imperative
  if (state.nextActions.length > 0) {
    lines.push(`NEXT REQUIRED ACTION: ${state.nextActions[0]}`);
    if (state.nextToolCall) {
      lines.push(
        `NEXT TOOL: ${state.nextToolCall.tool}(${JSON.stringify(state.nextToolCall.input).slice(0, 120)})`
      );
    }
    lines.push('Call write_file or edit_file NOW. Do NOT call read_file or list_files.');
  }

  return lines.join('\n');
}
```

---

## 5. Modified File: `src/agents/AgentRunner.ts` — Core Loop Fixes

**Priority:** P0 (ACTIONS 4, 5), P1 (ACTIONS 6, 11, 15), P2 (ACTIONS 8, 12)

This file has the most changes. They are listed in order of where they appear in the `run()` method.

### 5a. Pre-load Plan and Requirements at Code-Mode Session Start (ACTION 5)

**Location:** After the `buildExecutionHistory()` call and before the `while(continueLoop)` loop. Find the line:

```typescript
messages.push({ role: 'system', content: this.buildWorkspaceTypeNote(detectedWorkspaceType) });
```

**Add immediately after it:**

```typescript
// ─── ACTION 5: Pre-load resolved inputs into code-mode context ────────────
// Load plan and requirements content from disk so the model has the
// information it needs without calling read_file. This prevents the
// read-loop that consumed 175 iterations in the original failure.
if (mode === 'code') {
  // 5a. Load approved plan content
  if (execState.approvedPlanPath) {
    try {
      const planContent = await fs.readFile(
        path.join(this.workspaceRoot, execState.approvedPlanPath),
        'utf8'
      );
      const capped =
        planContent.length > 8000
          ? planContent.slice(0, 8000) + '\n[plan content truncated for context budget]'
          : planContent;
      messages.push({
        role: 'system',
        content: `[APPROVED PLAN — authoritative reference. Do NOT re-read this file.]\n${capped}`,
      });
      stateManager.markFileRead(execState, execState.approvedPlanPath, planContent);
      this.toolDispatcher.cacheReadResult(execState.approvedPlanPath, planContent);
    } catch {
      /* plan file missing — proceed without */
    }
  }

  // 5b. Load all previously-resolved inputs that have structured summaries
  for (const ris of execState.resolvedInputSummaries ?? []) {
    if (ris.summary.length > 50) {
      messages.push({
        role: 'system',
        content: `[Resolved: ${ris.path} — ${ris.kind}]\n${ris.summary}`,
      });
    }
  }

  // 5c. Readiness check — force-load missing files from disk
  const readiness = stateManager.checkReadiness(execState);
  if (!readiness.ready) {
    onThought?.({
      type: 'thinking',
      label: `[Readiness] Missing: ${readiness.missing.join('; ')}`,
      timestamp: new Date(),
    });

    // Attempt to load requirements.md or similar if it exists and was not read
    for (const note of readiness.missing) {
      const pathMatch = note.match(/not loaded: (.+)/);
      if (pathMatch) {
        try {
          const content = await fs.readFile(
            path.join(this.workspaceRoot, pathMatch[1]),
            'utf8'
          );
          const capped =
            content.length > 8000
              ? content.slice(0, 8000) + '\n[truncated]'
              : content;
          messages.push({
            role: 'system',
            content: `[Auto-loaded: ${pathMatch[1]}]\n${capped}`,
          });
          stateManager.markFileRead(execState, pathMatch[1], content);
          this.toolDispatcher.cacheReadResult(pathMatch[1], content);
        } catch {
          /* file missing */
        }
      }
    }
  }
}
```

### 5b. Deterministic Discovery-to-Write Transition (ACTION 4)

**Location:** Inside the `while(continueLoop)` loop, find the existing discovery budget enforcement block. It currently looks like:

```typescript
if (consecutiveReadCount >= 3 && writtenPaths.size === 0) {
  toolResultContent = `[DISCOVERY BUDGET EXCEEDED] ${consecutiveReadCount} consecutive reads with no writes...`;
  stateManager.setExecutionPhase(execState, 'EXECUTING_STEP');
  this.toolDispatcher.lockDiscovery();
  silentExecution = true;
}
```

**Replace with:**

```typescript
if (consecutiveReadCount >= 3 && writtenPaths.size === 0) {
  // ─── ACTION 4: Hard transition — no more LLM calls for reads ────────────
  // The advisory warning was ignored 175 times in the original failure.
  // Now we skip the LLM call entirely and dispatch deterministically.
  this.toolDispatcher.lockDiscovery();
  stateManager.setExecutionPhase(execState, 'EXECUTING_STEP');

  const deterministicStep = stateManager.computeDeterministicNextStep(
    execState,
    detectedWsType
  );

  if (deterministicStep?.nextToolCall && !VIRTUAL_TOOLS.has(deterministicStep.nextToolCall.tool)) {
    contextCostTracker.recordSkippedLLMCall();
    onThought?.({
      type: 'thinking',
      label: `[Discovery exhausted] Direct dispatch: ${deterministicStep.nextToolCall.tool}`,
      timestamp: new Date(),
    });

    const directResult = await this.toolDispatcher.dispatch(
      {
        id: `discovery-forced-${Date.now()}`,
        name: deterministicStep.nextToolCall.tool,
        input: deterministicStep.nextToolCall.input as Record<string, unknown>,
      },
      agentId,
      onApproval,
      onDiff,
      onThought
    );

    stateManager.markToolExecuted(
      execState,
      deterministicStep.nextToolCall.tool,
      (deterministicStep.nextToolCall.input as Record<string, unknown>).path as string | undefined,
      directResult.text.slice(0, 150)
    );
    stateManager.clearNextToolCall(execState);
    stateManager.save(agentId, execState).catch(() => {});

    const truncDirect =
      directResult.text.length > 8000
        ? directResult.text.slice(0, 8000) + '\n[truncated]'
        : directResult.text;
    const directMsg: ChatMessage = {
      role: 'tool_result',
      content: `<tool_result name="${deterministicStep.nextToolCall.tool}">\n${truncDirect}\n</tool_result>`,
    };
    messages.push(directMsg);
    currentStepToolResults.push(directMsg);

    if (
      deterministicStep.nextToolCall.tool === 'write_file' &&
      directResult.status === 'success'
    ) {
      const wPath = (deterministicStep.nextToolCall.input as Record<string, unknown>)
        .path as string | undefined;
      if (wPath) {
        writtenPaths.add(wPath);
        stateManager.markFileWritten(execState, this.normalizeWorkspacePath(wPath));
        stateManager.markProgress(execState);
        this.recordArtifact(agentId, wPath).catch(() => {});
      }
    }

    calledATool = true;
    continueLoop = true;
    consecutiveReadCount = 0;
    iterationCount++;
    continue; // SKIP provider.stream() — this is the critical line
  } else {
    // No deterministic step possible, no writes done = terminal state
    stateManager.setRunPhase(execState, 'BLOCKED_BY_VALIDATION');
    stateManager.save(agentId, execState).catch(() => {});
    onText(
      '\n\nBlocked: discovery budget exhausted with no deterministic next step available. ' +
        'The agent could not determine what to write. Review the plan or provide more specific instructions.'
    );
    continueLoop = false;
    break;
  }
}
```

### 5c. Pass Content to `markFileRead()` for Structured Summary Extraction (ACTION 13)

**Location:** Inside the tool dispatch success handler for `read_file`. Find:

```typescript
if (event.name === 'read_file' && toolCallPath) {
  stateManager.markFileRead(execState, this.normalizeWorkspacePath(toolCallPath));
```

**Change to:**

```typescript
if (event.name === 'read_file' && toolCallPath) {
  // ACTION 13: Pass content so structured facts can be extracted
  stateManager.markFileRead(
    execState,
    this.normalizeWorkspacePath(toolCallPath),
    toolResult.text  // NEW: pass content for structured summary extraction
  );
```

### 5d. Tiered Tool Result Truncation (ACTION 8)

**Location:** Find the constant and truncation logic:

```typescript
const MAX_TOOL_RESULT_CHARS = 8000;
const truncatedResult = resultStr.length > MAX_TOOL_RESULT_CHARS
  ? resultStr.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[... result truncated ...]`
  : resultStr;
```

**Replace with:**

```typescript
// ACTION 8: Tiered truncation — full on first read, digest on subsequent
const truncatedResult = this.truncateToolResult(
  resultStr,
  event.name,
  iterationCount,
  toolCallPath
);
```

**Add as a private method on AgentRunner:**

```typescript
/**
 * Tiered tool result truncation.
 * - First 2 iterations: allow full content (up to 8K) for orientation.
 * - Later iterations: read_file results get a head+tail digest because
 *   the full content should be in resolvedInputs (ACTION 2).
 * - Non-read tools: always cap at 4K.
 */
private truncateToolResult(
  content: string,
  toolName: string,
  iterationCount: number,
  toolPath?: string,
): string {
  // Non-read tools: 4K cap
  if (!['read_file', 'search_files', 'grep_content'].includes(toolName)) {
    return content.length > 4000
      ? content.slice(0, 4000) + '\n[truncated]'
      : content;
  }

  // First 2 iterations: allow full content (up to 8K) for initial orientation
  if (iterationCount <= 2) {
    return content.length > 8000
      ? content.slice(0, 8000) + '\n[truncated — full content stored in resolved inputs]'
      : content;
  }

  // Later iterations: digest only (full content is in resolvedInputs)
  if (content.length > 2000) {
    return (
      content.slice(0, 1000) +
      `\n\n[... ${content.length - 1500} chars omitted — full content in resolved inputs for ${toolPath ?? 'this file'} ...]\n\n` +
      content.slice(-500)
    );
  }

  return content;
}
```

### 5e. System Prompt Deduplication Across Iterations (ACTION 6)

**Location:** Inside the `while(continueLoop)` loop, find where `messagesForProvider` is built for code mode. The current code calls `promptAssembler.assembleMessages()` with `systemPrompt: fullSystem` every iteration.

**Add before the code-mode prompt assembly block:**

```typescript
// ACTION 6: Deduplicate system prompt across iterations.
// On iteration 0, send the full system prompt.
// On subsequent iterations, send only the volatile section (execution state
// + workspace summary). The stable section (role, principles, conventions)
// does not change between iterations.
let systemPromptForThisTurn: string;
if (iterationCount === 0) {
  systemPromptForThisTurn = fullSystem;
} else {
  // Extract only the volatile parts: execution state + workspace summary
  // The stable prefix (~3K tokens) is omitted — the model retains it from
  // the first call within this streaming session.
  const volatileSection = [
    stateManager.buildContextNote(execState),
    this.buildWorkspaceTypeNote(detectedWsType),
  ].join('\n\n');
  systemPromptForThisTurn = `[System instructions unchanged from initial call]\n\n${volatileSection}`;
}
```

Then update the `promptAssembler.assembleMessages()` call:

```typescript
messagesForProvider = promptAssembler.assembleMessages({
  systemPrompt: systemPromptForThisTurn,  // was: fullSystem
  executionStateSummary: compactSummary,
  // ... rest unchanged
});
```

### 5f. Force Tool-Call Mode After Discovery (ACTION 12)

**Location:** Find the `provider.stream()` call inside the loop:

```typescript
for await (const event of provider.stream(messagesForProvider, this.filterToolsByMode(tools, mode), actualMaxOutputTokens)) {
```

**Change to:**

```typescript
// ACTION 12: Force tool_choice after discovery phase to prevent narration-only turns.
// The model wasted ~1200 output tokens on narration in the original failure.
const shouldForceToolCall =
  mode === 'code' &&
  iterationCount > 0 &&
  writtenPaths.size === 0 &&
  consecutiveReadCount === 0; // only after discovery lock clears

const effectiveToolChoice = shouldForceToolCall
  ? { type: 'any' as const }
  : undefined;

for await (const event of provider.stream(
  messagesForProvider,
  this.filterToolsByMode(tools, mode),
  actualMaxOutputTokens,
  effectiveToolChoice
)) {
```

Note: This requires the provider `stream()` method to accept an optional `toolChoice` parameter. If it does not, add it:

```typescript
// In the provider interface (src/providers/types.ts or similar):
stream(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens: number,
  toolChoice?: { type: 'any' | 'auto' | 'none' },
): AsyncIterable<StreamEvent>;
```

### 5g. Token Efficiency Auto-Halt (ACTION 22)

**Location:** At the bottom of the `while(continueLoop)` loop, before the `iterationCount++` line, add:

```typescript
// ACTION 22: Auto-halt on sustained inefficiency.
// If the output/input ratio drops below 2% for 3 consecutive turns, the
// session is wasting tokens. Halt and report.
if (iterationCount >= 3) {
  const recentEntries = contextCostTracker.getRecentEntries(3);
  if (recentEntries.length >= 3) {
    const totalIn = recentEntries.reduce((sum, e) => sum + e.totalTokens, 0);
    const totalOut = recentEntries.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0);
    const efficiency = totalIn > 0 ? totalOut / totalIn : 0;

    if (efficiency < 0.02 && writtenPaths.size === 0) {
      onThought?.({
        type: 'error',
        label: `[Efficiency guard] ${(efficiency * 100).toFixed(1)}% over last 3 turns — halting`,
        timestamp: new Date(),
      });
      stateManager.setRunPhase(execState, 'BLOCKED_BY_VALIDATION');
      stateManager.save(agentId, execState).catch(() => {});
      onText(
        '\n\nSession halted: token efficiency below 2% for 3 consecutive turns with no files written. ' +
          'This indicates the agent is stuck. Review the execution state or provide more specific instructions.'
      );
      continueLoop = false;
    }
  }
}
```

### 5h. Plan Validation Before Approval (ACTION 14)

**Location:** Find the `resolveApprovedPlanPath()` method on AgentRunner.

**Add a validation step before calling `stateManager.markPlanApproved()`:**

```typescript
/**
 * Validate that a plan file's content aligns with the requirements.
 * Prevents hallucinated plans (e.g., a plan for "requirements management"
 * when the actual requirement is "PDF extraction tool") from being approved.
 *
 * Uses term overlap: if fewer than 30% of key terms from the requirements
 * appear in the plan, the plan is rejected.
 */
private async validatePlanAgainstRequirements(
  planPath: string,
  execState: ExecutionStateData
): Promise<boolean> {
  const reqSummary = (execState.resolvedInputSummaries ?? []).find(
    s => s.kind === 'requirements'
  );
  if (!reqSummary || reqSummary.summary.length < 50) {
    return true; // no requirements to compare against
  }

  try {
    const planContent = await fs.readFile(
      path.join(this.workspaceRoot, planPath),
      'utf8'
    );

    // Extract significant terms (4+ chars) from requirements summary
    const reqTerms = new Set(
      reqSummary.summary.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []
    );

    if (reqTerms.size < 3) return true; // too few terms to compare

    const planLower = planContent.toLowerCase();
    const matches = [...reqTerms].filter(t => planLower.includes(t));
    const overlapRatio = matches.length / reqTerms.size;

    if (overlapRatio < 0.3) {
      return false; // plan does not match requirements
    }

    return true;
  } catch {
    return true; // file not readable — approve by default
  }
}
```

Then in the plan approval block (around line where `markPlanApproved` is called):

```typescript
if (planPath) {
  const isValid = await this.validatePlanAgainstRequirements(planPath, execState);
  if (isValid) {
    stateManager.markPlanApproved(execState, planPath);
    stateManager.save(agentId, execState).catch(() => {});
  } else {
    onThought?.({
      type: 'error',
      label: `[Plan validation] Plan at ${planPath} does not match requirements — not approved`,
      timestamp: new Date(),
    });
    // Do not approve — the agent will need to re-plan
  }
}
```

---

## 6. New File: `src/agents/execution/AgentFSM.ts` — Finite State Machine

**Priority:** P2 (ACTION 10)

This replaces the 15+ boolean flags in the main loop with enforced state transitions.

```typescript
/**
 * Finite state machine for the agent execution loop.
 *
 * Enforces that the agent progresses through phases in a deterministic order.
 * The FSM guarantees:
 * - Discovery cannot exceed maxDiscoveryReads without transitioning
 * - Execution cannot start without passing the readiness gate
 * - The agent cannot loop in any phase indefinitely
 */

import type { ExecutionStateData } from '../ExecutionStateManager';

export type AgentPhase =
  | 'ORIENT'           // Load repo map, inject resolved inputs
  | 'DISCOVER'         // Read specific files (capped)
  | 'READINESS_CHECK'  // Verify all needed context is loaded
  | 'PLAN_BATCH'       // Declare file batch
  | 'EXECUTE'          // Write files
  | 'VALIDATE'         // Run lint/test after write
  | 'ADVANCE'          // Move to next batch file
  | 'COMPLETE'         // All work done
  | 'BLOCKED';         // Cannot proceed — needs human input

interface FSMTransition {
  from: AgentPhase;
  to: AgentPhase;
  guard: (state: ExecutionStateData, ctx: FSMContext) => boolean;
  onTransition?: (state: ExecutionStateData, ctx: FSMContext) => void;
}

export interface FSMContext {
  maxDiscoveryReads: number;
  discoveryReadsUsed: number;
  writesThisSession: number;
  batchRemaining: string[];
  readinessResult: { ready: boolean; missing: string[] };
}

const TRANSITIONS: FSMTransition[] = [
  // ORIENT -> DISCOVER: repo map loaded
  {
    from: 'ORIENT',
    to: 'DISCOVER',
    guard: (_s, _ctx) => true, // always transition after orient
  },

  // DISCOVER -> READINESS_CHECK: at least one file read
  {
    from: 'DISCOVER',
    to: 'READINESS_CHECK',
    guard: (s, _ctx) => s.resolvedInputs.length >= 1,
  },

  // DISCOVER -> BLOCKED: exceeded read cap with no progress
  {
    from: 'DISCOVER',
    to: 'BLOCKED',
    guard: (_s, ctx) => ctx.discoveryReadsUsed >= ctx.maxDiscoveryReads,
  },

  // READINESS_CHECK -> PLAN_BATCH: ready to write
  {
    from: 'READINESS_CHECK',
    to: 'PLAN_BATCH',
    guard: (_s, ctx) => ctx.readinessResult.ready,
  },

  // READINESS_CHECK -> DISCOVER: missing files (one more attempt)
  {
    from: 'READINESS_CHECK',
    to: 'DISCOVER',
    guard: (_s, ctx) =>
      !ctx.readinessResult.ready && ctx.discoveryReadsUsed < ctx.maxDiscoveryReads,
  },

  // READINESS_CHECK -> BLOCKED: not ready and out of reads
  {
    from: 'READINESS_CHECK',
    to: 'BLOCKED',
    guard: (_s, ctx) =>
      !ctx.readinessResult.ready && ctx.discoveryReadsUsed >= ctx.maxDiscoveryReads,
  },

  // PLAN_BATCH -> EXECUTE: batch declared (or not needed)
  {
    from: 'PLAN_BATCH',
    to: 'EXECUTE',
    guard: (_s, _ctx) => true,
  },

  // EXECUTE -> VALIDATE: file written
  {
    from: 'EXECUTE',
    to: 'VALIDATE',
    guard: (_s, ctx) => ctx.writesThisSession > 0,
  },

  // VALIDATE -> ADVANCE: validation passed (or not configured)
  {
    from: 'VALIDATE',
    to: 'ADVANCE',
    guard: (_s, _ctx) => true,
  },

  // ADVANCE -> EXECUTE: more batch files remaining
  {
    from: 'ADVANCE',
    to: 'EXECUTE',
    guard: (_s, ctx) => ctx.batchRemaining.length > 0,
  },

  // ADVANCE -> COMPLETE: all batch files done
  {
    from: 'ADVANCE',
    to: 'COMPLETE',
    guard: (_s, ctx) => ctx.batchRemaining.length === 0,
  },
];

export class AgentFSM {
  private _phase: AgentPhase = 'ORIENT';
  private readonly transitions: FSMTransition[];
  private readonly history: Array<{ from: AgentPhase; to: AgentPhase; ts: string }> = [];

  constructor() {
    this.transitions = TRANSITIONS;
  }

  get phase(): AgentPhase {
    return this._phase;
  }

  get phaseHistory(): Array<{ from: AgentPhase; to: AgentPhase; ts: string }> {
    return [...this.history];
  }

  /**
   * Attempt to transition to the next phase based on current state.
   * Returns the new phase, or the current phase if no transition is valid.
   */
  advance(state: ExecutionStateData, ctx: FSMContext): AgentPhase {
    for (const t of this.transitions) {
      if (t.from === this._phase && t.guard(state, ctx)) {
        this.history.push({
          from: this._phase,
          to: t.to,
          ts: new Date().toISOString(),
        });
        this._phase = t.to;
        t.onTransition?.(state, ctx);
        return this._phase;
      }
    }
    return this._phase;
  }

  /**
   * Check if the FSM is in a terminal state.
   */
  isTerminal(): boolean {
    return this._phase === 'COMPLETE' || this._phase === 'BLOCKED';
  }

  /**
   * Force a phase (for recovery scenarios).
   */
  forcePhase(phase: AgentPhase): void {
    this.history.push({
      from: this._phase,
      to: phase,
      ts: new Date().toISOString(),
    });
    this._phase = phase;
  }
}
```

---

## 7. New File: `src/agents/execution/ContextDeduplicator.ts` — Message Deduplication

**Priority:** P3 (ACTION 18)

```typescript
/**
 * Deduplicates repeated tool results in the message history.
 *
 * When the same file is read multiple times or the same error appears
 * repeatedly, the full content is replaced with a compact reference
 * to the first occurrence. This prevents the context window from being
 * dominated by duplicate content.
 *
 * Inspired by Cline's contextHistoryUpdates map.
 */

import type { ChatMessage } from '../../types';

export class ContextDeduplicator {
  private seen = new Map<string, { turnIndex: number; label: string }>();

  /**
   * Process messages and replace duplicate tool_result content with
   * compact references. Returns a new array — does not mutate input.
   */
  deduplicate(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((msg, idx) => {
      // Only deduplicate tool results
      if (msg.role !== 'tool_result') return msg;

      const hash = this.hashContent(msg.content);
      const existing = this.seen.get(hash);

      if (existing) {
        return {
          ...msg,
          content: `[Duplicate of turn #${existing.turnIndex}: ${existing.label}]`,
        };
      }

      // Extract a short label from the content
      const label = this.extractLabel(msg.content);
      this.seen.set(hash, { turnIndex: idx, label });
      return msg;
    });
  }

  /**
   * Reset for a new session.
   */
  reset(): void {
    this.seen.clear();
  }

  private hashContent(content: string): string {
    // Use first 500 chars for hash — enough to detect duplicates
    // without spending time hashing 15K-char file contents
    const sample = content.slice(0, 500);
    let hash = 0;
    for (let i = 0; i < sample.length; i++) {
      hash = ((hash << 5) - hash + sample.charCodeAt(i)) | 0;
    }
    return hash.toString(16);
  }

  private extractLabel(content: string): string {
    // Try to extract tool name and path from XML-formatted results
    const nameMatch = content.match(/name="([^"]+)"/);
    const pathMatch = content.match(/"path"\s*:\s*"([^"]+)"/);
    if (nameMatch && pathMatch) {
      return `${nameMatch[1]}:${pathMatch[1]}`;
    }
    if (nameMatch) {
      return nameMatch[1];
    }
    return content.slice(0, 60).replace(/\n/g, ' ');
  }
}
```

---

## 8. Enhanced File: `src/agents/AgentLogger.ts` — Structured Logging

**Priority:** P1 (ACTIONS 15, 16)

Add these methods to the AgentLogger class:

```typescript
/**
 * Log a structured per-turn summary as a single JSON line.
 * Called at the end of each iteration in the while(continueLoop) loop.
 */
logTurnSummary(entry: TurnSummary): void {
  const line = `┌─ TURN_SUMMARY\n${JSON.stringify(entry, null, 2)}\n└─\n`;
  this.appendToLog(line);
}

/**
 * Log a structured session summary as a single JSON line.
 * Called at session end.
 */
logSessionSummary(summary: SessionSummary): void {
  const line = `┌─ SESSION_SUMMARY\n${JSON.stringify(summary, null, 2)}\n└─\n`;
  this.appendToLog(line);
}
```

Add these interfaces (can go in the same file or in a types file):

```typescript
export interface TurnSummary {
  turn: number;
  phase: string;
  inputTokens: number;
  outputTokens: number;
  cacheHit: boolean;
  toolCalled?: string;
  toolPath?: string;
  toolStatus?: string;
  toolReasonCode?: string;
  writtenThisTurn: string[];
  cumulativeWrites: number;
  cumulativeReads: number;
  blockedReads: number;
  systemPromptTokens: number;
  contextPacketTokens: number;
  toolResultTokens: number;
  llmCallSkipped: boolean;
  deterministicDispatch: boolean;
}

export interface SessionSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTurns: number;
  uniqueFilesWritten: string[];
  uniqueFilesRead: string[];
  loopDetections: number;
  discoveryBudgetExceeded: number;
  recoveryAttempts: number;
  llmCallsSkipped: number;
  deterministicDispatches: number;
  durationMs: number;
  tokenEfficiency: number;
  fsmPhases: string[];
}
```

Then in `AgentRunner.ts`, at the bottom of each loop iteration (before `iterationCount++`), add:

```typescript
// ACTION 15: Structured turn logging
agentLog.logTurnSummary({
  turn: iterationCount,
  phase: stateManager.getExecutionPhase(execState),
  inputTokens: 0, // populated from token_usage event
  outputTokens: 0, // populated from token_usage event
  cacheHit: false,
  toolCalled: toolsUsed.length > 0 ? toolsUsed[toolsUsed.length - 1] : undefined,
  toolPath: undefined, // set from last tool event
  toolStatus: calledATool ? 'dispatched' : 'none',
  toolReasonCode: undefined,
  writtenThisTurn: [], // populated from write tracking
  cumulativeWrites: writtenPaths.size,
  cumulativeReads: execState.resolvedInputs.length,
  blockedReads: execState.blockedReadCount ?? 0,
  systemPromptTokens: estimateTokens(systemPromptForThisTurn ?? fullSystem),
  contextPacketTokens: 0,
  toolResultTokens: estimateTokens(currentStepToolResults.map(m => m.content).join('')),
  llmCallSkipped: false, // set true in deterministic dispatch paths
  deterministicDispatch: false, // set true when DD9/bypass dispatches
});
```

At session end (after the while loop):

```typescript
// ACTION 15: Session summary
const sessionEnd = Date.now();
agentLog.logSessionSummary({
  totalInputTokens: 0, // accumulated from token_usage events
  totalOutputTokens: 0,
  totalTurns: iterationCount,
  uniqueFilesWritten: Array.from(writtenPaths),
  uniqueFilesRead: execState.resolvedInputs,
  loopDetections: execState.blockedReadCount ?? 0,
  discoveryBudgetExceeded: 0, // track separately
  recoveryAttempts,
  llmCallsSkipped: contextCostTracker.getSkippedCount(),
  deterministicDispatches: 0,
  durationMs: sessionEnd - sessionStart,
  tokenEfficiency: 0, // compute from accumulated totals
  fsmPhases: [], // from AgentFSM.phaseHistory if using FSM
});
```

---

## 9. New File: `src/agents/execution/ModelBehavior.ts` — Model-Aware Configuration

**Priority:** P3 (ACTION 20)

```typescript
/**
 * Model-specific behavior profiles.
 *
 * Different models comply with instructions at different levels.
 * Gemini ignores "do not re-read" instructions more than Claude.
 * These profiles let the framework adjust its enforcement strategy.
 */

export interface ModelBehavior {
  /** How reliably does this model follow "do not re-read" instructions? */
  instructionCompliance: 'high' | 'medium' | 'low';
  /** Does the model support tool_choice: "any"? */
  supportsForceToolCall: boolean;
  /** Does the API support prompt caching? */
  supportsPromptCache: boolean;
  /** Max reads before forcing write (lower for less compliant models). */
  maxDiscoveryReads: number;
  /** Should narration be suppressed in silent mode? */
  suppressNarration: boolean;
}

const PROFILES: Record<string, ModelBehavior> = {
  // Anthropic models
  'claude-sonnet-4-6': {
    instructionCompliance: 'high',
    supportsForceToolCall: true,
    supportsPromptCache: true,
    maxDiscoveryReads: 3,
    suppressNarration: false,
  },
  'claude-opus-4-6': {
    instructionCompliance: 'high',
    supportsForceToolCall: true,
    supportsPromptCache: true,
    maxDiscoveryReads: 3,
    suppressNarration: false,
  },
  'claude-haiku-4-5': {
    instructionCompliance: 'medium',
    supportsForceToolCall: true,
    supportsPromptCache: true,
    maxDiscoveryReads: 2,
    suppressNarration: true,
  },

  // Google models
  'gemini-2.5-pro': {
    instructionCompliance: 'medium',
    supportsForceToolCall: false,
    supportsPromptCache: false,
    maxDiscoveryReads: 2,
    suppressNarration: true,
  },
  'gemini-2.5-flash': {
    instructionCompliance: 'low',
    supportsForceToolCall: false,
    supportsPromptCache: false,
    maxDiscoveryReads: 1,
    suppressNarration: true,
  },

  // OpenAI models
  'gpt-4o': {
    instructionCompliance: 'high',
    supportsForceToolCall: true,
    supportsPromptCache: false,
    maxDiscoveryReads: 3,
    suppressNarration: false,
  },
  'gpt-4o-mini': {
    instructionCompliance: 'medium',
    supportsForceToolCall: true,
    supportsPromptCache: false,
    maxDiscoveryReads: 2,
    suppressNarration: true,
  },

  // DeepSeek
  'deepseek-chat': {
    instructionCompliance: 'medium',
    supportsForceToolCall: false,
    supportsPromptCache: false,
    maxDiscoveryReads: 2,
    suppressNarration: true,
  },
};

/** Default profile for unknown models — conservative settings. */
const DEFAULT_PROFILE: ModelBehavior = {
  instructionCompliance: 'medium',
  supportsForceToolCall: false,
  supportsPromptCache: false,
  maxDiscoveryReads: 2,
  suppressNarration: true,
};

/**
 * Get the behavior profile for a model.
 * Falls back to a conservative default for unknown models.
 *
 * @param modelName  The model identifier (e.g., 'claude-sonnet-4-6').
 */
export function getModelBehavior(modelName: string): ModelBehavior {
  // Try exact match first
  if (PROFILES[modelName]) return PROFILES[modelName];

  // Try prefix match (e.g., "claude-sonnet-4-6-20250514" matches "claude-sonnet-4-6")
  for (const [key, profile] of Object.entries(PROFILES)) {
    if (modelName.startsWith(key)) return profile;
  }

  // Try family match
  if (modelName.includes('claude')) {
    return PROFILES['claude-sonnet-4-6']; // default Claude behavior
  }
  if (modelName.includes('gemini')) {
    return PROFILES['gemini-2.5-pro']; // default Gemini behavior
  }
  if (modelName.includes('gpt')) {
    return PROFILES['gpt-4o']; // default OpenAI behavior
  }

  return DEFAULT_PROFILE;
}
```

---

## 10. Modified File: `src/context/PromptAssembler.ts` — Add resolvedInputs Section

**Priority:** P1 (ACTION 2 continuation)

### Add a New Section Formatter

```typescript
function formatResolvedInputs(candidates: ContextCandidate[]): string {
  if (candidates.length === 0) { return ''; }
  const blocks = candidates.map((c) => {
    const pathStr = c.path ? ` — \`${c.path}\`` : '';
    // Use a shorter format than editable files — just the digest
    return `### Resolved Input${pathStr}\n${c.content.trim()}`;
  });
  return `${sectionHeader('Resolved Inputs (DO NOT re-read these files)')}${blocks.join('\n\n')}`;
}
```

### Add to `assemblePrompt()`

In the `assemblePrompt()` function, add between section 7 (Reference context) and section 8 (Tool outputs):

```typescript
  // 7.5. Resolved inputs (budget-immune file contents)
  parts.push(formatResolvedInputs(envelope.resolvedInputs ?? []));
```

---

## 11. Enhanced File: `src/agents/execution/ContextCostTracker.ts` — Per-Phase Breakdown

**Priority:** P1 (ACTION 16)

Add phase tracking to the existing class:

```typescript
interface CostEntry {
  turn: number;
  phase: string;           // NEW
  totalTokens: number;
  outputTokens: number;    // NEW
  systemPromptTokens: number;
  stateTokens: number;
  workspaceTokens: number;
  skillTokens: number;
  userTokens: number;
  toolResultTokens: number;
  resolvedSummariesReused: number;
  rawFileContentsInjected: number;
  llmCallSkipped: boolean; // NEW
}

interface PhaseCostSummary {
  phase: string;
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  llmCallsSkipped: number;
}

// Add to the class:

/**
 * Get cost breakdown grouped by FSM phase.
 */
getPhaseBreakdown(): PhaseCostSummary[] {
  const map = new Map<string, PhaseCostSummary>();

  for (const entry of this.entries) {
    const existing = map.get(entry.phase);
    if (existing) {
      existing.turns++;
      existing.totalInputTokens += entry.totalTokens;
      existing.totalOutputTokens += entry.outputTokens;
      if (entry.llmCallSkipped) existing.llmCallsSkipped++;
    } else {
      map.set(entry.phase, {
        phase: entry.phase,
        turns: 1,
        totalInputTokens: entry.totalTokens,
        totalOutputTokens: entry.outputTokens,
        llmCallsSkipped: entry.llmCallSkipped ? 1 : 0,
      });
    }
  }

  return Array.from(map.values());
}

/**
 * Get the last N entries for efficiency checks.
 */
getRecentEntries(n: number): CostEntry[] {
  return this.entries.slice(-n);
}

/**
 * Get total LLM calls skipped by deterministic dispatch.
 */
getSkippedCount(): number {
  return this.entries.filter(e => e.llmCallSkipped).length;
}

/**
 * Check if the agent is in an inefficient loop.
 * Returns true if the last `window` turns all have efficiency below `threshold`.
 */
isInefficient(window: number, threshold: number): boolean {
  const recent = this.getRecentEntries(window);
  if (recent.length < window) return false;

  return recent.every(entry => {
    const efficiency = entry.totalTokens > 0
      ? entry.outputTokens / entry.totalTokens
      : 0;
    return efficiency < threshold;
  });
}
```

---

## 12. Implementation Checklist

### P0 (Ship This Week)

- [ ] ACTION 1: `ToolDispatcher.ts` — Return cached content on blocked re-reads (Section 3)
- [ ] ACTION 3: `BudgetEngine.ts` — Fix `reduceConversationTail` wrong slot (Section 2a)
- [ ] ACTION 4: `AgentRunner.ts` — Deterministic discovery-to-write transition (Section 5b)
- [ ] ACTION 5: `AgentRunner.ts` — Pre-load plan content at session start (Section 5a)

### P1 (Next Sprint)

- [ ] ACTION 2: `types.ts` + `BudgetEngine.ts` + `ContextEnvelope.ts` + `PromptAssembler.ts` — Protected resolvedInputs slot (Sections 1, 2b-2e, 10)
- [ ] ACTION 6: `AgentRunner.ts` — System prompt deduplication (Section 5e)
- [ ] ACTION 11: `ExecutionStateManager.ts` — Readiness gate (Section 4a)
- [ ] ACTION 13: `ExecutionStateManager.ts` — Structured summary extraction (Section 4b)
- [ ] ACTION 15: `AgentLogger.ts` — Structured per-turn logging (Section 8)
- [ ] ACTION 21: `ExecutionStateManager.ts` — Imperative context note (Section 4c)

### P2 (Next Release)

- [ ] ACTION 7: Repo map for orientation (requires RepoMapStore integration changes)
- [ ] ACTION 8: `AgentRunner.ts` — Tiered truncation (Section 5d)
- [ ] ACTION 9: `ContextCompactor.ts` — Proactive compaction at 60%
- [ ] ACTION 10: New `AgentFSM.ts` (Section 6)
- [ ] ACTION 12: `AgentRunner.ts` — Tool-call-only mode (Section 5f)
- [ ] ACTION 14: `AgentRunner.ts` — Plan validation (Section 5h)

### P3 (Roadmap)

- [ ] ACTION 16: `ContextCostTracker.ts` — Phase breakdown (Section 11)
- [ ] ACTION 17: Diff edit tool (separate MCP tool implementation)
- [ ] ACTION 18: New `ContextDeduplicator.ts` (Section 7)
- [ ] ACTION 19: Sliding window with checkpoints
- [ ] ACTION 20: New `ModelBehavior.ts` (Section 9)
- [ ] ACTION 22: `AgentRunner.ts` — Efficiency auto-halt (Section 5g)

---

## 13. Testing Strategy

### Unit Tests

Each new method needs tests:

```typescript
// ExecutionStateManager.test.ts
describe('checkReadiness', () => {
  it('returns ready:false when no inputs are resolved', () => {
    const state = createFreshState('test', 'do something', 'code');
    const result = new ExecutionStateManager('/tmp').checkReadiness(state);
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('No input files read with content');
  });

  it('returns ready:true when inputs have content summaries', () => {
    const state = createFreshState('test', 'build a pdf tool', 'code');
    state.resolvedInputSummaries = [{
      path: 'requirements.md',
      hash: 'abc123',
      summary: 'Title: PDF Upload Tool\nTech stack: react, python, fastapi\n...',
      kind: 'requirements',
      lastReadAt: new Date().toISOString(),
    }];
    const result = new ExecutionStateManager('/tmp').checkReadiness(state);
    expect(result.ready).toBe(true);
  });
});

describe('extractStructuredSummary', () => {
  it('extracts tech stack from markdown content', () => {
    const content = '# PDF Tool\nBuild with React and FastAPI using pdfplumber.';
    const mgr = new ExecutionStateManager('/tmp') as any;
    const summary = mgr.extractStructuredSummary(content, 'requirements.md');
    expect(summary).toContain('react');
    expect(summary).toContain('fastapi');
    expect(summary).toContain('pdfplumber');
  });
});

// BudgetEngine.test.ts
describe('reduceConversationTail', () => {
  it('trims toolOutputs not editable files', () => {
    const envelope = {
      editable: [{ id: 'e1', content: 'file content', tokenEstimate: 500 }],
      reference: [],
      memory: [],
      toolOutputs: [
        { id: 't1', content: 'old result', tokenEstimate: 200 },
        { id: 't2', content: 'recent result', tokenEstimate: 200 },
      ],
      resolvedInputs: [],
    };
    const budget = { conversationTail: 250 };
    const result = reduceConversationTail(envelope, budget);
    // editable should be untouched
    expect(result.editable).toHaveLength(1);
    // toolOutputs should be trimmed to fit budget
    expect(result.toolOutputs.length).toBeLessThanOrEqual(2);
  });
});

// AgentFSM.test.ts
describe('AgentFSM', () => {
  it('transitions from DISCOVER to BLOCKED after max reads', () => {
    const fsm = new AgentFSM();
    fsm.forcePhase('DISCOVER');
    const state = createFreshState('test', 'task', 'code');
    const ctx = {
      maxDiscoveryReads: 3,
      discoveryReadsUsed: 3,
      writesThisSession: 0,
      batchRemaining: [],
      readinessResult: { ready: false, missing: ['No files'] },
    };
    const newPhase = fsm.advance(state, ctx);
    expect(newPhase).toBe('BLOCKED');
  });

  it('prevents EXECUTE without passing readiness', () => {
    const fsm = new AgentFSM();
    fsm.forcePhase('READINESS_CHECK');
    const state = createFreshState('test', 'task', 'code');
    const ctx = {
      maxDiscoveryReads: 3,
      discoveryReadsUsed: 1,
      writesThisSession: 0,
      batchRemaining: [],
      readinessResult: { ready: false, missing: ['Plan not loaded'] },
    };
    const newPhase = fsm.advance(state, ctx);
    // Should go back to DISCOVER, not forward to PLAN_BATCH
    expect(newPhase).toBe('DISCOVER');
  });
});
```

### Integration Test: No-Loop Guarantee

```typescript
describe('AgentRunner integration', () => {
  it('does not exceed 5 read_file calls before writing', async () => {
    // Set up a mock workspace with requirements.md
    // Run the agent
    // Assert: read_file called <= 5 times
    // Assert: write_file called >= 1 time
    // Assert: total iterations < 10
  });

  it('pre-loads plan content in code mode', async () => {
    // Set up workspace with .bormagi/plans/plan.md
    // Set execState.approvedPlanPath
    // Run the agent in code mode
    // Assert: plan content appears in first provider call messages
    // Assert: read_file is never called for the plan file
  });

  it('halts on sustained inefficiency', async () => {
    // Mock a provider that returns narration-only (no tool calls)
    // Run the agent
    // Assert: session ends within 6 iterations
    // Assert: runPhase is BLOCKED_BY_VALIDATION
  });
});
```

---

## 14. Migration Notes

### Backward Compatibility

All `ExecutionStateData` changes use optional fields with v2 defaults. Existing v1 and v2 state files load without errors. The `_migrate()` method in `ExecutionStateManager` handles missing fields:

```typescript
// Add to _migrate():
data.resolvedInputSummaries ??= [];
```

### `ContextEnvelope` Changes

The new `resolvedInputs` field is optional (initialized to `[]`). All existing code that creates envelopes continues to work because `resolvedInputs ?? []` is used everywhere.

### Provider Interface

ACTION 12 requires adding `toolChoice` to the provider `stream()` signature. This is an optional parameter with a default of `undefined` (no change to existing behavior). Providers that do not support `tool_choice` ignore the parameter.

---
