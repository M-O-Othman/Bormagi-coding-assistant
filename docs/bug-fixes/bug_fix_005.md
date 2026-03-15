# Bormagi Coding Assistant: Detailed Fix Plan

## Problem Summary

The agent consumed 409,884 input tokens across 4 sessions, produced 8,017 output tokens (51:1 ratio), wrote 4 unique files (none of which were application source code), and triggered 175 loop detection events. The root cause is a control-plane failure where saved state is advisory rather than authoritative, causing each LLM turn to reconstruct context from scratch and loop on blocked reads.

---

## FIX 1: Eliminate System Prompt Resend on Every Iteration

**File:** `src/agents/AgentRunner.ts` (run method, ~line 700 onward in the while loop)

**Current behaviour:** The full system prompt (`fullSystem`, typically 3,000-5,000 tokens) is included in `messages[0]` and sent on every single LLM call. In code mode, `promptAssembler.assembleMessages()` rebuilds messages each iteration but still passes the full `systemPrompt` string. Over 20 iterations, this wastes 60,000-100,000 input tokens on identical content.

**Fix (two parts):**

**1a. Split the system prompt into stable and volatile sections.**

Create a new method in `PromptAssembler` (the execution-level one at `src/agents/execution/PromptAssembler.ts`):

```typescript
// New method on PromptAssembler class
splitSystemPrompt(fullSystem: string): { stable: string; volatile: string } {
  // The stable section is the agent identity, engineering principles,
  // naming standards, etc. These never change between iterations.
  // The volatile section is workspace notes, skills, capabilities.
  
  const splitMarker = '## Output Contract';
  const splitIdx = fullSystem.indexOf(splitMarker);
  if (splitIdx === -1) {
    return { stable: fullSystem, volatile: '' };
  }
  return {
    stable: fullSystem.slice(0, splitIdx).trim(),
    volatile: fullSystem.slice(splitIdx).trim(),
  };
}
```

**1b. In the iteration loop, send only the volatile section after the first call.**

In `AgentRunner.ts`, before the `while (continueLoop)` loop:

```typescript
const { stable: stableSystemPrompt, volatile: volatileSystemPrompt } = 
  promptAssembler.splitSystemPrompt(fullSystem);
let isFirstIteration = true;
```

Inside the code-mode branch of `assembleMessages`, change the `systemPrompt` argument:

```typescript
messagesForProvider = promptAssembler.assembleMessages({
  systemPrompt: isFirstIteration ? fullSystem : volatileSystemPrompt,
  // ... rest unchanged
});
isFirstIteration = false;
```

Add a compact identity reminder (under 100 tokens) to `volatileSystemPrompt` so the model retains role awareness:

```typescript
const identityReminder = `You are ${agentConfig.name} in ${mode} mode for project ${projectName}. Follow all prior engineering principles.`;
const compactSystem = `${identityReminder}\n\n${volatileSystemPrompt}`;
```

**Expected savings:** 2,500-4,500 tokens per iteration after the first. Over 20 iterations: 50,000-90,000 tokens saved.

---

## FIX 2: Inject File Contents Into Protected Context on Read

**Files:** `src/agents/AgentRunner.ts`, `src/agents/execution/ContextPacketBuilder.ts`, `src/agents/execution/PromptAssembler.ts`

**Current behaviour:** When `read_file` succeeds, the content goes into the conversation history as a `tool_result` message. On the next iteration in code mode, `promptAssembler.assembleMessages()` builds a fresh message array using `contextPacketBuilder.build()`, which only includes a 500-char summary from `resolvedInputSummaries`. The full file content is gone. The model then tries to re-read the file, gets blocked, and loops.

**Fix (three parts):**

**2a. Store full file content (up to a budget) in ExecutionStateData.**

Add a new field to `ExecutionStateData` in `src/agents/ExecutionStateManager.ts`:

```typescript
export interface ExecutionStateData {
  // ... existing fields ...
  
  /** 
   * Full content of critical input files, keyed by normalized path.
   * Budget-capped: only the first N chars per file, total capped at ~8000 tokens.
   * These are injected as authoritative context on every iteration.
   */
  resolvedInputContents?: Record<string, string>;
}
```

**2b. Populate `resolvedInputContents` on successful read.**

In `AgentRunner.ts`, inside the `if (event.name === 'read_file' && toolCallPath)` success block (around the `fileSummaryStore.put` call):

