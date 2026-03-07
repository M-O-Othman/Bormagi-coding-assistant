Below is a **single-panel** Codex-style chat GUI spec that prioritizes **readability**, **minimal default info**, and **expand-on-demand** details (diffs, traces, tool logs). It mirrors the “diff-centric + collapsible evidence” workflow OpenAI promotes (patch/apply_patch + readable diffs, approvals, compacting state). ([OpenAI Developers][1])

---

## 1) Recommended approach (Codex-like)

**Principle:** *Chat is the primary surface. Everything else is an expandable section inside messages.*

* **Default view shows only:**

  * A short “Answer / Plan” summary (3–7 lines max)
  * The *minimum* actionable items (buttons)
* **Everything else is collapsed by default:**

  * Diffs (“Edited files”)
  * Tool logs (terminal, tests)
  * “Thoughts/trace” (if you choose to expose it—see section 8)
  * Long code blocks (auto-collapse above N lines)

This matches real user feedback around Codex/agent UIs: users want *edited-file panels* and long blocks not to expand aggressively. ([GitHub][2])

---

## 2) Single main screen layout (one panel)

### 2.1 Top bar (compact, fixed)

* Left: Workspace/repo context (branch, root folder) as a single pill
* Center: Model + mode (“Read-only / Approve / Auto”) (Codex-style approvals) ([OpenAI][3])
* Right: Settings (theme, font size, “Collapse long blocks”, “Show traces”), export

### 2.2 Conversation stream (the panel)

Each assistant response is a **Message Card** with **collapsible sections**.

**Message Card structure (in order):**

1. **Summary header (always visible)**

   * Title line: “Proposed change” / “Answer” / “Fix”
   * 1–2 line summary
2. **Primary actions row (always visible)**

   * `Open files` (if files referenced)
   * `Preview diff` (if changes)
   * `Apply` (disabled until diff preview opened, recommended)
   * `Run tests` (if command suggested)
3. **Collapsed sections (accordion)**

   * **Changes (Diff)** – collapsed by default
   * **Files referenced** – collapsed by default
   * **Commands & tool output** – collapsed by default
   * **Details / Explanation** – collapsed by default
   * **Trace** – collapsed by default (optional)

> No sidebars, no second panel. Everything stays in the same vertical stream.

### 2.3 Composer (bottom, fixed)

* Multiline input
* Attach file / paste snippet
* Buttons: `Send`, `Stop`, `Regenerate`
* Optional: “Include selection” toggle (IDE integration)

---

## 3) Readability rules (non-negotiable)

### 3.1 Typography

* Max content width inside panel: **900–1100px**
* Assistant Markdown renders with:

  * Clear heading hierarchy (H2/H3 only; avoid H1 spam)
  * Bullets preferred over long paragraphs
  * Tables only when needed (otherwise collapsible lists)

### 3.2 “Less info unless expanded”

* **Default assistant message text budget:** ~10–15 lines
* Long content goes under accordions:

  * “Why” / “How”
  * “Edge cases”
  * “Full logs”
  * “Full code”

---

## 4) Rendering: Markdown-first + safe HTML

**Primary format:** CommonMark Markdown + fenced code blocks + task lists.

**HTML:** allow a small safe subset only (sanitize hard):

* Allow: `p, br, a, strong, em, ul, ol, li, code, pre, h2-h4, blockquote, table`
* Block: scripts/iframes/styles/event handlers

---

## 5) File link syntax (clickable + resolvable)

### 5.1 Canonical internal file URI (recommended)

Use a deterministic internal link scheme that your renderer converts to “open file” actions:

* `file:///<abs-path>#L120`
* `repo://<repo-id>/<path>#L120-L145`
* `vscode://file/<abs-path>:120:9` (if you’re inside VS Code)

UI should accept *user-friendly* plain text too:

* `src/app/main.ts:120:9`
* `src/app/main.ts#L120-L145`

### 5.2 Auto-linking rules

Auto-detect file references in assistant output and render as **file pills**:

* `📄 src/app/main.ts` `#L120`
  Hover shows quick preview + actions:
* Open
* Copy path
* Reveal in tree
* Open diff (if changed)

