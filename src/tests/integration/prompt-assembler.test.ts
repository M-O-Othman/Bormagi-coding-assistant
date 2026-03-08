// ─── Integration tests: PromptAssembler ───────────────────────────────────────
//
// Verifies that assemblePrompt() and getOutputContract() produce correct,
// well-structured output for every supported AssistantMode.

import { assemblePrompt, getOutputContract } from '../../context/PromptAssembler';
import type { AssistantMode, ContextEnvelope, EffectiveInstructions } from '../../context/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEnvelope(overrides: Partial<ContextEnvelope> = {}): ContextEnvelope {
  return {
    editable:    [],
    reference:   [],
    memory:      [],
    toolOutputs: [],
    ...overrides,
  };
}

function makeInstructions(merged = ''): EffectiveInstructions {
  return {
    merged,
    layers:             [],
    totalTokenEstimate: Math.ceil(merged.length / 4),
  };
}

function makeCandidate(content: string, editable = false) {
  return {
    id:            'c1',
    kind:          'file' as const,
    path:          'src/foo.ts',
    content,
    tokenEstimate: Math.ceil(content.length / 4),
    score:         1,
    reasons:       ['test'],
    editable,
  };
}

const ALL_MODES: AssistantMode[] = ['plan', 'edit', 'debug', 'review', 'explain', 'search', 'test-fix'];

// ─── assemblePrompt — structure ───────────────────────────────────────────────

describe('assemblePrompt — identity and structure', () => {
  test('includes agent name in the output', () => {
    const result = assemblePrompt({
      systemPreamble:  'You are an assistant.',
      instructions:    makeInstructions(),
      envelope:        makeEnvelope(),
      repoMap:         null,
      userMessage:     'Do something',
      mode:            'plan',
      agentName:       'TestAgent',
      projectName:     'MyProject',
    });
    expect(result).toContain('TestAgent');
  });

  test('includes project name when provided', () => {
    const result = assemblePrompt({
      systemPreamble: '',
      instructions:   makeInstructions(),
      envelope:       makeEnvelope(),
      repoMap:        null,
      userMessage:    'task',
      mode:           'plan',
      projectName:    'Acme Repo',
    });
    expect(result).toContain('Acme Repo');
  });

  test('includes mode label in the identity header', () => {
    for (const mode of ALL_MODES) {
      const result = assemblePrompt({
        systemPreamble: '',
        instructions:   makeInstructions(),
        envelope:       makeEnvelope(),
        repoMap:        null,
        userMessage:    'x',
        mode,
      });
      // Mode label should appear capitalised somewhere in the header.
      const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
      expect(result).toContain(modeLabel);
    }
  });

  test('includes the user message under Current Task', () => {
    const result = assemblePrompt({
      systemPreamble: '',
      instructions:   makeInstructions(),
      envelope:       makeEnvelope(),
      repoMap:        null,
      userMessage:    'Fix the authentication bug.',
      mode:           'debug',
    });
    expect(result).toContain('Fix the authentication bug.');
    expect(result).toContain('Current Task');
  });

  test('includes system preamble', () => {
    const result = assemblePrompt({
      systemPreamble: 'PREAMBLE_SENTINEL',
      instructions:   makeInstructions(),
      envelope:       makeEnvelope(),
      repoMap:        null,
      userMessage:    'task',
      mode:           'explain',
    });
    expect(result).toContain('PREAMBLE_SENTINEL');
  });

  test('includes instructions when non-empty', () => {
    const result = assemblePrompt({
      systemPreamble: '',
      instructions:   makeInstructions('Always use TypeScript.'),
      envelope:       makeEnvelope(),
      repoMap:        null,
      userMessage:    'task',
      mode:           'edit',
    });
    expect(result).toContain('Always use TypeScript.');
    expect(result).toContain('Instructions');
  });

  test('omits instructions section when merged is empty', () => {
    const result = assemblePrompt({
      systemPreamble: '',
      instructions:   makeInstructions(''),
      envelope:       makeEnvelope(),
      repoMap:        null,
      userMessage:    'task',
      mode:           'edit',
    });
    expect(result).not.toContain('## Instructions');
  });
});

// ─── assemblePrompt — context sections ────────────────────────────────────────