```typescript
// Store full content for critical files (requirements, plans, configs)
const MAX_STORED_CONTENT_CHARS = 6000;
const MAX_TOTAL_STORED_CHARS = 24000;
state.resolvedInputContents ??= {};

const currentTotal = Object.values(state.resolvedInputContents)
  .reduce((sum, c) => sum + c.length, 0);

if (currentTotal + Math.min(toolResult.text.length, MAX_STORED_CONTENT_CHARS) <= MAX_TOTAL_STORED_CHARS) {
  const normalizedPath = this.normalizeWorkspacePath(toolCallPath);
  state.resolvedInputContents[normalizedPath] = 
    toolResult.text.slice(0, MAX_STORED_CONTENT_CHARS);
}
```

**2c. Inject stored file contents into the prompt assembly.**

In `ContextPacketBuilder.build()`, add a new field to the returned context packet:

```typescript
build(execState, workspaceType, ...): ContextPacket & { resolvedFileContents: string } {
  // ... existing logic ...
  
  const fileContentBlocks: string[] = [];
  if (execState.resolvedInputContents) {
    for (const [filePath, content] of Object.entries(execState.resolvedInputContents)) {
      fileContentBlocks.push(
        `[File: ${filePath}]\n${content}`
      );
    }
  }
  
  return {
    ...existingPacket,
    resolvedFileContents: fileContentBlocks.join('\n\n---\n\n'),
  };
}
```

In `PromptAssembler.assembleMessages()`, insert the file contents as a system message after the execution state:

```typescript
if (contextPacket.resolvedFileContents) {
  messages.push({
    role: 'system',
    content: `[Resolved Input Files — authoritative content, do not re-read]\n${contextPacket.resolvedFileContents}`
  });
}
```

**This is the single most important fix.** It directly addresses the root cause: the model has the file contents on iteration 1 but loses them by iteration 3.

---

## FIX 3: Replace Advisory Loop Guards with Deterministic State Machine

**File:** `src/agents/AgentRunner.ts` (tool dispatch section in the while loop)

**Current behaviour:** When the loop detector fires, it replaces the tool result with text like `[LOOP DETECTED] "read_file" on "requirements.md" has been called 3 times with no writes. Stop reading and write a file now.` The model ignores this text and issues the same read_file call on the next iteration. This happens because the guard is advisory (a text message), not authoritative (a forced state transition).

**Fix: On loop detection, transition to a hard WRITE_ONLY execution phase that rejects all reads at the dispatcher level.**

**3a. Add a WRITE_ONLY phase to the execution sub-phases.**

In `src/agents/execution/ExecutionPhase.ts`:

```typescript
export type ExecutionSubPhase = 
  | 'INITIALISING'
  | 'DISCOVERING'
  | 'PLANNING_BATCH'
  | 'EXECUTING_STEP'
  | 'VALIDATING_STEP'
  | 'WRITE_ONLY';  // NEW: hard lockout of all read tools
```

**3b. When loop detector fires (toolPathCount >= 3), transition to WRITE_ONLY and inject file contents.**

Replace the current loop detection block in AgentRunner.ts (around the `toolPathCount >= 3` check):

```typescript
if (toolPathCount >= 3 && ['read_file', 'list_files', 'search_files'].includes(event.name)) {
  // Hard state transition: no more reads allowed
  stateManager.setExecutionPhase(execState, 'WRITE_ONLY');
  this.toolDispatcher.lockDiscovery();
  
  // Inject the file content the model is trying to read (if we have it)
  const storedContent = execState.resolvedInputContents?.[
    this.normalizeWorkspacePath(toolCallPath ?? '')
  ];
  
  const contentInjection = storedContent 
    ? `\n\nHere is the content you are trying to read:\n${storedContent}`
    : '';
  
  toolResult = {
    text: `[READ BLOCKED] You already read "${toolCallPath}". Phase is now WRITE_ONLY. All further reads will be rejected. Write the next file now.${contentInjection}`,
    status: 'blocked',
    reasonCode: 'WRITE_ONLY_PHASE',
    toolName: event.name,
    path: toolCallPath,
  };
}
```

**3c. In ToolDispatcher, reject reads when in WRITE_ONLY phase.**

In `src/agents/execution/ToolDispatcher.ts`, at the top of the `dispatch` method:

```typescript
if (this.executionState?.executionPhase === 'WRITE_ONLY' && 
    DISCOVERY_TOOLS.has(toolCall.name)) {
  return {
    text: `[REJECTED] Phase is WRITE_ONLY. Only write_file, edit_file, and run_command are allowed. Write the next file now.`,
    status: 'blocked',
    reasonCode: 'WRITE_ONLY_PHASE',
    toolName: toolCall.name,
    path: (toolCall.input as any)?.path,
  };
}
```

**This prevents the loop by construction**, not by asking the model to stop.

---

## FIX 4: Ensure Plan-to-Code Handoff Includes Plan Content

**File:** `src/agents/AgentRunner.ts` (the DD10 section and plan resolution)

**Current behaviour:** When the agent transitions from plan mode to code mode, the execution state records `approvedPlanPath: ".bormagi/plans/requirements_implementation_plan.md"` but does not include the plan content in the code-mode prompt. The code-mode session starts with `Files already created: .bormagi/plans/...` and the model immediately tries to read the plan file, triggering the read loop.

**Fix: Automatically load approved plan content into `resolvedInputContents` at code-mode session start.**

In `AgentRunner.ts`, after the `resolveApprovedPlanPath` block (around line where `planPath` is set):

```typescript
// When transitioning to code mode with an approved plan, pre-load the plan content
if (mode === 'code' && execState.approvedPlanPath) {
  const planPath = execState.approvedPlanPath;
  const alreadyLoaded = execState.resolvedInputContents?.[planPath];
  
  if (!alreadyLoaded) {
    try {
      const absPath = path.isAbsolute(planPath) 
        ? planPath 
        : path.join(this.workspaceRoot, planPath);
      const planContent = await fs.readFile(absPath, 'utf8');
      execState.resolvedInputContents ??= {};
      execState.resolvedInputContents[planPath] = planContent.slice(0, 6000);
      
      // Also seed the read cache so ToolDispatcher knows this file was read
      this.toolDispatcher.cacheReadResult(planPath, planContent);
      stateManager.markFileRead(execState, planPath);
    } catch {
      // Plan file missing from disk — clear the approval
      execState.approvedPlanPath = undefined;
    }
  }
}
```

Also do the same for the requirements file. In the execution state, add logic to auto-load any file listed in `resolvedInputs` that has a `resolvedInputSummary` with kind `'requirements'` or `'plan'`.

---

## FIX 5: Ensure Plan Content Matches Actual Requirements

**File:** `src/agents/AgentRunner.ts` (plan mode write validation)

**Current behaviour:** The plan session read `requirements.md` (a PDF upload/extraction tool spec), but when forced to write under pressure, produced a plan for a "requirements management system" based on the filename alone. This happened because by the time the write was forced, the requirements content had been evicted from context.

**Fix: After any plan-mode write, validate that the written plan references the primary objective from execution state.**

Add a post-write validation step in the plan-mode flow:

```typescript
// After write_file succeeds in plan mode
if (mode === 'plan' && event.name === 'write_file' && toolResult.status === 'success') {
  const writtenContent = (event.input as any)?.content as string ?? '';
  const objective = execState.primaryObjective ?? execState.objective;
  
  // Simple keyword overlap check: does the plan mention key terms from the objective?
  const objectiveWords = objective.toLowerCase().split(/\s+/)
    .filter(w => w.length > 4);
  const planWords = writtenContent.toLowerCase();
  const matches = objectiveWords.filter(w => planWords.includes(w));
  const overlapRatio = matches.length / Math.max(objectiveWords.length, 1);
  
  if (overlapRatio < 0.2) {
    // Plan is likely hallucinated — flag it
    toolResultContent += `\n\n[WARNING] The plan you wrote has low overlap with the primary objective: "${objective.slice(0, 200)}". Review and revise the plan to match the actual requirements.`;
    stateManager.setArtifactStatus(execState, 
      this.normalizeWorkspacePath(toolCallPath!), 'drafted');
    // Do NOT mark as approved
  }
}
```

---

## FIX 6: Fix BudgetEngine Conversation Tail Trimming

**File:** `src/context/BudgetEngine.ts` (function `reduceConversationTail`)

**Current behaviour:** The function trims `envelope.editable` (which holds files the model can modify) instead of conversation history. The `ContextEnvelope` type has no `conversationTail` field. This means when budget pressure hits, editable file context gets destroyed while conversation history stays intact.

**Fix:**