---

## 6) Code blocks (dark background) + collapse policy

### 6.1 Code block UI

All fenced code blocks render with:

* Dark background panel (even in light theme, slightly tinted)
* Monospace font
* Language badge (e.g., `ts`, `python`)
* Buttons: `Copy`, `Insert`, `Save as file`
* Optional: line numbers toggle

### 6.2 Auto-collapse (Codex-like “keep it compact”)

* If code block > **30 lines** (configurable):

  * Show first ~12 lines + “Expand (N lines)”
  * “Expand all code blocks” control per message (tiny link)

This aligns with common requests for collapsible code blocks in chat UIs. ([OpenAI Developer Community][4])

---

## 7) Diffs: “preview before apply”, granular control

Codex-style workflow is **diff-centric**: propose changes as structured diffs; user previews and applies. ([OpenAI Developers][1])

### 7.1 Diff section (collapsed by default)

Accordion title: **Changes (3 files)**

Inside:

* Per-file sub-accordion:

  * Header: `Modified · src/app/main.ts`
  * Buttons: `Open`, `Apply file`, `Revert file`
* Diff view:

  * Unified diff (default)
  * Optional side-by-side toggle
  * Hunk-level controls: `Apply hunk`, `Reject hunk`

> “Preview changes before applying” is repeatedly requested in Codex extension workflows; build it in as default behavior. ([OpenAI Developer Community][5])

### 7.2 “Before and after” view (when needed)

Sometimes users want explicit before/after. Best practice:

* Keep **unified diff** as the source of truth
* Add a toggle: **View full before / full after**

  * Loads file snapshots (collapsed)
  * Shows syntax-highlighted full file in two tabs (“Before”, “After”)

### 7.3 Apply mechanism (structured patch)

Backend should support structured patch application (create/update/delete) rather than “freeform edits”. ([OpenAI Developers][1])

---

## 8) “Thoughts tracing” (minimal by default, safe by design)

If you want a Codex-like “explain actions” without dumping raw chain-of-thought:

* Provide a collapsed **Trace** section that contains **action evidence only**:

  * Files inspected (list)
  * Commands run
  * Patch operations summary
  * Test results
* Avoid exposing hidden reasoning verbatim; show **observable steps** instead.

This gives transparency without clutter.

---

## 9) Good practices (practical checklist)

* **Single panel, multi-accordion messages** (no sidebars).
* **Default collapsed**: diffs, logs, long code, deep explanations.
* **Action-first controls**: Open/Preview/Apply/Run are always visible.
* **Trust**: never auto-apply; require preview for destructive ops.
* **Compact conversation state**: allow “collapse previous tool outputs” to keep the stream readable (Codex upgrades mention compacting state). ([OpenAI][3])
* **Keyboard-first**:

  * `Enter` send, `Shift+Enter` newline
  * `Ctrl/Cmd+K` focus input
  * `e` expand/collapse current section, `d` open diff (optional)

---

## 10) Message schema (what your frontend should render)

Use structured blocks, not just plaintext:

```json
{
  "role": "assistant",
  "blocks": [
    { "type": "summary", "text": "Fix build error by pinning esbuild and updating tsconfig." },
    { "type": "actions", "items": ["preview_diff", "open_files", "apply", "run_tests"] },
    { "type": "accordion", "title": "Changes (2 files)", "collapsed": true,
      "content": [{ "type": "diff", "path": "package.json", "text": "..." }]
    },
    { "type": "accordion", "title": "Commands & output", "collapsed": true,
      "content": [{ "type": "tool_output", "tool": "terminal", "command": "npm test", "exitCode": 0, "text": "..." }]
    }
  ]
}
```

---
 

[1]: https://developers.openai.com/api/docs/guides/tools-apply-patch/?utm_source=chatgpt.com "Apply patch | OpenAI API"
[2]: https://github.com/openai/codex/issues/12482?utm_source=chatgpt.com "Allow collapsing \"Edited File\" panel by default in VS Code ..."
[3]: https://openai.com/index/introducing-upgrades-to-codex/?utm_source=chatgpt.com "Introducing upgrades to Codex"
[4]: https://community.openai.com/t/feature-request-collapsible-code-blocks-in-chat/1358142?utm_source=chatgpt.com "Feature Request: Collapsible Code Blocks in Chat"
[5]: https://community.openai.com/t/feature-request-diff-preview-granular-accept-reject-workflow-in-openai-codex-vs-code-extension/1375304?utm_source=chatgpt.com "Feature request: Diff preview + granular accept/reject ..."



