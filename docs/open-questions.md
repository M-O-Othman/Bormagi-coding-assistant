# Open Questions — Meeting Agent Behavior Improvements

## All Answered ✅

### Q1: @mention interrupts — Real inline interrupts ✅
Extract the question/information request from the requestor's response, then invoke the mentioned agent with that extracted question as context. The mentioned agent responds immediately and control returns to the round-robin.

### Q2: Agent skipping — `[SKIP]` token ✅
Agents respond with `[SKIP]` when they have nothing material to add. Orchestrator hides the skip from the UI and saves tokens.

### Q3: Agenda progression — Human-driven with LLM summary ✅
Each round completes, the moderator LLM summarizes the discussion, then the human decides to continue, override, or mark resolved. Human input can override agent decisions/options.

### Q4: Inline minutes — Append each response + final summary ✅
Append each agent response to minutes as it arrives. Add a full meeting summary + action items section at the end when the meeting concludes.