```typescript
function reduceConversationTail(
  envelope: ContextEnvelope, 
  budget: ModeBudget
): ContextEnvelope {
  // The envelope has no conversationTail field.
  // Tool outputs are the closest analogue to conversation tail.
  // Trim tool outputs (oldest first) rather than editable files.
  const TARGET = budget.conversationTail;
  let remaining = TARGET;
  const kept: ContextCandidate[] = [];

  for (const c of [...envelope.toolOutputs].reverse()) {
    if (remaining <= 0) { break; }
    kept.unshift(c);
    remaining -= c.tokenEstimate;
  }

  return { ...envelope, toolOutputs: kept };
}
```

If you want a proper conversationTail slot, add it to the ContextEnvelope type:

```typescript
export interface ContextEnvelope {
  editable: ContextCandidate[];
  reference: ContextCandidate[];
  memory: ContextCandidate[];
  toolOutputs: ContextCandidate[];
  conversationTail?: ContextCandidate[];  // NEW
}
```

Then update `buildContextEnvelope` to populate it from recent conversation turns, and update `reduceConversationTail` to target the new field.

---

## FIX 7: Add "Ready to Execute" Gate Before Code-Mode Iterations

**File:** `src/agents/AgentRunner.ts` (before the while loop in code mode)

**Current behaviour:** The code-mode loop starts immediately and the model decides on its own whether it has enough context. It usually decides it doesn't (even when it does) and tries to read files, starting the loop.

**Fix: Add an explicit readiness check before entering the execution loop.**

```typescript
// Before the while (continueLoop) loop, in code mode:
if (mode === 'code') {
  const hasRequirements = (execState.resolvedInputSummaries ?? [])
    .some(s => s.kind === 'requirements' || s.kind === 'plan');
  const hasPlan = !!execState.approvedPlanPath;
  const hasFileContents = Object.keys(execState.resolvedInputContents ?? {}).length > 0;
  
  if (!hasRequirements && !hasPlan && !hasFileContents) {
    // Not ready: need to read at least one input file first
    // Allow exactly ONE read iteration, then force WRITE_ONLY
    const readBudget = 2; // max read calls before forced write
    let readsUsed = 0;
    
    // Inject a directive that limits discovery
    messages.push({
      role: 'system',
      content: `[Discovery budget: ${readBudget} reads maximum. Read the most important file, then write.]`
    });
  } else {
    // Ready: inject explicit confirmation so the model does not re-read
    const loadedFiles = Object.keys(execState.resolvedInputContents ?? {}).join(', ');
    messages.push({
      role: 'system',
      content: `[READY] You have all required input files loaded: ${loadedFiles}. Begin writing immediately. Do not read any files.`
    });
    stateManager.setExecutionPhase(execState, 'EXECUTING_STEP');
  }
}
```

This gives the model explicit confirmation that it has what it needs, preventing the "let me read the file first" reflex.

---

## FIX 8: Comprehensive Agent Logging

**File:** `src/agents/AgentLogger.ts`

**Current behaviour:** The log captures system prompt, tool calls, tool results, and token usage. It does not capture: the full messages array sent to the provider, the execution state at each iteration, the prompt assembler output, context cost breakdown, or phase transitions. The log also truncates large content with `[truncated]` markers that hide the exact data the model sees.

**Fix: Add structured logging at every decision point.**

Add these new logging methods to `AgentLogger`:

```typescript
class AgentLogger {
  // ... existing methods ...

  /** Log the exact messages array sent to the provider on each iteration */
  logProviderRequest(
    iterationNumber: number,
    messages: ChatMessage[],
    mode: string,
  ): void {
    const summary = messages.map((m, i) => {
      const contentLen = m.content.length;
      const preview = m.content.slice(0, 200);
      return `  [${i}] role=${m.role} len=${contentLen} preview="${preview}..."`;
    }).join('\n');
    
    this.write(`\n┌─ PROVIDER REQUEST (iteration #${iterationNumber}, mode=${mode})\n`);
    this.write(`Messages: ${messages.length}\n`);
    this.write(summary);
    this.write(`\n└─\n`);
  }

  /** Log execution state snapshot at each iteration */
  logExecutionState(
    iterationNumber: number,
    state: ExecutionStateData,
  ): void {
    this.write(`\n┌─ EXECUTION STATE (iteration #${iterationNumber})\n`);
    this.write(`  phase: ${state.executionPhase ?? 'INITIALISING'}\n`);
    this.write(`  runPhase: ${state.runPhase ?? 'RUNNING'}\n`);
    this.write(`  iterations: ${state.iterationsUsed}\n`);
    this.write(`  resolvedInputs: [${state.resolvedInputs.join(', ')}]\n`);
    this.write(`  artifactsCreated: [${state.artifactsCreated.join(', ')}]\n`);
    this.write(`  nextActions: [${state.nextActions.join(', ')}]\n`);
    this.write(`  nextToolCall: ${state.nextToolCall ? `${state.nextToolCall.tool}(${JSON.stringify(state.nextToolCall.input).slice(0, 100)})` : 'none'}\n`);
    this.write(`  blockedReadCount: ${state.blockedReadCount ?? 0}\n`);
    this.write(`  sameToolLoop: ${state.sameToolLoop ? `${state.sameToolLoop.tool}:${state.sameToolLoop.path ?? ''}x${state.sameToolLoop.count}` : 'none'}\n`);
    this.write(`  resolvedInputContents: [${Object.keys(state.resolvedInputContents ?? {}).join(', ')}]\n`);
    this.write(`└─\n`);
  }

  /** Log phase transitions with reason */
  logPhaseTransition(
    from: string,
    to: string,
    reason: string,
  ): void {
    this.write(`\n── PHASE: ${from} → ${to} (${reason})\n`);
  }

  /** Log context cost breakdown per iteration */
  logContextCost(
    iterationNumber: number,
    breakdown: {
      systemPromptTokens: number;
      stateTokens: number;
      fileContentTokens: number;
      toolResultTokens: number;
      userMessageTokens: number;
      totalTokens: number;
    },
  ): void {
    this.write(`\n┌─ CONTEXT COST (iteration #${iterationNumber})\n`);
    this.write(`  system: ${breakdown.systemPromptTokens}\n`);
    this.write(`  state: ${breakdown.stateTokens}\n`);
    this.write(`  files: ${breakdown.fileContentTokens}\n`);
    this.write(`  toolResults: ${breakdown.toolResultTokens}\n`);
    this.write(`  user: ${breakdown.userMessageTokens}\n`);
    this.write(`  TOTAL: ${breakdown.totalTokens}\n`);
    this.write(`└─\n`);
  }

  /** Log loop guard activation */
  logGuardActivation(
    guardType: 'LOOP_DETECTED' | 'DISCOVERY_BUDGET' | 'WRITE_ONLY' | 'BATCH_ALREADY_ACTIVE',
    tool: string,
    path: string | undefined,
    iterationNumber: number,
  ): void {
    this.write(`\n── GUARD: ${guardType} on ${tool}${path ? `:${path}` : ''} at iteration #${iterationNumber}\n`);
  }

  /** Log recovery trigger and outcome */
  logRecovery(
    trigger: string,
    success: boolean,
    action: string,
  ): void {
    this.write(`\n── RECOVERY: trigger=${trigger} success=${success} action=${action}\n`);
  }

  /** Log deterministic dispatch (bypass of LLM call) */
  logDeterministicDispatch(
    tool: string,
    path: string | undefined,
    reason: string,
  ): void {
    this.write(`\n── DETERMINISTIC DISPATCH: ${tool}${path ? ` → ${path}` : ''} (${reason})\n`);
  }
  
  /** Log the full tool result without truncation (written to separate detail file) */
  logToolResultFull(
    toolName: string,
    result: string,
    iterationNumber: number,
  ): void {
    // Write to a separate detail log to keep the main log readable
    // but preserve full content for debugging
    this.writeDetail(
      `\n┌─ TOOL RESULT FULL (${toolName}, iteration #${iterationNumber})\n` +
      result +
      `\n└─\n`
    );
  }
}
```

Then wire these calls into `AgentRunner.ts` at each decision point:

1. Before every `provider.stream()` call: `agentLog.logProviderRequest(iterationCount, messagesForProvider, mode)`
2. At the top of each loop iteration: `agentLog.logExecutionState(iterationCount, execState)`
3. On every `stateManager.setExecutionPhase()` call: `agentLog.logPhaseTransition(oldPhase, newPhase, reason)`
4. After the context cost tracker records: `agentLog.logContextCost(iterationCount, breakdown)`
5. On every guard activation: `agentLog.logGuardActivation(type, tool, path, iterationCount)`
6. On every recovery trigger: `agentLog.logRecovery(trigger, result.success, action)`
7. On every deterministic dispatch: `agentLog.logDeterministicDispatch(tool, path, reason)`

---

## FIX 9: Context Window Reuse via Resolved Content Registry

**File:** `src/agents/execution/ContextPacketBuilder.ts`

**Current behaviour:** The context packet builder creates a state summary and workspace summary but does not include the actual file contents the model needs to do its work. Each iteration, the model sees state metadata ("you read requirements.md") but not the content of requirements.md.

**Fix: The context packet must include resolved file contents as a first-class section.**

```typescript
// In ContextPacketBuilder.build()
build(
  execState: ExecutionStateData,
  workspaceType: string,
  previousToolResults?: ChatMessage[],
  currentInstruction?: string,
): {
  stateSummary: string;
  workspaceSummary: string;
  resolvedInputSummaries: ResolvedInputSummary[];
  resolvedFileContents: string;  // NEW
} {
  // ... existing logic for stateSummary and workspaceSummary ...

  // Build resolved file contents block
  const fileBlocks: string[] = [];
  const contents = execState.resolvedInputContents ?? {};
  
  for (const [filePath, content] of Object.entries(contents)) {
    // Find the corresponding summary for metadata
    const summary = (execState.resolvedInputSummaries ?? [])
      .find(s => s.path === filePath);
    const kindLabel = summary?.kind ?? 'file';
    fileBlocks.push(
      `### ${filePath} (${kindLabel})\n${content}`
    );
  }

  return {
    stateSummary,
    workspaceSummary,
    resolvedInputSummaries: execState.resolvedInputSummaries ?? [],
    resolvedFileContents: fileBlocks.length > 0
      ? `## Resolved Input Files (authoritative, do not re-read)\n\n${fileBlocks.join('\n\n')}`
      : '',
  };
}
```

---

## FIX 10: Prevent Plan Hallucination Under Pressure

**File:** `src/agents/AgentRunner.ts` (the forced-write path after loop detection in plan mode)

**Current behaviour:** When the loop detector forces a write in plan mode, the model has lost the file content from context and generates a plan based on filename guessing. The plan for "requirements.md" became a "requirements management system" instead of a "PDF extraction tool."

**Fix: When forcing a write in plan mode, inject the cached file content directly into the write instruction.**

In the recovery/forced-write path:

```typescript
// When forcing a write after blocked reads in plan mode
if (trigger === 'REPEATED_BLOCKED_READS' && mode === 'plan') {
  // Inject all resolved file contents into the next prompt
  const allContents = Object.entries(execState.resolvedInputContents ?? {})
    .map(([p, c]) => `[${p}]:\n${c}`)
    .join('\n\n---\n\n');
  
  if (allContents) {
    messages.push({
      role: 'system',
      content: `[FORCED WRITE MODE] You must write the plan now. Here are the input files you previously read:\n\n${allContents}\n\nBase your plan on THIS content, not on filenames.`
    });
  }
}
```

---

## Implementation Priority Order

The fixes should be implemented in this order (highest impact first):

1. **FIX 2** (inject file contents into protected context) — eliminates the root cause
2. **FIX 3** (deterministic WRITE_ONLY phase) — prevents the loop by construction
3. **FIX 4** (plan-to-code handoff includes content) — prevents cross-session content loss
4. **FIX 7** (ready-to-execute gate) — stops the model from reflexively reading
5. **FIX 1** (eliminate system prompt resend) — saves 50K-90K tokens per session
6. **FIX 6** (BudgetEngine trimming bug) — prevents context corruption
7. **FIX 10** (prevent plan hallucination) — catches wrong plans early
8. **FIX 5** (plan validation against objective) — safety net for plan quality
9. **FIX 9** (context packet includes file contents) — structural improvement
10. **FIX 8** (comprehensive logging) — enables debugging of remaining issues

Fixes 1-4 together address the core loop problem. Fix 8 (logging) should be done in parallel with the others so you can verify each fix works.

---

## Verification Criteria

After implementing fixes 1-4, rerun the same task (plan + implement from requirements.md) and confirm:

- Total input tokens under 80,000 (down from 409,884)
- Zero loop detection events
- The plan matches the actual requirements (PDF extraction, not requirements management)
- Code mode writes application source files (Python backend, React frontend), not just config files
- The model never says "I'll read the requirements file" after it has already been read
- The log shows exact messages sent to the provider at each iteration
- The log shows execution state and phase at each iteration