### UI Design (Codex-style, single panel)

## Single-panel Codex-style UI — Wireframe + Component Inventory (developer-ready)

### Assumptions (so devs can implement without ambiguity)

* One panel only (no sidebar).
* Message cards contain **always-visible summary + actions**, and **accordions** for details.
* Markdown-first rendering, with strict sanitization if HTML allowed.

---

# 1) Wireframes

## 1.1 Main screen (single panel)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Repo: myproj • master]   [Mode: Approve ▼]   [Model: GPT-…]   [⚙︎] [⤓Export]│
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  USER                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ "Refactor the build script and fix TS errors in src/app/main.ts"         │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ASSISTANT                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ Title: Proposed change                                                    │ │
│  │ Summary (max 3–7 lines):                                                  │ │
│  │ - Pin esbuild version and update tsconfig target.                         │ │
│  │ - Fix import paths in src/app/main.ts.                                    │ │
│  │                                                                           │ │
│  │ Actions: [Preview diff] [Open files] [Apply] [Run tests] [Copy summary]  │ │
│  │                                                                           │ │
│  │ ▸ Changes (2 files)                 (collapsed)                          │ │
│  │ ▸ Files referenced (3)               (collapsed)                          │ │
│  │ ▸ Commands & output (1)              (collapsed)                          │ │
│  │ ▸ Explanation                         (collapsed)                         │ │
│  │ ▸ Trace (inspected files, tools)      (collapsed)                         │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  TOOL OUTPUT (collapsed inline card appears only if expanded)                 │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Composer:                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ Type a message…  (/edit /test /refactor)                                 │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│  [Attach] [Include selection □]                              [Send] [Stop]   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Default behavior

* Only **Summary + Actions + collapsed accordions** are visible.
* “Apply” is **disabled until** user opens “Changes (Diff)” at least once (recommended).

---

## 1.2 Expanded “Changes (Diff)” section (per-file sub-accordions)

```
▾ Changes (2 files)

  ▾ Modified · src/app/main.ts                           [Open] [Apply file]
    View: (● Unified) (○ Side-by-side)   [Apply selected hunks] [Reject all]
    ┌──────────────────────────────────────────────────────────────────────┐
    │ @@ -12,7 +12,10 @@                                                    │
    │ - import { foo } from "../lib";                                       │
    │ + import { foo } from "../lib/index";                                 │
    │ + import type { Bar } from "../types";                                │
    │                                                                      │
    │   export function run() {                                             │
    │ -   return foo();                                                     │
    │ +   return foo(/* ... */);                                            │
    │   }                                                                  │
    └──────────────────────────────────────────────────────────────────────┘
    Hunks:
      [✓] Hunk 1  (3 additions, 1 deletion)  [Apply hunk] [Reject hunk]
      [ ] Hunk 2  (… )                        [Apply hunk] [Reject hunk]

  ▸ Modified · package.json                                   [Open] [Apply file]
```

### Optional “Before / After” (not default)

* Toggle inside file diff: `[View full Before] [View full After]`
* Opens an inline tabbed viewer (collapsed by default).

---

## 1.3 Expanded “Files referenced” section (file pills + preview)

```
▾ Files referenced (3)

  📄 src/app/main.ts:120:9      [Open] [Preview] [Copy path]
  📄 src/lib/index.ts           [Open] [Preview] [Copy path]
  📄 package.json               [Open] [Preview] [Copy path]

  (when Preview is clicked)
  ┌──────────────────────────────────────────────────────────────────────┐
  │ src/app/main.ts (around L120)                                         │
  │ 118 | function x() {                                                  │
  │ 119 |   ...                                                          │
  │ 120 |   return foo();                                                 │
  │ 121 | }                                                               │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## 1.4 Expanded “Commands & output” section (tool cards)

```
▾ Commands & output (1)

  ▾ Terminal · npm test           Exit: 0   Time: 12.4s     [Copy] [Re-run]
    ┌──────────────────────────────────────────────────────────────────────┐
    │ > myproj@ test                                                      │
    │ > vitest run                                                        │
    │  ✓ 42 tests passed                                                  │
    └──────────────────────────────────────────────────────────────────────┘
