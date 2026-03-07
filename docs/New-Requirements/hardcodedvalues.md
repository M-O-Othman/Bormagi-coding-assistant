# Hardcoded Values Audit

## Rule Used
If a value can reasonably change in the future for a product/business/policy reason (not because code architecture changed), it should live in data/config instead of being hardcoded in source files.

## Scope
Scanned `src/`, `media/`, `predefined-*`, and `data/`.

## Findings

| # | File | Hardcoded Value | Why It Should Be Dynamic | Suggested Home |
|---|------|------------------|--------------------------|----------------|
| 1 | `src/types.ts:4` | `UserRole = 'Developer' | 'Architect' | 'Business Analyst' | 'Reviewer'` | Roles are product taxonomy and may change with org/process changes. | `data/onboarding.json` as single source of truth; derive type from data schema. |
| 2 | `src/types.ts:44-56` | `AgentCategory` union string list | Category labels are business vocabulary and are already duplicated in data. | `data/agent-categories.json` (generate/validate type from data). |
| 3 | `src/ui/SetupWizard.ts:220-223` | Fallback workflow templates `['feature-delivery','bug-fix','architecture-spike']` | Recommended templates per role are product-level defaults and already modeled in onboarding data. | `data/onboarding.json` global default list. |
| 4 | `media/main.html:667-669` | Fixed workflow template options in UI | Template catalog can change without code changes (new templates, renames, ordering). | Load template list from extension data/API at runtime. |
| 5 | `media/workflow-board.html:423-425` | Fixed workflow template options in board wizard | Same issue as above; duplicated hardcoded catalog. | Use one dynamic template source shared by all UIs. |
| 6 | `media/main.html:1233`, `src/ui/MainPanel.ts:315` | Default human owner fallback `'human'` | Actor identity is org/process policy and may vary by team. | Workspace config default (e.g., `config.json` user identity). |
| 7 | `media/workflow-board.html:847,853` | `approvedBy: 'human'`, `rejectedBy: 'human'` | Approval actor label should reflect real user identity or workspace setting. | Inject current user identity from config/session state. |
| 8 | `media/main.html:1209` | Kanban label map `{ backlog:'Backlog', active:'Active', waiting_review:'Waiting Review', blocked:'Blocked', done:'Done' }` | Board terminology is UX copy and can change for non-technical reasons. | UI copy/config JSON (or i18n resource). |
| 9 | `media/workflow-board.html:376-388`, `400-407` | Hardcoded event-type and artifact-status filter options | Event/status vocab evolves with workflow product changes. | Generate options from enums/schema exposed by extension host. |
|10 | `src/providers/ProviderFactory.ts:48,58` | Default base URLs for DeepSeek and Qwen | Provider endpoints can change due vendor policy/product updates. | `data/providers.json` (per-provider endpoint defaults). |
|11 | `src/providers/GeminiProvider.ts:101` | Default Vertex location `'us-central1'` | Region default is deployment/business policy, not core logic. | Workspace/provider config with optional org default. |
|12 | `src/providers/OpenAIProvider.ts:45`, `AnthropicProvider.ts:35`, `GeminiProvider.ts:499` | Default `maxTokens = 4096` | Token policy is model/provider/business tuning and may change often. | Provider/model config in `data/models.json` or workspace settings. |
|13 | `src/agents/MemoryManager.ts:4-7` | `MAX_HISTORY_MESSAGES = 20`, `PERSISTENT_MEMORY_TURNS = 5` | Conversation retention is product policy and UX tuning. | Workspace settings or `data/security.json`-style config. |
|14 | `src/utils/FileScanner.ts:16-17` | Default scan limits `maxFiles=50`, `maxFileSizeKb=100` | Context budget policy may change by use case, plan tier, or UX preference. | Workspace settings defaults (already partially configurable upstream). |
|15 | `src/workflow/ExecutionLock.ts:104` | Stale lock limit `4 * 60 * 60 * 1000` | Recovery timeout is operational policy and may vary by team/process. | Workflow runtime config (e.g., `data/workflow-policy.json`). |
|16 | `src/workflow/GovernanceManager.ts:121` | `isPermissionRequired(...) { return true; }` | Governance policy likely varies by workflow template or org compliance requirements. | Template-level governance config (already hinted in comment). |
|17 | `src/ui/AgentSettingsPanel.ts:518,521` | New-agent defaults: `'Custom Agent'`, provider `'anthropic'` | Product defaults for first-time UX can change based on strategy or region. | Data-driven UI defaults in `data/onboarding.json`/provider presets. |

## Notes
- Values already moved to `data/*.json` (models, pricing, providers, onboarding roles, categories, tools, security patterns) are in good shape and align with the rule.
- I excluded clearly technical constants (protocol versions, JSON-RPC error codes, CSP strings, binary sizes) unless they had clear policy/product implications.
