# Implementation Plan — Context & Token Enhancement
## Spec Reference: `2.ai_coding_assistant_context_token_comprehensive_spec.v2.md`

**Status:** PENDING — waiting for answers to open questions in `/docs/open-questions.md`
**Branch:** `claude/plan-context-token-enhancements-fKSEL`
**Constraint:** Must not break any existing functionality.

---

## 0. Prerequisites

All open questions (OQ-1 through OQ-17) in `/docs/open-questions.md` must be answered before implementation begins. This plan will be updated based on those answers.

---

## 1. What Is Already Implemented

The following features from the spec are considered done and will not be re-implemented:

| Feature | Location | Notes |
|---|---|---|
| Repo compression + task-scoped retrieval snippets | `src/agents/execution/PromptEfficiency.ts` | `buildRepoSummary()`, `selectRelevantFileSnippets()` |
| Tool schema minimization | `src/agents/execution/PromptEfficiency.ts` | `minifyToolDefinitions()` |
| Anthropic prompt caching | `src/providers/AnthropicProvider.ts` | cache_control markers on stable blocks |
| Request-size instrumentation | `src/agents/AgentRunner.ts` | `measureRequestSize()` |
| LLM_REQUEST / LLM_RESPONSE_HEADERS audit events | `src/audit/AuditLogger.ts` | already logging |
| Provider response headers capture | All three providers | rate-limit observability |
| `maxOutputTokens` setting | `package.json` | default 1200 |
| History trimming at context limit | `src/agents/execution/ContextWindow.ts` | `trimToContextLimit()` |
| Knowledge-base semantic retrieval | `src/knowledge/RetrievalService.ts` | existing vector + embedding stack |
| Three-tier session memory | `src/memory/` | TurnMemory / SessionMemory / PublishedKnowledge |
| Multi-stage workflow orchestration | `src/workflow/WorkflowEngine.ts` | covers FR-14 partially |
| Prompt efficiency tests | `src/tests/integration/prompt-efficiency.test.ts` | |

---

## 2. Guiding Principles for This Plan

1. **Non-breaking first** — every new component is additive; existing call sites are unchanged until the new pipeline is complete and tested.
2. **Interface-before-implementation** — define TypeScript interfaces (matching the spec) before writing logic, to avoid rework.
3. **Phased delivery** — follow the spec's phased plan (§21) and priority order (§32).
4. **Config-driven** — all thresholds, budgets, and weights go into `package.json` settings or workspace config, not hardcoded.
5. **Test-first for critical paths** — budget engine, compaction trigger, and ranking logic must have unit tests before integration.

---

## 3. Planned Components and File Locations

> These locations are adapted from Appendix B of the spec to fit the existing `src/` structure.

```
src/
  context/                          ← NEW module
    types.ts                        ← All new shared interfaces (FR-1 through FR-15B)
    ModeClassifier.ts               ← FR-1: Request classification
    BudgetEngine.ts                 ← FR-7: Token budget enforcement
    PromptAssembler.ts              ← FR-6 + FR-13: Mode-specific templates + degradation
    StablePrefixCache.ts            ← FR-8: Cache key management + segment tracking
    ContextCompactor.ts             ← FR-9: History compaction and summarization
    ContextEnvelope.ts              ← FR-10: Editable / reference separation
    InstructionResolver.ts          ← FR-4A: Durable layered instruction files
    ToolArtifactNormalizer.ts       ← FR-11: Structured tool output normalization
    HookEngine.ts                   ← FR-15A: Deterministic lifecycle hooks
    PlanManager.ts                  ← FR-15B: Long-horizon plan artifacts

  index/                            ← NEW module
    RepoMapBuilder.ts               ← FR-2: Codebase structural index builder
    SymbolExtractor.ts              ← FR-2: Language-server symbol extraction
    IgnoreRules.ts                  ← FR-3: File exclusion policy
    RepoMapStore.ts                 ← FR-2: JSON file persistence for repo map

  retrieval/                        ← NEW module
    RetrievalOrchestrator.ts        ← FR-5: Multi-signal candidate gathering
    CandidateRanker.ts              ← FR-5: Scoring and pruning
    SnippetExtractor.ts             ← FR-12.3: Bounded snippet windows
    LexicalSearch.ts                ← FR-5: Term-based search over repo map

  config/                           ← NEW module (extends existing ConfigManager)
    ModelProfiles.ts                ← FR-12: Provider profile registry
    ModeBudgets.ts                  ← FR-6: MODE_BUDGETS constants + types

  memory/
    SessionCheckpoint.ts            ← FR-15: Checkpoint store (NEW file)
    EnhancedSessionMemory.ts        ← FR-4: Extended memory with goal/plan/blockers (NEW file)
```