```

---

## 1.5 Expanded “Explanation” section (Markdown, compact)

* Renders Markdown with headings/bullets.
* Avoid long paragraphs; if long, auto-collapse subsections.

---

## 1.6 Expanded “Trace” section (evidence, not reasoning dumps)

```
▾ Trace

  Inspected:
   - 📄 src/app/main.ts
   - 📄 tsconfig.json
   - 📄 package.json

  Actions proposed:
   - Patch: 2 files modified
   - Commands suggested: npm test

  Notes:
   - No destructive changes
```

---

# 2) Component inventory (with specs)

## 2.1 `TopBar`

**Purpose:** global context + mode/model + settings.
**Props:**

* `repoLabel`, `branch`, `workspaceRoot`
* `mode` enum: `READ_ONLY | APPROVE | AUTO`
* `modelLabel`
* callbacks: `onModeChange`, `onSettings`, `onExport`

**UX rules:**

* Mode explains safety level:

  * **Approve** = show diffs, require user apply
  * **Auto** = requires explicit enable + clear indicator

---

## 2.2 `MessageList` (virtualized)

**Purpose:** smooth long chats.
**Rules:**

* Virtualize messages (windowing).
* Preserve scroll position on streaming.

---

## 2.3 `MessageCard`

**Slots (in order):**

1. `Header`: role badge + optional timestamp
2. `Title` (optional)
3. `SummaryBlock` (always visible, max height)
4. `PrimaryActionsRow` (always visible)
5. `AccordionGroup` (default collapsed)
6. `FeedbackRow` (optional): thumbs, “report issue”

**Props:**

* `role`: user/assistant/tool/system
* `blocks`: array of typed blocks (see schema below)
* `collapsedState` persisted per message

**Default collapse policy (strong):**

* Only show SummaryBlock expanded.
* Accordions collapsed.

---

## 2.4 `SummaryBlock`

**Goal:** minimal info.
**Rules:**

* Clamp to ~7 lines with “Expand summary” if longer.
* Prefer bullets; if assistant returns long prose, render and clamp.

---

## 2.5 `PrimaryActionsRow`

**Buttons (contextual):**

* `Preview diff` (visible if diff exists)
* `Open files` (visible if file refs exist)
* `Apply` (visible if diff exists)
* `Run tests` (visible if command exists)
* `Copy` (summary or whole response)

**Rules:**

* `Apply` disabled until `Preview diff` opened once (recommended).
* If destructive edits: show `Apply` -> confirmation modal.

---

## 2.6 `AccordionGroup` + `AccordionItem`

**Common items:**

* Changes (Diff)
* Files referenced
* Commands & output
* Explanation
* Trace

**Rules:**

* Expand/collapse animation subtle.
* Persist per-message state.

---

## 2.7 `FilePill`

**Renders file references as clickable pills.**
**Accepted syntaxes (auto-detected):**

* `src/app/main.ts`
* `src/app/main.ts:120:9`
* `src/app/main.ts#L120-L145`
* internal URIs:

  * `repo://<repo-id>/src/app/main.ts#L120-L145`
  * `file:///abs/path#L120`
  * `vscode://file/<abs>:120:9`

**Interactions:**

* Click: open file at location
* Hover: quick preview + actions (Open, Copy path, Reveal, Open diff)

---

## 2.8 `CodeBlock`

**Rendering:**

* Dark background container
* Language badge
* Copy button
* Wrap toggle
* Optional line numbers

**Auto-collapse:**

* > 30 lines: collapsed by default with “Expand (N lines)”
* Provide “Expand all code blocks” at message level

---

## 2.9 `DiffViewer`

**Modes:**

