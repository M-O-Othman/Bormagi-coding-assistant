/**
 * Phase 4 tests: skill fragment loader and PromptAssembler skill injection.
 */
import * as path from 'path';
import { loadSkillFragment, KNOWN_SKILLS } from '../../skills/skillLoader';
import { PromptAssembler } from '../../agents/execution/PromptAssembler';

// ─── Skill loader tests ───────────────────────────────────────────────────────

describe('loadSkillFragment', () => {
  test('loadSkillFragment("codebase-navigator") returns non-empty string', () => {
    const content = loadSkillFragment('codebase-navigator');
    expect(content).not.toBeNull();
    expect(content!.length).toBeGreaterThan(10);
  });

  test('loadSkillFragment("unknown-skill") returns null', () => {
    expect(loadSkillFragment('unknown-skill')).toBeNull();
  });

  test('path traversal attempt returns null', () => {
    expect(loadSkillFragment('../extension')).toBeNull();
    expect(loadSkillFragment('../../package')).toBeNull();
  });

  test('all 4 known skill files exist and contain required headings', () => {
    for (const skill of KNOWN_SKILLS) {
      const content = loadSkillFragment(skill);
      expect(content).not.toBeNull();
      expect(content).toContain('## Skill:');
      expect(content).toContain('### When to activate');
      expect(content).toContain('### Required tool sequence');
      expect(content).toContain('### Constraints');
    }
  });
});

// ─── PromptAssembler skill injection tests ────────────────────────────────────

function makeAssembler(): PromptAssembler {
  return new PromptAssembler({
    executionStateHeader: '[Execution State]',
    workspaceHeader: '[Workspace]',
    milestoneSummaryPrefix: 'Prior: ',
  });
}

describe('PromptAssembler — skill fragment injection', () => {
  test('assembleMessages with activeSkills injects skill content as system message', () => {
    const assembler = makeAssembler();
    const msgs = assembler.assembleMessages({
      systemPrompt: 'System prompt',
      executionStateSummary: '',
      workspaceSummary: '',
      currentInstruction: 'Investigate the bug',
      currentStepToolResults: [],
      activeSkills: ['bug-investigator'],
    });

    const systemMsgs = msgs.filter(m => m.role === 'system');
    const hasSkillContent = systemMsgs.some(m =>
      typeof m.content === 'string' && m.content.includes('Bug Investigator')
    );
    expect(hasSkillContent).toBe(true);
  });

  test('skill message appears before user instruction', () => {
    const assembler = makeAssembler();
    const msgs = assembler.assembleMessages({
      systemPrompt: 'System prompt',
      executionStateSummary: '',
      workspaceSummary: '',
      currentInstruction: 'Navigate the codebase',
      currentStepToolResults: [],
      activeSkills: ['codebase-navigator'],
    });

    const skillIdx = msgs.findIndex(m =>
      m.role === 'system' && typeof m.content === 'string' && m.content.includes('Codebase Navigator')
    );
    const userIdx = msgs.findIndex(m => m.role === 'user');
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(skillIdx);
  });

  test('skill message has role: system', () => {
    const assembler = makeAssembler();
    const msgs = assembler.assembleMessages({
      systemPrompt: 'System prompt',
      executionStateSummary: '',
      workspaceSummary: '',
      currentInstruction: 'Implement the feature',
      currentStepToolResults: [],
      activeSkills: ['implement-feature'],
    });

    const skillMsg = msgs.find(m =>
      m.role === 'system' && typeof m.content === 'string' && m.content.includes('Implement Feature')
    );
    expect(skillMsg?.role).toBe('system');
  });

  test('no activeSkills — no extra system messages added', () => {
    const assembler = makeAssembler();
    const withoutSkills = assembler.assembleMessages({
      systemPrompt: 'System prompt',
      executionStateSummary: '',
      workspaceSummary: '',
      currentInstruction: 'Do something',
      currentStepToolResults: [],
    });
    const withSkillsEmpty = assembler.assembleMessages({
      systemPrompt: 'System prompt',
      executionStateSummary: '',
      workspaceSummary: '',
      currentInstruction: 'Do something',
      currentStepToolResults: [],
      activeSkills: [],
    });
    expect(withoutSkills.length).toBe(withSkillsEmpty.length);
  });

  test('unknown skill name is silently ignored (no error, no extra message)', () => {
    const assembler = makeAssembler();
    const msgs = assembler.assembleMessages({
      systemPrompt: 'System prompt',
      executionStateSummary: '',
      workspaceSummary: '',
      currentInstruction: 'Task',
      currentStepToolResults: [],
      activeSkills: ['does-not-exist'],
    });
    // Only 2 messages: system + user
    expect(msgs.length).toBe(2);
  });
});
