the meeting ended up like  talkshop , please apply the following modification to the agent behviour :  **round-robin + interrupt** meeting protocol that forces useful outcomes while keeping the **human as the decision maker** and pushing unknowns into your **Open Questions file**. or asked for human to provide information inline in the call

## Inputs the orchestrator must provide to every agent (per meeting + per agenda item)

**Meeting header (always present)**

* Meeting purpose (from invite)
* Agenda items (IDs + titles + desired outputs per item, if provided)
* Participants in this meeting (names + roles)
* “Human decider” identity (explicit)
* Link/path to Open Questions file (e.g., `Open_questions/open_questions.md`)
* Definition of “impactful”: changes a requirement, constraint, risk, interface, acceptance criteria, or decision options.

**Per agenda item context**

* Current agenda item ID + title
* Current known constraints/assumptions
* Current draft options (if any)
* Last moderator summary for this item (structured)

## Universal agent rules (the main fix)

### 1) Speak only in **one of these output types**

Every message must start with exactly one tag:

* `RECOMMENDATION:` (option + rationale + tradeoffs; *human decides*)
* `RISK:` (risk + impact + mitigation)
* `OPEN_QUESTION:` (must be moved to Open Questions file)
* `ACTION:` (task proposal; owner role; acceptance criteria)
* `VALIDATION:` (confirm/deny claim; how to verify)
* `CLARIFICATION_FOR_HUMAN:` (only if human must answer to proceed)
* `[SKIP]:` (no impactful contribution)

If an agent cannot produce one of the above: **must `[SKIP]`**.

### 2) Ban “talkshop language”

Hard forbid:

* greetings/thanks (“Thank you…”, “Building on…”)
* paraphrasing prior speakers unless correcting a mistake
* generic best practices not tied to a concrete output

### 3) Structured content (so it’s actionable)

* Use bullets.
* If `OPEN_QUESTION:` include:

  * **Question**
  * **Why it matters / what it blocks**
  * **Example of an acceptable answer** (short)
* If `RECOMMENDATION:` include:

  * **Options** (A/B/C)
  * **Recommended option**
  * **Tradeoffs**
  * **What the human must decide**
* If `ACTION:` include:

  * **Owner role**
  * **Definition of Done (acceptance criteria)**

## Round-robin with “interrupt mic” (@mention) — exact protocol

### Allowed interrupt types (only two)

1. **Blocking question** to a specific role
2. **Targeted validation** (“confirm X is testable / correct / compatible”)

### How to request an interrupt (caller agent)

Caller includes inside their message:

`INTERRUPT_REQUEST: @AgentName — <one precise question> — Context: <1–2 lines>`

Rules:

* Max **2 interrupt requests** per turn.
* Must be **blocking** for caller’s output (recommendation/risk/action).
* If not blocking → convert into `OPEN_QUESTION:` instead.

### What the interrupted agent must do

Interrupted agent responds with exactly one tag:

* `VALIDATION:` or `RECOMMENDATION:` or `OPEN_QUESTION:` or `[SKIP]:`

Constraints:

* Must answer only the asked question.
* Must not introduce new agenda topics.
* Must be short and decisive.

### Orchestrator behavior (important)

* Interrupt response is inserted **inline** under the caller message as `↳ Interrupt response`.
* Interrupt does **not** consume or shift the interrupted agent’s upcoming turn in the round-robin.
* Caller may add a **1–3 line addendum** after receiving the interrupt: `ADDENDUM:` (optional).

## Human decision model (your requirement)

* Agents can only produce **recommendations + tradeoffs**, never “final decisions”.
* The moderator ends each agenda item with a **Decision Prompt** for the human:

**Decision Prompt (always the last part of item summary)**

* “Human decision required: choose Option A/B/C (or defer).”
* If defer: list what must be answered first (open questions).

## Moderator responsibilities (make it strict and closing)

You can keep “moderator = participants[0]” but enforce this output format.

After every agenda item (or after each full round if you prefer), the moderator emits:

`MODERATOR_SUMMARY:`

* **What we’re solving (1 line)**
* **Options presented**
* **Recommendation from agents (if any)**
* **Risks**
* **Actions proposed**
* **Open questions (with IDs/links)**
* **Decision prompt for human**

Moderator must also enforce:

* If an item loops: stop discussion, push unknowns to open questions, and produce decision prompt.

## Open Questions file integration (hard rule)

Whenever any agent outputs `OPEN_QUESTION:`, the orchestrator must:

* Append to `Open_questions/open_questions.md` using a stable template:

```md
### OQ-<auto-id>: <question>
- Agenda item: <id/title>
- Asked by: <agent>
- Why it matters: <blocker>
- Example acceptable answer: <example>
- Answer: <placeholder>
```

Also:

* Moderator summary must reference OQ IDs created during the item.

## Minimal changes to your current implementation plan (surgical)

1. **Add a “response type validator”** (tag must be one of the allowed tags; else reprompt to rewrite).
2. Enhance @mention interrupts to only trigger when message contains `INTERRUPT_REQUEST:` (prevents random @noise).
3. Expand `SummaryRound` to structured fields, not a paragraph:

```ts
interface SummaryRound {
  agendaItemId: string;
  problem: string;
  options: string[];
  recommendation?: string;
  risks: string[];
  actions: string[];
  openQuestionIds: string[];
  decisionPrompt: string;
  timestamp: string;
}
```

4. Add “open question append” function in storage (you already planned minutes append; do the same for OQ).

## Copy-paste system prompt block (for all agents)

Use this verbatim (edit the participant lists as needed):

**MEETING RULES (mandatory)**

* You are in a strict round-robin meeting. Speak only on your turn unless asked via `INTERRUPT_REQUEST`.
* Output must start with exactly one tag: `RECOMMENDATION:` `RISK:` `OPEN_QUESTION:` `ACTION:` `VALIDATION:` `CLARIFICATION_FOR_HUMAN:` `[SKIP]:`
* If you cannot add impactful content, output `[SKIP]: <one-line reason>`.
* Do not greet, thank, or paraphrase others. No generic advice.
* The human attendee makes the final decision. You only recommend options + tradeoffs.
* To briefly request input mid-turn, add: `INTERRUPT_REQUEST: @AgentName — <one precise question> — Context: <1–2 lines>`. Max 2 per turn; must be blocking.

I here is a sample implementation details
Below is an implementation-ready spec for **MeetingOrchestrator** that enforces:

* **Strict round-robin**
* **Inline interrupts** (mic briefly given to mentioned agent, then back)
* **Agents can skip**
* **Human is the decider** (agents only recommend)
* **Open questions appended to `Open_questions/open_questions.md`** automatically
* **Moderator produces structured summaries + a “decision prompt” per agenda item**

---

## 1) Data model changes (TypeScript)

### Core types

```ts
type AgentId = string;

type RoundKind = "turn" | "interrupt" | "moderator_summary";

type OutputTag =
  | "RECOMMENDATION"
  | "RISK"
  | "OPEN_QUESTION"
  | "ACTION"
  | "VALIDATION"
  | "CLARIFICATION_FOR_HUMAN"
  | "SKIP";

interface AgendaItem {
  id: string;
  title: string;
  desiredOutputs?: string[]; // optional hints
}

interface Meeting {
  id: string;
  purpose: string;                 // from invite
  agenda: AgendaItem[];
  participants: AgentId[];          // strict round robin order
  moderatorId: AgentId;             // participants[0]
  humanDeciderLabel: string;        // e.g. "Mohammed (Human)"
  openQuestionsFilePath: string;    // "Open_questions/open_questions.md"
  minutesFilePath: string;          // "minutes.md"
  rounds: MeetingRound[];
  summaryRounds: SummaryRound[];
  openQuestionsCreated: OpenQuestionRef[]; // optional index
}

interface MeetingRound {
  id: string;
  meetingId: string;
  agendaItemId: string;
  kind: RoundKind;
  agentId: AgentId;                 // speaker for turn/interrupt; moderator for summary
  triggeredBy?: AgentId;            // for interrupts
  createdAt: string;                // ISO
  rawResponse: string;
  tag: OutputTag;
  skipped?: boolean;
  interruptRequests?: InterruptRequest[];   // only for "turn"
  openQuestionsExtracted?: OpenQuestion[];  // parsed from response when tag=OPEN_QUESTION
}

interface InterruptRequest {
  mentionedAgentId: AgentId;
  question: string;                 // single precise question
  context?: string;                 // 1-2 lines
}

interface OpenQuestion {
  question: string;
  whyItMatters: string;
  exampleAnswer: string;
}

interface OpenQuestionRef {
  id: string;           // e.g. "OQ-00023"
  agendaItemId: string;
  askedBy: AgentId;
  question: string;
  filePath: string;
}

interface SummaryRound {
  agendaItemId: string;
  problem: string;            // 1 line
  options: string[];          // extracted from recs if possible
  recommendation?: string;    // summarized
  risks: string[];
  actions: string[];
  openQuestionIds: string[];
  decisionPrompt: string;     // explicit for human
  timestamp: string;
}
```

---

## 2) Storage API (MeetingStorage.ts)