* Unified (default)
* Side-by-side (toggle)

**Features:**

* Per-file header (status badge)
* Hunk boundaries + hunk actions:

  * Apply hunk / Reject hunk
* “Apply file” action
* Optional “View full Before/After” (tabs), collapsed by default

**Safety rules:**

* Applying diff requires explicit user action.
* Delete/rename triggers confirmation modal.

---

## 2.10 `ToolOutputCard`

**Fields:**

* tool name (Terminal/Test/Search)
* command
* exit code badge
* duration
* output text (monospace)
* actions: Copy, Re-run

**Collapse:**

* Default collapsed under Commands & output.

---

## 2.11 `Composer`

**Features:**

* Multiline input
* Attachments
* “Include selection” toggle (IDE integration)
* Send/Stop/Regenerate
* Slash commands hints: `/edit /test /explain /refactor`

**Keyboard:**

* `Enter` send (configurable)
* `Shift+Enter` newline
* `Ctrl/Cmd+K` focus composer

---

# 3) Minimal block schema (frontend contract)

```json
{
  "messageId": "m1",
  "role": "assistant",
  "title": "Proposed change",
  "summary": [
    "Pin esbuild and update tsconfig target.",
    "Fix import paths in src/app/main.ts."
  ],
  "primaryActions": ["preview_diff", "open_files", "apply", "run_tests", "copy"],
  "accordions": [
    { "id": "changes", "title": "Changes (2 files)", "collapsed": true,
      "content": [{ "type": "diff", "path": "src/app/main.ts", "text": "..." }]
    },
    { "id": "files", "title": "Files referenced (3)", "collapsed": true,
      "content": [{ "type": "file_ref", "path": "src/app/main.ts", "line": 120, "col": 9 }]
    },
    { "id": "tools", "title": "Commands & output (1)", "collapsed": true,
      "content": [{ "type": "tool_output", "tool": "terminal", "command": "npm test", "exitCode": 0, "text": "..." }]
    },
    { "id": "explanation", "title": "Explanation", "collapsed": true,
      "content": [{ "type": "markdown", "text": "..." }]
    },
    { "id": "trace", "title": "Trace", "collapsed": true,
      "content": [{ "type": "trace", "inspected": ["..."], "proposed": ["..."] }]
    }
  ]
}
```

---

# 4) Default policies (to keep it Codex-like and minimal)

## 4.1 What’s visible by default

* Summary + actions row only.

## 4.2 What’s collapsed by default

* Diffs, tool output, long code, explanation, trace.

## 4.3 When to force expansion

* If an action is blocked:

  * User clicks Apply → if diff not previewed, auto-expand “Changes” and scroll to it.

---

# 5) Acceptance criteria (fast QA checklist)

* File references become clickable pills and open at correct line.
* Code blocks render with dark background + copy, and collapse when long.
* Diffs are previewable per file, with hunk-level apply/reject.
* “Apply” is not automatic; explicit user action required.
* Everything stays in **one panel**; accordions provide drill-down.
* Long chats remain smooth (virtualization).

---

##Typescript types for the frontend components:
// ============================================================
// Codex-style Single-Panel Chat UI — TypeScript Props Tables
// (React-friendly, framework-agnostic types)
// ============================================================

/** Basic helpers */
export type ISODateString = string;

export type ThemeMode = "light" | "dark" | "system";

export type AssistantMode = "READ_ONLY" | "APPROVE" | "AUTO";

export type Role = "user" | "assistant" | "tool" | "system";

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export type DiffViewMode = "unified" | "split";

export type ToolKind = "terminal" | "tests" | "search" | "linter" | "git" | "custom";

export type PrimaryAction =
  | "preview_diff"
  | "open_files"
  | "apply"
  | "run_tests"
  | "copy"
  | "regenerate"
  | "stop";

export type ComposerCommand =
  | "/edit"
  | "/test"
  | "/refactor"
  | "/explain"
  | "/fix"
  | "/plan"
  | "/summarize";

export type KeyChord = string; // e.g. "Ctrl+K", "Cmd+Enter"

/** Common callback types */
export type VoidFn = () => void;

export type AsyncVoidFn = () => Promise<void>;

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