**Existing files that will receive targeted additions (non-breaking):**

| File | Addition |
|---|---|
| `src/agents/AgentRunner.ts` | Wire new context pipeline when feature flag enabled |
| `src/types.ts` | Add `AssistantMode`, `ModeDecision`, `ModelProfile`, `ContextThresholds` |
| `src/audit/AuditLogger.ts` | Add new telemetry event types (compaction, degradation, cache hit) |
| `src/providers/AnthropicProvider.ts` | Use `StablePrefixCache` keys instead of ad-hoc cache markers |
| `src/config/ConfigManager.ts` | Expose hook config and instruction layer config |
| `package.json` | Add new configuration settings for budgets, thresholds, hooks path |

---

## 4. Phased Implementation Plan

### Phase 1 — Token Visibility and Budget Control
**Spec reference: §21 Phase 1, §32 Priority 1**

#### 1.1 Shared type definitions
- Create `src/context/types.ts` with all new interfaces:
  - `AssistantMode`, `ModeDecision`
  - `ModeBudget`, `BudgetCheckResult`
  - `ContextThresholds`, `ModelProfile`
  - `RequestTelemetry`
  - `ContextCandidate`, `ContextEnvelope`
  - `CompactedHistory`, `CompactionInput`, `CompactionOutput`
  - `CachedPromptSegment`
  - `HookContext`, `HookResult`
  - `ExecutionPlan`, `PlanMilestone`
  - `InstructionLayer`, `EffectiveInstructions`
  - `CapabilityManifest`, `LoadedCapability`
- Add `AssistantMode` to `src/types.ts` (re-export from context/types)

#### 1.2 Mode Classifier (`src/context/ModeClassifier.ts`)
- Rules-based primary classifier (answer to OQ-1 will determine if LLM fallback is added)
- Pattern table: keyword → mode mappings
  - `plan`, `design`, `architect`, `what files`, `which files` → `plan`
  - `fix`, `bug`, `error`, `failing`, `broken`, `exception` → `debug`
  - `edit`, `change`, `refactor`, `rename`, `move` → `edit`
  - `review`, `check`, `feedback`, `looks good`, `PR` → `review`
  - `explain`, `what does`, `how does`, `describe` → `explain`
  - `find`, `search`, `where is`, `locate` → `search`
  - `test`, `spec`, `failing test` → `test-fix`
- Returns `ModeDecision` with confidence score and reason
- Logs mode decision to telemetry

#### 1.3 Model Profiles (`src/config/ModelProfiles.ts`)
- `ModelProfile` registry keyed by provider + model
- Pre-populate for: claude-sonnet-4-x (200k context), claude-haiku-4-x, gpt-4o (128k), gemini-1.5-pro (1M)
- Include `ContextThresholds` (65% warn, 75% prune, 82% compact, 90% emergency)
- `getActiveModelProfile(providerConfig)` exported function

#### 1.4 Mode Budgets (`src/config/ModeBudgets.ts`)
- `MODE_BUDGETS` constant (from spec §FR-6) — answers to OQ-16 will determine if these are settings-overridable
- `getTotalBudget(mode, profile)` helper

#### 1.5 Budget Engine (`src/context/BudgetEngine.ts`)
- `checkBudget(estimatedInputTokens, hardLimit, safetyMargin): BudgetCheckResult`
- `enforcePreflightBudget(envelope, mode, profile)` — applies pruning actions
- Prune order (per spec FR-7 and FR-13):
  1. Remove low-ranked reference snippets
  2. Reduce repo map detail
  3. Summarize large tool outputs
  4. Reduce conversation tail
  5. Shift to degraded plan-only path
- Emits telemetry events

#### 1.6 Telemetry additions to AuditLogger
- Add event types: `COMPACTION_TRIGGERED`, `BUDGET_DEGRADED`, `CACHE_HIT`, `CACHE_MISS`, `MODE_CLASSIFIED`
- `RequestTelemetry` logging at end of each LLM call

#### 1.7 Unit tests
- `src/tests/unit/budget-engine.test.ts`
- `src/tests/unit/mode-classifier.test.ts`
- Coverage: all prune actions, degradation order, mode classification accuracy

---

### Phase 2 — Repo Map and Retrieval
**Spec reference: §21 Phase 2, §32 Priority 2**