You already have `appendMinutesLine`. Add:

```ts
interface MeetingStorage {
  appendMinutesLine(meetingId: string, line: string): Promise<void>;
  appendOpenQuestionBlock(meetingId: string, block: string): Promise<void>;
  nextOpenQuestionId(meetingId: string): Promise<string>; // returns "OQ-00023"
}
```

**Implementation notes**

* `nextOpenQuestionId`: simplest is to keep a counter in meeting state or scan file once at meeting start.
* `appendOpenQuestionBlock`: appends to `meeting.openQuestionsFilePath`.

---

## 3) Required UI callbacks (MeetingPanel + orchestrator interface)

Your `runRound` needs these callbacks (panel forwards to frontend):

```ts
interface MeetingRunCallbacks {
  onTurnStart?: (info: { agendaItemId: string; agentId: string }) => void;

  onDelta?: (info: { roundId: string; agendaItemId: string; agentId: string; delta: string }) => void;
  onDone?: (info: { round: MeetingRound }) => void;

  onSkip?: (info: { round: MeetingRound }) => void;

  onInterruptStart?: (info: { parentRoundId: string; agendaItemId: string; triggeredBy: string; agentId: string }) => void;
  onInterruptDelta?: (info: { roundId: string; agendaItemId: string; agentId: string; delta: string }) => void;
  onInterruptDone?: (info: { round: MeetingRound }) => void;

  onOpenQuestionCreated?: (info: { oqRef: OpenQuestionRef }) => void;

  onModeratorSummary?: (info: { agendaItemId: string; summary: SummaryRound }) => void;
}
```

---

## 4) System prompt injection (enforced contract)

At runtime, orchestrator builds each agent prompt with:

* meeting purpose
* agenda item context
* participants list + moderator
* human decider statement
* open questions file path
* the **tag-only** rule and interrupt syntax

This is the core enforcement mechanism (plus validation).

---

## 5) Parsing & validation utilities (must exist)

### 5.1 Tag parser

**Rule:** response must start with one of:

`RECOMMENDATION:` `RISK:` `OPEN_QUESTION:` `ACTION:` `VALIDATION:` `CLARIFICATION_FOR_HUMAN:` `[SKIP]:`

Implementation:

```ts
function parseTag(response: string): OutputTag | null
```

* Trim start.
* If starts with `[SKIP]` or `[SKIP]:` => tag = SKIP
* Else look for `^([A-Z_]+):`
* Map to allowed tags.

### 5.2 Interrupt request parser (strict)

Only trigger interrupts if response contains:

`INTERRUPT_REQUEST: @AgentName — <question> — Context: <text>`

Implementation:

```ts
function extractInterruptRequests(response: string, participants: AgentId[]): InterruptRequest[]
```

* Regex lines containing `INTERRUPT_REQUEST:`
* Parse `@X` and map to agentId (normalize: case-insensitive, allow hyphen/space)
* Split on `—`
* Return up to 2 requests

### 5.3 Open question extractor (only when tag=OPEN_QUESTION)

Require 3 fields:

* Question
* Why it matters / blocks
* Example acceptable answer

Implementation:

```ts
function parseOpenQuestionPayload(response: string): OpenQuestion | null
```

If missing fields → orchestrator reprompts: “Rewrite in required OPEN_QUESTION structure”.

---

## 6) Orchestrator core flow (high-level)

### 6.1 Run the meeting

```ts
async function runMeeting(meeting: Meeting, callbacks: MeetingRunCallbacks) {
  for (const item of meeting.agenda) {
    await runAgendaItem(meeting, item.id, callbacks);
  }
  // Optionally: final summary action items by moderator
}
```

### 6.2 Run one agenda item (strict round robin)

```ts
async function runAgendaItem(meeting: Meeting, agendaItemId: string, callbacks: MeetingRunCallbacks) {
  for (const agentId of meeting.participants) {
    await runAgentTurn(meeting, agendaItemId, agentId, callbacks);
  }
  const summary = await generateModeratorSummary(meeting, agendaItemId);
  meeting.summaryRounds.push(summary);
  callbacks.onModeratorSummary?.({ agendaItemId, summary });

  // append structured summary to minutes
  await appendSummaryToMinutes(meeting, summary);
}
```

---

## 7) The key function: `runAgentTurn` (turn + interrupts + OQ append)

### 7.1 Pseudocode (implementation-ready)