/** File reference */
export interface FileRef {
  /** repo-relative or absolute path */
  path: string;
  /** 1-based line */
  line?: number;
  /** 1-based col */
  col?: number;
  /** range support */
  endLine?: number;
  endCol?: number;
  /** stable internal URI if you have one */
  uri?: string; // repo://id/path#Lx-Ly, file:///abs#Lx, vscode://...
}

/** File open options */
export interface OpenFileOptions {
  /** open in same view or modal/preview */
  target?: "editor" | "preview";
  /** if true, focus the editor after open */
  focus?: boolean;
}

/** Code block */
export interface CodeBlockData {
  language?: string; // "ts", "python", "sql", ...
  code: string;
  /** optional filename hint */
  fileHint?: string;
}

/** Tool output */
export interface ToolOutputData {
  tool: ToolKind;
  label?: string; // e.g. "Terminal", "Vitest", "Ripgrep"
  command?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  output: string;
  truncated?: boolean;
}

/** Diff model */
export interface DiffHunk {
  id: string; // stable id from backend or hash
  header?: string; // @@ -a,b +c,d @@
  /** unified diff lines including +/-/ context */
  lines: string[];
  /** summary for the hunk, precomputed if you want */
  stats?: { additions: number; deletions: number };
  /** whether this hunk is selected (for apply selected hunks) */
  selected?: boolean;
}

export interface FileDiff {
  path: string;
  status: FileChangeStatus;
  /** if renamed */
  previousPath?: string;
  /** optional: raw unified diff text for the whole file */
  unifiedText?: string;
  /** preferred: structured hunks */
  hunks?: DiffHunk[];
  /** optional “before/after” snapshots for full view */
  beforeText?: string;
  afterText?: string;
}

/** Trace (evidence, not chain-of-thought) */
export interface TraceData {
  inspectedFiles?: FileRef[];
  proposedActions?: string[];
  commandsSuggested?: string[];
  notes?: string[];
}

/** Generic accordion model */
export interface AccordionItemModel<T = unknown> {
  id: string;
  title: string;
  collapsed: boolean;
  /** optional count badge */
  count?: number;
  /** optional subtitle, e.g., "Exit: 0 · 12.4s" */
  meta?: string;
  /** typed payload or render via children */
  data?: T;
  /** if true, item can’t be collapsed (rare) */
  lockOpen?: boolean;
}

/** Message blocks (optional if you prefer a fully structured renderer) */
export type MessageBlock =
  | { type: "markdown"; markdown: string }
  | { type: "file_ref"; file: FileRef }
  | { type: "code"; block: CodeBlockData }
  | { type: "diff"; diffs: FileDiff[] }
  | { type: "tool_output"; toolOutput: ToolOutputData }
  | { type: "trace"; trace: TraceData };

/** Message model */
export interface ChatMessage {
  id: string;
  role: Role;
  createdAt?: ISODateString;
  title?: string;
  /** minimal default-visible summary lines */
  summary?: string[];
  /** optional raw markdown for main visible body (clamped) */
  bodyMarkdown?: string;
  /** structured blocks for accordions or main body */
  blocks?: MessageBlock[];
  /** top-row actions shown on the card */
  primaryActions?: PrimaryAction[];
  /** accordion models (preferred for single-panel UI) */
  accordions?: AccordionItemModel[];
  /** flags for safety UX */
  hasDiff?: boolean;
  hasFileRefs?: boolean;
  hasCommands?: boolean;
  /** used to enforce “preview before apply” */
  diffPreviewed?: boolean;
}

/* ============================================================
   1) TopBar
   ============================================================ */

export interface TopBarProps {
  repoLabel?: string; // e.g., "myproj"
  branchLabel?: string; // e.g., "master"
  workspaceRootLabel?: string; // e.g., "/home/me/myproj"
  mode: AssistantMode;
  modelLabel: string; // e.g., "GPT-5.2"
  themeMode?: ThemeMode;

  onModeChange?: (mode: AssistantMode) => void;
  onOpenSettings?: VoidFn;
  onExport?: VoidFn;
  onClearConversation?: VoidFn;