#### 2.1 Ignore Rules (`src/index/IgnoreRules.ts`)
- `DEFAULT_EXCLUDES` array from spec FR-3
- `shouldExclude(filePath, userIncludes, projectAllowlist, projectIgnoreFile): boolean`
- Precedence: user explicit include > project allowlist > project ignore > built-in defaults
- Integration with existing `GitignoreManager`

#### 2.2 Symbol Extractor (`src/index/SymbolExtractor.ts`)
- Use `vscode.executeDocumentSymbolProvider` to get symbols per file
- Map VS Code `DocumentSymbol` kinds to spec's `SymbolEntry.kind`
- Extract: name, kind, signature (from range text), lineStart, lineEnd
- **OQ-5 answer will determine** if this is TS-only or all languages

#### 2.3 Repo Map Builder (`src/index/RepoMapBuilder.ts`)
- `buildRepoMap(workspaceRoot): Promise<RepoMap>`
- Walk workspace files (respecting IgnoreRules)
- For each eligible file: read metadata, call SymbolExtractor, extract imports/exports
- Produce `FileMapEntry[]`
- Background worker pattern (no UI blocking)

#### 2.4 Repo Map Store (`src/index/RepoMapStore.ts`)
- Load/save `RepoMap` as JSON (location per OQ-3 answer)
- `isFresh(entry, filePath): boolean` — check mtime vs `lastModifiedUtc`
- Incremental update: only rebuild changed files (per OQ-4 answer)
- `serializeRepoMapSlice(entries, maxTokens)` — token-bounded serialization

#### 2.5 Lexical Search (`src/retrieval/LexicalSearch.ts`)
- `searchRepoMap(repoMap, terms): FileMapEntry[]`
- Score by: symbol name matches, path matches, summary matches
- Returns ranked results with match reasons

#### 2.6 Snippet Extractor (`src/retrieval/SnippetExtractor.ts`)
- `boundedWindow(line, before, after): SnippetWindow` (from spec)
- `extractSnippet(filePath, window): string`
- Used by ranker when full-file inclusion is not needed