```ts
async function runAgentTurn(
  meeting: Meeting,
  agendaItemId: string,
  agentId: AgentId,
  callbacks: MeetingRunCallbacks
) {
  callbacks.onTurnStart?.({ agendaItemId, agentId });

  // 1) Build prompt
  const systemPrompt = buildAgentSystemPrompt(meeting, agentId);
  const userPrompt = buildAgendaItemPrompt(meeting, agendaItemId);

  // 2) Stream agent response
  const roundId = newId();
  let raw = "";

  callbacks.onDelta?.({ roundId, agendaItemId, agentId, delta: "" }); // optional kickoff

  raw = await streamLLM({
    agentId,
    systemPrompt,
    userPrompt,
    onDelta: (d) => callbacks.onDelta?.({ roundId, agendaItemId, agentId, delta: d })
  });

  // 3) Validate tag
  let tag = parseTag(raw);
  if (!tag) {
    raw = await forceRewriteToValidTag(agentId, systemPrompt, raw);
    tag = parseTag(raw) ?? "SKIP"; // fallback safe
  }

  // 4) Create round
  const round: MeetingRound = {
    id: roundId,
    meetingId: meeting.id,
    agendaItemId,
    kind: "turn",
    agentId,
    createdAt: new Date().toISOString(),
    rawResponse: raw,
    tag,
    skipped: tag === "SKIP"
  };

  // 5) If skip, record + notify + append minimal minutes line
  if (round.skipped) {
    meeting.rounds.push(round);
    callbacks.onSkip?.({ round });
    await meetingStorage.appendMinutesLine(meeting.id, formatSkipLine(meeting, agendaItemId, agentId, raw));
    callbacks.onDone?.({ round });
    return;
  }

  // 6) If OPEN_QUESTION, extract + append to OQ file with ID
  if (tag === "OPEN_QUESTION") {
    const oq = parseOpenQuestionPayload(raw);
    if (!oq) {
      const rewritten = await forceRewriteOpenQuestion(agentId, systemPrompt, raw);
      round.rawResponse = rewritten;
    }
    const oqFinal = parseOpenQuestionPayload(round.rawResponse) ?? {
      question: extractBestEffortQuestion(round.rawResponse),
      whyItMatters: "Not provided (needs clarification).",
      exampleAnswer: "Provide a concrete answer that unblocks implementation."
    };

    const oqId = await meetingStorage.nextOpenQuestionId(meeting.id);
    const block = renderOpenQuestionMarkdown({
      oqId,
      agendaItemId,
      askedBy: agentId,
      openQuestion: oqFinal
    });

    await meetingStorage.appendOpenQuestionBlock(meeting.id, block);

    const oqRef: OpenQuestionRef = {
      id: oqId,
      agendaItemId,
      askedBy: agentId,
      question: oqFinal.question,
      filePath: meeting.openQuestionsFilePath
    };

    meeting.openQuestionsCreated.push(oqRef);
    round.openQuestionsExtracted = [oqFinal];
    callbacks.onOpenQuestionCreated?.({ oqRef });
  }

  // 7) Interrupt requests (only if explicitly present)
  const requests = extractInterruptRequests(round.rawResponse, meeting.participants);
  round.interruptRequests = requests;

  // 8) Persist turn round + append to minutes
  meeting.rounds.push(round);
  await meetingStorage.appendMinutesLine(meeting.id, formatTurnLine(meeting, agendaItemId, agentId, round.rawResponse));
  callbacks.onDone?.({ round });

  // 9) Handle interrupts inline (do NOT change round robin)
  for (const req of requests) {
    await runInterrupt(meeting, agendaItemId, agentId, req, callbacks);
  }
}
```

---

## 8) Interrupt execution (inline mic handoff)