describe('assemblePrompt — context envelope sections', () => {
  test('includes editable files section when candidates are present', () => {
    const envelope = makeEnvelope({
      editable: [makeCandidate('const x = 1;', true)],
    });
    const result = assemblePrompt({
      systemPreamble: '',
      instructions:   makeInstructions(),
      envelope,
      repoMap:        null,
      userMessage:    'task',
      mode:           'edit',
    });
    expect(result).toContain('Files to Modify');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('src/foo.ts');
  });

  test('includes reference context section when candidates are present', () => {
    const envelope = makeEnvelope({
      reference: [makeCandidate('function foo() {}')],
    });
    const result = assemblePrompt({
      systemPreamble: '',
      instructions:   makeInstructions(),
      envelope,
      repoMap:        null,
      userMessage:    'task',
      mode:           'review',
    });
    expect(result).toContain('Reference Context');
    expect(result).toContain('function foo()');
  });

  test('includes session memory when present', () => {
    const envelope = makeEnvelope({
      memory: [{ ...makeCandidate('Remembered fact.'), kind: 'memory' }],
    });
    const result = assemblePrompt({
      systemPreamble: '',
      instructions:   makeInstructions(),
      envelope,
      repoMap:        null,
      userMessage:    'task',
      mode:           'plan',
    });
    expect(result).toContain('Session Memory');
    expect(result).toContain('Remembered fact.');
  });

  test('includes tool outputs when present', () => {
    const envelope = makeEnvelope({
      toolOutputs: [{ ...makeCandidate('TOOL_OUTPUT_DATA'), kind: 'tool-output' }],
    });
    const result = assemblePrompt({
      systemPreamble: '',
      instructions:   makeInstructions(),
      envelope,
      repoMap:        null,
      userMessage:    'task',
      mode:           'test-fix',
    });
    expect(result).toContain('Tool Outputs');
    expect(result).toContain('TOOL_OUTPUT_DATA');
  });

  test('omits empty sections (no spurious headers)', () => {
    const result = assemblePrompt({
      systemPreamble: '',
      instructions:   makeInstructions(),
      envelope:       makeEnvelope(), // all empty
      repoMap:        null,
      userMessage:    'task',
      mode:           'search',
    });
    expect(result).not.toContain('Files to Modify');
    expect(result).not.toContain('Reference Context');
    expect(result).not.toContain('Session Memory');
    expect(result).not.toContain('Tool Outputs');
    expect(result).not.toContain('Repository Overview');
  });
});

// ─── assemblePrompt — output contracts ────────────────────────────────────────

describe('assemblePrompt — mode-specific output contracts', () => {
  const contractKeywords: Record<AssistantMode, string[]> = {
    plan:      ['Assumptions', 'Impacted Files', 'Plan Steps', 'Risks'],
    edit:      ['Changed Files', 'Patch Summary', 'Validation Notes'],
    debug:     ['Root Cause Hypothesis', 'Evidence', 'Proposed Fix'],
    review:    ['Findings', 'Suggested Changes', 'Confidence'],
    explain:   ['one-sentence summary', 'plain language'],
    search:    ['File path', 'line number', 'relevance'],
    'test-fix': ['Failure Analysis', 'Root Cause', 'Fix', 'Confidence'],
  };

  for (const mode of ALL_MODES) {
    test(`${mode} mode output contract contains expected keywords`, () => {
      const result = assemblePrompt({
        systemPreamble: '',
        instructions:   makeInstructions(),
        envelope:       makeEnvelope(),
        repoMap:        null,
        userMessage:    'task',
        mode,
      });
      for (const keyword of contractKeywords[mode]) {
        expect(result).toContain(keyword);
      }
    });
  }

  test('plan mode contract forbids code output', () => {
    const result = assemblePrompt({
      systemPreamble: '',
      instructions:   makeInstructions(),
      envelope:       makeEnvelope(),
      repoMap:        null,
      userMessage:    'task',
      mode:           'plan',
    });
    expect(result.toLowerCase()).toContain('do not write code');
  });
});

// ─── getOutputContract ────────────────────────────────────────────────────────

describe('getOutputContract', () => {
  test('returns a non-empty string for every mode', () => {
    for (const mode of ALL_MODES) {
      const contract = getOutputContract(mode);
      expect(typeof contract).toBe('string');
      expect(contract.trim().length).toBeGreaterThan(0);
    }
  });

  test('plan contract mentions plan-only constraint', () => {
    expect(getOutputContract('plan').toLowerCase()).toContain('do not write code');
  });

  test('edit contract mentions changed files', () => {
    expect(getOutputContract('edit')).toContain('Changed Files');
  });

  test('debug contract mentions root cause', () => {
    expect(getOutputContract('debug')).toContain('Root Cause');
  });

  test('review contract mentions severity', () => {
    const contract = getOutputContract('review');
    expect(contract).toMatch(/Critical|Major|Minor/);
  });

  test('test-fix contract mentions confidence', () => {
    expect(getOutputContract('test-fix')).toContain('Confidence');
  });
});
