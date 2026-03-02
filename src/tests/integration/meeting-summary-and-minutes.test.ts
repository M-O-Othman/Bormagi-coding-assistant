import { MeetingOrchestrator } from '../../meeting/MeetingOrchestrator';
import type { Meeting } from '../../meeting/types';

describe('Meeting summary parsing and minutes generation', () => {
  test('parseSummaryFields does not treat inline "decision" wording as DecisionPromptForHuman', () => {
    const raw = [
      'MODERATOR_SUMMARY:',
      'Problem: Pick retrieval strategy.',
      'Options:',
      '- Embed',
      '- RAG',
      'Recommendation: The team recommends RAG and this decision also favors chunking.',
      'Risks:',
      '- Semantic gaps.',
      'Actions:',
      '- Define indexing plan.',
      'OpenQuestions:',
      '- None',
      'Status: open'
    ].join('\n');

    const parsed = MeetingOrchestrator.parseSummaryFields(raw, 'item-1');
    expect(parsed.decisionPrompt).toBeUndefined();
    expect(parsed.itemStatus).toBe('open');
  });

  test('generateMinutes filters null-like actions, dedupes duplicates, and suppresses null decision prompts', async () => {
    const agentManager = {
      getAgent: (id: string) => {
        const names: Record<string, { name: string }> = {
          'advanced-coder': { name: 'Advanced Coder' },
          'ai-engineer': { name: 'AI / LLM Engineer' }
        };
        return names[id];
      },
      listAgents: () => []
    } as any;

    const configManager = {} as any;
    const storage = {} as any;
    const orchestrator = new MeetingOrchestrator(agentManager, configManager, process.cwd(), storage);

    const meeting: Meeting = {
      id: 'meeting-test',
      title: 'Minutes Quality',
      status: 'active',
      created_at: '2026-03-02T00:00:00.000Z',
      participants: ['advanced-coder', 'ai-engineer'],
      moderatorId: 'advanced-coder',
      resourceFiles: [],
      agenda: [
        { id: 'item-1', text: 'Decide retrieval strategy', status: 'discussing' }
      ],
      rounds: [
        {
          agendaItemId: 'item-1',
          agentId: 'advanced-coder',
          response: 'ACTION:\nDefine indexing plan with BM25.',
          timestamp: '2026-03-02T00:00:01.000Z',
          tag: 'ACTION'
        },
        {
          agendaItemId: 'item-1',
          agentId: 'ai-engineer',
          response: 'ACTION:\nDefine indexing plan with BM25.',
          timestamp: '2026-03-02T00:00:02.000Z',
          tag: 'ACTION'
        }
      ],
      actionItems: [
        { id: 'ai-1', text: 'None', assignedTo: 'TBD' },
        { id: 'ai-2', text: 'Define indexing plan with BM25.', assignedTo: 'TBD' },
        { id: 'ai-3', text: 'Define indexing plan with BM25', assignedTo: 'TBD' }
      ],
      summaryRounds: [
        {
          agendaItemId: 'item-1',
          summary: 'MODERATOR_SUMMARY',
          problem: 'Pick a retrieval approach.',
          options: ['Embed', 'RAG'],
          recommendation: 'Use RAG.',
          risks: ['Semantic gaps.'],
          actions: ['None', 'Define indexing plan with BM25.', 'Define indexing plan with BM25'],
          decisionPrompt: 'None',
          itemStatus: 'open',
          timestamp: '2026-03-02T00:00:03.000Z'
        }
      ],
      executionMode: 'planning'
    };

    const markdown = await orchestrator.generateMinutes(meeting);

    expect(markdown).not.toContain('**Decision for Human:**');
    expect(markdown).not.toContain('- None');
    expect(markdown).not.toContain('**TBD:** None');
    expect((markdown.match(/### .* \[ACTION\]/g) ?? []).length).toBe(1);
    expect((markdown.match(/\*\*TBD:\*\* Define indexing plan with BM25\.?/g) ?? []).length).toBe(1);
  });
});