```ts
async function runInterrupt(
  meeting: Meeting,
  agendaItemId: string,
  triggeredBy: AgentId,
  req: InterruptRequest,
  callbacks: MeetingRunCallbacks
) {
  const agentId = req.mentionedAgentId;
  const roundId = newId();

  callbacks.onInterruptStart?.({ parentRoundId: "n/a", agendaItemId, triggeredBy, agentId });

  let raw = await streamLLM({
    agentId,
    systemPrompt: buildAgentSystemPrompt(meeting, agentId),
    userPrompt: buildInterruptPrompt(meeting, agendaItemId, triggeredBy, req),
    onDelta: (d) => callbacks.onInterruptDelta?.({ roundId, agendaItemId, agentId, delta: d })
  });

  // Validate tag (interrupt still must comply)
  let tag = parseTag(raw);
  if (!tag) {
    raw = await forceRewriteToValidTag(agentId, buildAgentSystemPrompt(meeting, agentId), raw);
    tag = parseTag(raw) ?? "SKIP";
  }

  const round: MeetingRound = {
    id: roundId,
    meetingId: meeting.id,
    agendaItemId,
    kind: "interrupt",
    agentId,
    triggeredBy,
    createdAt: new Date().toISOString(),
    rawResponse: raw,
    tag,
    skipped: tag === "SKIP"
  };

  meeting.rounds.push(round);

  // If OPEN_QUESTION in interrupt: append as well (same logic)
  if (tag === "OPEN_QUESTION") {
    const oq = parseOpenQuestionPayload(raw);
    const oqFinal = oq ?? {
      question: extractBestEffortQuestion(raw),
      whyItMatters: "Not provided (needs clarification).",
      exampleAnswer: "Provide a concrete answer that unblocks implementation."
    };
    const oqId = await meetingStorage.nextOpenQuestionId(meeting.id);
    await meetingStorage.appendOpenQuestionBlock(meeting.id, renderOpenQuestionMarkdown({ oqId, agendaItemId, askedBy: agentId, openQuestion: oqFinal }));
    const oqRef: OpenQuestionRef = { id: oqId, agendaItemId, askedBy: agentId, question: oqFinal.question, filePath: meeting.openQuestionsFilePath };
    meeting.openQuestionsCreated.push(oqRef);
    callbacks.onOpenQuestionCreated?.({ oqRef });
  }

  await meetingStorage.appendMinutesLine(meeting.id, formatInterruptLine(meeting, agendaItemId, triggeredBy, agentId, raw));

  callbacks.onInterruptDone?.({ round });
}
```

**Interrupt prompt (important)**

* Include the caller question
* Force the responder to only answer that question
* Force one-tag output
* Encourage `[SKIP]` if not sure / not impactful

---

## 9) Moderator summary generation (structured + decision prompt)

### When to generate

Given your strict RR, best is:

* **After the full round-robin completes for the agenda item** (recommended)
* Optional: also after each “round” across agents if you run multiple rounds per item (but your current design looks like 1 pass per item)

### Summary function

```ts
async function generateModeratorSummary(meeting: Meeting, agendaItemId: string): Promise<SummaryRound> {
  const moderatorId = meeting.moderatorId;

  const context = collectRoundsForAgendaItem(meeting, agendaItemId);

  const raw = await callLLM({
    agentId: moderatorId,
    systemPrompt: buildModeratorSystemPrompt(meeting),
    userPrompt: buildModeratorSummaryPrompt(meeting, agendaItemId, context),
  });

  // Parse into SummaryRound structure. If parsing fails, store best-effort.
  return parseSummaryRound(raw, meeting, agendaItemId);
}
```

### Moderator summary prompt MUST enforce structure

Require the model output as strict sections (easy parse):

```
MODERATOR_SUMMARY:
Problem: <1 line>
Options:
- A: ...
- B: ...
Recommendation:
- ...
Risks:
- ...
Actions:
- ...
OpenQuestions:
- OQ-xxxxx ...
DecisionPromptForHuman: <explicit choice request>
```

Then parse by section headers.

---

## 10) Minutes formatting (simple, consistent)

**Turn line**

```md
### <AgentId> (Turn)
<Tag>: ...
```

**Interrupt line**

```md
↳ <AgentId> (Interrupt responding to @<TriggeredBy>)
<Tag>: ...
```

**Skip line**

```md
- <AgentId> skipped: <reason>
```

**Agenda item summary**

```md
## Agenda Item: <title>

### Moderator Summary
Problem: ...
Options:
- ...
Recommendation: ...
Risks:
- ...
Actions:
- ...
Open Questions:
- OQ-...
Decision prompt (Human): ...
```

---

## 11) Enforcement: rewrite-on-violation (mandatory)

To prevent talkshop, add a “rewrite gate”:

### Gate conditions (if any true → rewrite)

* No valid tag at start
* Tag is valid but content violates required structure:

  * `OPEN_QUESTION` missing fields
  * `ACTION` missing Owner or Done-when
  * `RECOMMENDATION` missing options or “what human must decide”
* Contains forbidden phrases (optional but effective):

  * “thank you”, “building on”, “I agree”, “great point”

### Rewrite prompt

“Rewrite your message to comply with meeting rules. Keep only impactful content. No greetings. Start with exactly one tag…”

---

## 12) Minimal file-level changes you need

* `MeetingOrchestrator.ts`: implement `runAgendaItem`, `runAgentTurn`, `runInterrupt`, `generateModeratorSummary`, validators, and storage appends.
* `MeetingStorage.ts`: add `appendOpenQuestionBlock`, `nextOpenQuestionId`.
* `MeetingPanel.ts`: handle new callbacks and render:

  * skip as collapsed indicator
  * interrupt styled inline
  * moderator summary card per agenda item

-