  /** compact badges: tools enabled, read-only, etc. */
  badges?: Array<{ id: string; label: string; tone?: "neutral" | "info" | "warn" }>;
}

/* ============================================================
   2) MessageList
   ============================================================ */

export interface MessageListProps {
  messages: ChatMessage[];
  /** stable height container uses virtualization */
  virtualized?: boolean;
  /** called when user scrolls to top for pagination */
  onReachTop?: AsyncVoidFn;
  /** called when clicking a message (optional) */
  onMessageFocus?: (messageId: string) => void;

  /** rendering hooks */
  renderMessage?: (msg: ChatMessage) => React.ReactNode;

  /** auto-scroll behavior */
  autoScroll?: "always" | "smart" | "never";
}

/* ============================================================
   3) MessageCard
   ============================================================ */

export interface MessageCardProps {
  message: ChatMessage;

  /** clamp summary/body to keep UI minimal */
  clampLines?: number; // default ~7
  /** persist per-message UI state */
  collapsedState?: Record<string, boolean>; // accordion id -> collapsed
  onCollapsedStateChange?: (messageId: string, state: Record<string, boolean>) => void;

  /** primary actions */
  onPrimaryAction?: (messageId: string, action: PrimaryAction) => void;

  /** file and diff actions (plumbed down) */
  onOpenFile?: (file: FileRef, opts?: OpenFileOptions) => void;
  onCopyText?: (text: string) => void;

  /** safety gating */
  requireDiffPreviewBeforeApply?: boolean; // default true
  onRequirePreview?: (messageId: string) => void;

  /** optional: custom renderers */
  renderSummary?: (message: ChatMessage) => React.ReactNode;
  renderAccordions?: (message: ChatMessage) => React.ReactNode;
}

/* ============================================================
   4) SummaryBlock
   ============================================================ */

export interface SummaryBlockProps {
  /** Either provide summary lines or markdown */
  summaryLines?: string[];
  markdown?: string;

  clampLines?: number; // default ~7
  expanded?: boolean;
  onToggleExpanded?: (expanded: boolean) => void;

  /** optional copy */
  onCopy?: (text: string) => void;
}

/* ============================================================
   5) PrimaryActionsRow
   ============================================================ */

export interface PrimaryActionsRowProps {
  actions: PrimaryAction[];
  disabledActions?: Partial<Record<PrimaryAction, boolean>>;
  tooltips?: Partial<Record<PrimaryAction, string>>;

  onAction: (action: PrimaryAction) => void;

  /** small/compact layout variant */
  density?: "compact" | "normal";
}

/* ============================================================
   6) AccordionGroup + AccordionItem
   ============================================================ */

export interface AccordionGroupProps {
  items: AccordionItemModel[];
  /** allow multiple open */
  multiple?: boolean; // default true
  /** persist collapsed state externally */
  onChange?: (next: AccordionItemModel[]) => void;

  /** render content by id */
  renderItemContent: (item: AccordionItemModel) => React.ReactNode;
}

export interface AccordionItemProps {
  item: AccordionItemModel;
  onToggle?: (id: string, collapsed: boolean) => void;
  /** optional right-side buttons in header */
  headerActions?: React.ReactNode;
  children?: React.ReactNode;
}

/* ============================================================
   7) FilePill
   ============================================================ */

export interface FilePillProps {
  file: FileRef;

  /** UI behavior */
  showIcon?: boolean; // default true
  showLineCol?: boolean; // default true
  variant?: "pill" | "inline";

  /** actions */
  onOpen: (file: FileRef) => void;
  onPreview?: (file: FileRef) => void;
  onCopyPath?: (path: string) => void;
  onRevealInTree?: (file: FileRef) => void;
  onOpenDiff?: (file: FileRef) => void;

  /** preview support */
  previewProvider?: (file: FileRef) => Promise<{ text: string; startLine?: number }>;
}

/* ============================================================
   8) CodeBlock
   ============================================================ */

export interface CodeBlockProps {
  block: CodeBlockData;

  /** display */
  showLineNumbers?: boolean; // default: true if >12 lines
  wrap?: boolean; // default false
  maxCollapsedLines?: number; // default 30
  collapsedByDefault?: boolean; // default true if > maxCollapsedLines

