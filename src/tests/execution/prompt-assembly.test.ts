/**
 * Tests for Phase 1: PromptAssembler — compact, no-history LLM message assembly.
 * Verifies that assembled messages contain 0 prior conversation turns,
 * correct ordering, sanitised content, and appropriate workspace summaries.
 */
import { PromptAssembler, buildWorkspaceSummary, type PromptContext } from '../../agents/execution/PromptAssembler';
import type { ChatMessage } from '../../types';

const makeAssembler = () => new PromptAssembler({
  executionStateHeader: '[Execution State — resume context]',
  workspaceHeader: '[Workspace]',
  milestoneSummaryPrefix: 'Prior milestone: ',
});

const baseContext = (): PromptContext => ({
  systemPrompt: 'You are an expert coder.',
  executionStateSummary: 'Objective: build a thing\nIterations: 0',
  workspaceSummary: '[Greenfield] No project scaffold yet.',
  currentInstruction: 'Create package.json',
  currentStepToolResults: [],
});

describe('PromptAssembler — assembleMessages', () => {
  test('first message is the stable system prompt', () => {
    const assembler = makeAssembler();
    const msgs = assembler.assembleMessages(baseContext());
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are an expert coder.' });
  });

  test('returns 0 prior conversation turns in code mode (no history replay)', () => {
    const assembler = makeAssembler();
    const msgs = assembler.assembleMessages(baseContext());
    // Allowed: system, system (state), system (workspace), user (instruction)
    // No assistant turns from prior iterations, no prior user turns
    const nonSystemNonCurrent = msgs.filter(
      m => m.role === 'assistant' || (m.role === 'user' && m.content !== 'Create package.json')
    );
    expect(nonSystemNonCurrent).toHaveLength(0);
  });

  test('execution state summary injected as second system message', () => {
    const assembler = makeAssembler();
    const msgs = assembler.assembleMessages(baseContext());
    const stateMsg = msgs.find(m => m.role === 'system' && m.content.includes('[Execution State'));
    expect(stateMsg).toBeDefined();
    expect(stateMsg!.content).toContain('Objective: build a thing');
  });

  test('workspace summary injected as system message', () => {
    const assembler = makeAssembler();
    const msgs = assembler.assembleMessages(baseContext());
    const wsMsg = msgs.find(m => m.role === 'system' && m.content.includes('[Workspace]'));
    expect(wsMsg).toBeDefined();
    expect(wsMsg!.content).toContain('Greenfield');
  });

  test('current instruction appears as user message', () => {
    const assembler = makeAssembler();
    const msgs = assembler.assembleMessages(baseContext());
    const userMsg = msgs.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('Create package.json');
  });

  test('current-step tool results appear after the user instruction', () => {
    const assembler = makeAssembler();
    const toolResult: ChatMessage = { role: 'tool_result', content: 'File created: package.json', toolCallId: 'tr-1' };
    const ctx = { ...baseContext(), currentStepToolResults: [toolResult] };
    const msgs = assembler.assembleMessages(ctx);
    const userIdx = msgs.findIndex(m => m.role === 'user');
    expect(userIdx).toBeGreaterThan(-1);
    // tool_result role is converted to user role (API only accepts system/user/assistant/tool)
    expect(msgs[userIdx + 1]).toEqual({ role: 'user', content: 'File created: package.json' });
  });

  test('optional milestone summary inserted as assistant message before user', () => {
    const assembler = makeAssembler();
    const ctx = { ...baseContext(), milestoneSummary: 'Last tool: write_file on src/index.ts' };
    const msgs = assembler.assembleMessages(ctx);
    const assistantMsg = msgs.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toContain('Prior milestone:');
    expect(assistantMsg!.content).toContain('Last tool: write_file on src/index.ts');
  });

  test('no protocol text ([write_file: ...]) in assembled messages after sanitisation', () => {
    const assembler = makeAssembler();
    const ctx: PromptContext = {
      ...baseContext(),
      executionStateSummary: 'Objective: test\n[write_file: bad content]',
    };
    const msgs = assembler.assembleMessages(ctx);
    for (const msg of msgs) {
      expect(msg.content).not.toMatch(/\[write_file:/);
    }
  });

  test('no TOOL: protocol sentinel in assembled messages', () => {
    const assembler = makeAssembler();
    const ctx: PromptContext = {
      ...baseContext(),
      executionStateSummary: '\x00TOOL:read_file:{"path":"x"}\x00',
    };
    const msgs = assembler.assembleMessages(ctx);
    for (const msg of msgs) {
      expect(msg.content).not.toMatch(/\x00TOOL:/);
    }
  });

  test('total assembled message content stays compact for simple greenfield scenario', () => {
    const assembler = makeAssembler();
    const msgs = assembler.assembleMessages(baseContext());
    const totalChars = msgs.reduce((sum, m) => sum + m.content.length, 0);
    // Should be well under 4000 chars (~1000 tokens) for a simple scenario with no history
    expect(totalChars).toBeLessThan(4000);
  });

  test('"currently editing" does not appear in any assembled message', () => {
    const assembler = makeAssembler();
    const ctx: PromptContext = {
      ...baseContext(),
      systemPrompt: 'You are a coder. currently editing src/index.ts, as of 2026-03-14.',
    };
    // The system prompt is passed as-is, but we verify sanitiseTranscript does not inject it
    const msgs = assembler.assembleMessages(ctx);
    // Only the system prompt itself may contain this text — execution state and workspace must not
    const nonSystemMsgs = msgs.filter(m => m !== msgs[0]);
    for (const msg of nonSystemMsgs) {
      expect(msg.content.toLowerCase()).not.toContain('currently editing');
    }
  });
});

describe('buildWorkspaceSummary', () => {
  test('greenfield returns factual summary without imperative instructions', () => {
    const summary = buildWorkspaceSummary('greenfield', []);
    expect(summary.toLowerCase()).toContain('empty');
    // Item 10: workspace summaries must be factual, not directive
    expect(summary).not.toContain('Start by');
    expect(summary).not.toContain('file batch');
  });

  test('docs_only returns factual summary mentioning documentation', () => {
    const summary = buildWorkspaceSummary('docs_only', ['plan.md']);
    expect(summary.toLowerCase()).toContain('docs_only');
    expect(summary).toContain('plan.md');
    expect(summary).not.toContain('Start by');
  });

  test('scaffolded includes key files', () => {
    const summary = buildWorkspaceSummary('scaffolded', ['src/index.ts', 'package.json']);
    expect(summary.toLowerCase()).toContain('scaffolded');
    expect(summary).toContain('src/index.ts');
  });

  test('mature includes key files without imperative instructions', () => {
    const summary = buildWorkspaceSummary('mature', ['src/app.ts']);
    expect(summary.toLowerCase()).toContain('mature');
    expect(summary).toContain('src/app.ts');
    expect(summary).not.toContain('Read key files before');
  });

  test('mature with empty key files still produces a valid string', () => {
    const summary = buildWorkspaceSummary('mature', []);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });
});