#### 2.7 Candidate Ranker (`src/retrieval/CandidateRanker.ts`)
- `scoreCandidate(input): number` (using spec's weight formula)
- `rankAndPrune(candidates, mode, budgetSlot): ContextCandidate[]`
- Scoring weights configurable (OQ-16)

#### 2.8 Retrieval Orchestrator (`src/retrieval/RetrievalOrchestrator.ts`)
- `retrieveCandidates(query, memory, repoMap): Promise<ContextCandidate[]>`
- Gathers from:
  - Active file / selection (from query)
  - Lexical search (LexicalSearch)
  - Existing knowledge-base semantic search (RetrievalService)
  - Import graph neighbors (from FileMapEntry.imports)
  - Recent edited files (from EnhancedSessionMemory)
  - Diagnostics / stack trace files (from query)
  - Repo map slices for impacted directories
- Returns scored, ranked `ContextCandidate[]`

#### 2.9 Context Envelope (`src/context/ContextEnvelope.ts`)
- `buildContextEnvelope(candidates, mode): ContextEnvelope`
- Separates into `editable` vs `reference` sets per mode rules (FR-10)
- Edit mode: editable count capped at configurable threshold (default 3 files)
- Reference context uses snippets / summaries, not full files

#### 2.10 Integration tests
- `src/tests/integration/repo-map.test.ts`
- `src/tests/integration/retrieval-orchestrator.test.ts`

---

### Phase 3 — Mode-Specific Prompting and Editable Scope
**Spec reference: §21 Phase 3**

#### 3.1 Instruction Resolver (`src/context/InstructionResolver.ts`)
- `resolveInstructionLayers(args): EffectiveInstructions`
- Walk from workspace root → active file path, collect `.assistant/AGENTS.md` or `.bormagi/instructions/*.md`
- (OQ-6 answer will determine the naming convention)
- (OQ-7 answer will determine if per-directory files are supported)
- Merge layers broad-to-narrow, narrower scope takes precedence
- Cap at configurable token budget
- Retain provenance metadata per layer

#### 3.2 Tool Artifact Normalizer (`src/context/ToolArtifactNormalizer.ts`)
- `normalizeTestFailure(rawOutput): TestFailureArtifact`
- `normalizeSearchHits(rawOutput): SearchHitArtifact[]`
- `normalizeBuildOutput(rawOutput): string` (bounded, key lines only)
- `normalizeDiff(rawDiff): string` (bounded)
- Truncation with source line references preserved

#### 3.3 Prompt Assembler (`src/context/PromptAssembler.ts`)
- `assemblePrompt(args): string`
- Builds sections in spec order (§13): system → rules → memory → repoMap → task → editable → reference → toolArtifacts → conversationTail → outputContract
- Mode-specific output contracts (FR-6 §24.3):
  - Plan: assumptions, impacted files, plan steps, risks
  - Edit: patch summary, changed files, validation notes
  - Debug: root cause hypothesis, evidence, proposed fix
  - Review: findings by severity, suggested changes, confidence
- Applies budget enforcement via BudgetEngine before returning

#### 3.4 Update AgentRunner to use new pipeline (feature-flagged)
- Add config setting `bormagi.useEnhancedContextPipeline` (default: `false` initially)
- When enabled: call `ModeClassifier → RetrievalOrchestrator → PromptAssembler` instead of existing path
- Existing path remains fully functional as fallback
- (OQ-14 will determine rollout strategy)

#### 3.5 Integration tests
- `src/tests/integration/prompt-assembler.test.ts` — each mode template
- `src/tests/integration/instruction-resolver.test.ts`

---

### Phase 4 — Structured Memory and Compaction
**Spec reference: §21 Phase 4**

#### 4.1 Enhanced Session Memory (`src/memory/EnhancedSessionMemory.ts`)
- Extends existing `SessionMemory` with spec's required fields (FR-4):
  - `currentGoal`, `currentPlan: string[]`, `unresolvedQuestions: string[]`
  - `recentEditedFiles: string[]`, `recentFailures: string[]`, `recentSuccesses: string[]`
  - `decisions: ArchitectureDecision[]`, `codingConventions: string[]`
- **Non-breaking**: new class wraps existing memory, does not modify `SessionMemory.ts`
- Persisted as workspace-local JSON (per spec §28 answer 4)

#### 4.2 Context Compactor (`src/context/ContextCompactor.ts`)
- `shouldCompact(historyTokens, profile): boolean`
- `compact(input: CompactionInput): Promise<CompactionOutput>`
- Uses same primary model (per spec §28 answer 3) with compaction prompt
- Produces `CompactedHistory` (structured) + narrative summary
- Preserves: current objective, decisions, blockers, recent actions, pending next steps
- Drops: conversational filler, obsolete failed attempts, raw logs
- Post-compaction: re-injects compact summary as first assistant turn

#### 4.3 Compaction trigger (in AgentRunner / context pipeline)
- Check `shouldCompact()` before each LLM call
- (OQ-8 + OQ-9 answers determine automatic vs user-visible trigger)
- Emit `COMPACTION_TRIGGERED` telemetry event
- Log compacted message count to AuditLogger

#### 4.4 Session Checkpoint (`src/memory/SessionCheckpoint.ts`)
- `saveCheckpoint(state: CheckpointState): Promise<void>`
- `loadCheckpoint(sessionId): Promise<CheckpointState | null>`
- `CheckpointState`: latest compacted summary, current plan, recent edits, last validated state, active mode
- Stored in workspace-local JSON
- Loaded at session start — enables resume after restart

#### 4.5 Unit and integration tests
- `src/tests/unit/context-compactor.test.ts` — trigger logic, threshold math
- `src/tests/integration/compaction-flow.test.ts` — end-to-end compaction + resume

---

### Phase 5 — Provider Optimization, Hooks, and Plan Artifacts
**Spec reference: §21 Phase 5, FR-15A, FR-15B**

#### 5.1 Stable Prefix Cache (`src/context/StablePrefixCache.ts`)
- `buildCacheKey(parts): string`
- `getCachedSegment(cacheKey): CachedPromptSegment | null`
- `setCachedSegment(segment): void`
- `invalidate(reason)`: on rules change, workspace switch, tool schema revision
- Hash-based invalidation (`contentHash` per segment)
- Integrates with `AnthropicProvider` cache_control markers
- For non-Anthropic providers: use hash to skip resending unchanged tool schemas

#### 5.2 Hook Engine (`src/context/HookEngine.ts`)
- `runHooks(event, ctx): Promise<HookResult>`
- Supported events: `session-start`, `before-tool`, `after-tool`, `after-edit`, `before-final`, `after-compaction`
- (OQ-10 determines config file location)
- (OQ-11 determines in-process vs shell command hooks)
- Hook config loaded from workspace at session start
- `HookResult.allow = false` blocks the pending action
- `HookResult.contextToInject` re-injects content after compaction
- Built-in hooks:
  - Protected-path check (`before-tool` for `writeFile`)
  - Post-compaction summary re-injection (`after-compaction`)

#### 5.3 Plan Manager (`src/context/PlanManager.ts`)
- `shouldCreatePlan(request, modeDecision): boolean`
- `createPlan(objective, mode): Promise<ExecutionPlan>`
- `updateMilestone(planId, milestoneId, status, notes)`
- `loadPlan(planId): Promise<ExecutionPlan | null>`
- Saves as `.bormagi/plans/<id>.json` + optionally `PLAN.md` in workspace root
- (OQ-12 and OQ-13 answers determine storage and trigger)
- Validation failure blocks milestone advance

#### 5.4 Capability Registry (`src/context/CapabilityRegistry.ts`)
- `loadManifests(capabilitiesDir): CapabilityManifest[]`
- `maybeLoadCapability(manifests, query, budget): Promise<LoadedCapability | null>`
- Lazy loading: only fetch full instructions when capability is selected
- Activation recorded in session memory

#### 5.5 Integration tests
- `src/tests/integration/hooks.test.ts` — protected-path blocking, post-compaction inject
- `src/tests/integration/plan-manager.test.ts` — plan creation, milestone update, resume
- `src/tests/unit/stable-prefix-cache.test.ts` — hash invalidation

---

## 5. New Configuration Settings (`package.json`)

```json
{
  "bormagi.useEnhancedContextPipeline": false,
  "bormagi.contextPipeline.modeBudgets": { ... },
  "bormagi.contextPipeline.compactionThresholds.warnAtPct": 0.65,
  "bormagi.contextPipeline.compactionThresholds.pruneAtPct": 0.75,
  "bormagi.contextPipeline.compactionThresholds.compactAtPct": 0.82,
  "bormagi.contextPipeline.compactionThresholds.emergencyAtPct": 0.90,
  "bormagi.contextPipeline.maxEditableFiles": 3,
  "bormagi.contextPipeline.repoMap.storageLocation": ".bormagi",
  "bormagi.contextPipeline.repoMap.autoRefresh": true,
  "bormagi.contextPipeline.instructionFiles.convention": ".bormagi/instructions",
  "bormagi.contextPipeline.hooks.configPath": ".bormagi/hooks.json",
  "bormagi.contextPipeline.plans.storageLocation": ".bormagi/plans",
  "bormagi.contextPipeline.plans.writePlanMd": true
}
```

---

## 6. Risk Register

| Risk | Mitigation |
|---|---|
| Repo map build is slow on large repos | Background build + incremental updates; show progress in status bar |
| Compaction loses critical context | Structured `CompactedHistory` preserves decisions/blockers; tests validate quality |
| Mode misclassification | Telemetry shows confidence; user can override (if OQ-2 = C) |
| Stale repo map causes wrong retrieval | Hash-based file mtime checks; auto-refresh on save events |
| Hook blocks legitimate writes | Hooks are config-driven; default hooks only cover protected paths explicitly listed |
| Prompt assembler produces worse results | Feature-flagged behind `useEnhancedContextPipeline`; old path is default until regression tests pass |
| Tool output normalization truncates useful data | Keep source line references; log truncation events to telemetry |

---

## 7. Definition of Done (per spec §29)

- [ ] New context pipeline is the default path (`useEnhancedContextPipeline: true` by default)
- [ ] Mode-specific budgets are enforced on every request
- [ ] Repo map is built, persisted, and used for retrieval
- [ ] Structured memory (EnhancedSessionMemory) is live
- [ ] Context compaction is active and benchmarked
- [ ] Stable prefix caching is implemented for Anthropic; hash-skip for others
- [ ] Telemetry emits: mode, budget pressure, cache hit/miss, compaction events
- [ ] All existing tests pass
- [ ] New unit + integration tests pass
- [ ] Prompt-too-large errors reduced (measured via audit log)
- [ ] Feature flag default flipped to `true` only after regression suite confirms no quality loss

---

## 8. Dependency Between Phases

```
Phase 1 (types + budget engine + classifier)
    ↓
Phase 2 (repo map + retrieval)
    ↓
Phase 3 (prompt assembler + mode templates)  ← can start in parallel with Phase 4
    ↓
Phase 4 (memory + compaction)
    ↓
Phase 5 (hooks + plan manager + provider caching)
    ↓
Feature flag flip + regression validation
```

Phase 1 must complete first (shared types). Phases 3 and 4 can overlap once Phase 2 is stable.

---

*This plan is subject to revision based on open question answers.*