  /** actions */
  onCopy?: (code: string) => void;
  onInsertAtCursor?: (code: string) => void; // IDE integration
  onSaveAsFile?: (block: CodeBlockData) => void;

  /** analytics hooks */
  onToggleExpand?: (expanded: boolean) => void;
}

/* ============================================================
   9) DiffViewer
   ============================================================ */

export interface DiffViewerProps {
  diffs: FileDiff[];

  /** view configuration */
  viewMode?: DiffViewMode; // default "unified"
  allowSplitView?: boolean; // default true
  showHunkControls?: boolean; // default true

  /** safety + UX */
  requireConfirmationForDestructive?: boolean; // default true
  confirm?: ConfirmFn;

  /** actions */
  onOpenFile?: (file: FileRef) => void;
  onApplyFile?: (path: string) => Promise<void>;
  onRevertFile?: (path: string) => Promise<void>;

  onApplyHunk?: (path: string, hunkId: string) => Promise<void>;
  onRejectHunk?: (path: string, hunkId: string) => void;

  onApplySelectedHunks?: (path: string, hunkIds: string[]) => Promise<void>;

  /** toggles for full snapshots */
  allowBeforeAfter?: boolean; // default true
  onViewBefore?: (path: string) => void;
  onViewAfter?: (path: string) => void;

  /** optional: called once user has previewed diffs */
  onPreviewed?: () => void;
}

/* ============================================================
   10) ToolOutputCard
   ============================================================ */

export interface ToolOutputCardProps {
  data: ToolOutputData;

  collapsed?: boolean;
  onToggleCollapsed?: (collapsed: boolean) => void;

  /** actions */
  onCopy?: (text: string) => void;
  onRerun?: (data: ToolOutputData) => Promise<void>;
}

/* ============================================================
   11) MarkdownRenderer
   ============================================================ */

export interface MarkdownRendererProps {
  markdown: string;

  /** security */
  allowHtml?: boolean; // default false
  sanitizeHtml?: boolean; // default true if allowHtml

  /** custom link handling */
  onLinkClick?: (href: string) => void;

  /** file auto-linking */
  enableFileAutolink?: boolean; // default true
  onFileClick?: (file: FileRef) => void;

  /** code blocks override */
  renderCodeBlock?: (block: CodeBlockData) => React.ReactNode;
}

/* ============================================================
   12) Composer
   ============================================================ */

export interface ComposerAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  /** optional content for small files */
  text?: string;
  /** optional path if attached from workspace */
  file?: FileRef;
}

export interface ComposerProps {
  value: string;
  placeholder?: string;

  /** state */
  disabled?: boolean;
  isStreaming?: boolean;

  /** toggles */
  includeSelection?: boolean;
  onIncludeSelectionChange?: (v: boolean) => void;

  /** attachments */
  attachments?: ComposerAttachment[];
  onAttach?: (files: File[]) => Promise<void>;
  onRemoveAttachment?: (id: string) => void;

  /** send/stop */
  onSend: (text: string, opts?: { includeSelection?: boolean }) => Promise<void>;
  onStop?: VoidFn;
  onRegenerate?: VoidFn;

  /** slash commands */
  commands?: ComposerCommand[];
  onCommandSelect?: (cmd: ComposerCommand) => void;

  /** keyboard shortcuts */
  shortcuts?: Partial<Record<"focus" | "send" | "newline", KeyChord>>;
}

/* ============================================================
   13) App Shell (single panel)
   ============================================================ */

export interface SinglePanelChatAppProps {
  topBar: TopBarProps;

  messageList: Omit<MessageListProps, "renderMessage">;

  /** default card renderer */
  renderMessage?: (msg: ChatMessage) => React.ReactNode;

  composer: ComposerProps;

  /** global policies */
  policies?: {
    clampSummaryLines?: number; // default 7
    collapseLongCodeAboveLines?: number; // default 30
    requireDiffPreviewBeforeApply?: boolean; // default true
    defaultAccordionsCollapsed?: boolean; // default true
  };
}

