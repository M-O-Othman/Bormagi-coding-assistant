// ─── Integration tests for virtual meeting flow (NF2-QA-001 / NF2-002) ────────
//
// Simulates a complete meeting lifecycle using MeetingStorage (real filesystem).
// Exercises: setup → active → rounds → resolved items → completed → minutes saved.
//
// No VS Code APIs, LLM calls, or AgentManager required.
//
// Run with: npx jest src/tests/integration/meeting-flow.test.ts

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MeetingStorage } from '../../meeting/MeetingStorage';
import type { Meeting, AgendaItem, MeetingRound, ActionItem } from '../../meeting/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTmpBormagiDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-flow-test-'));
}

function newMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meeting-2026-03-01-1100',
    title: 'Architecture Review',
    status: 'setup',
    created_at: '2026-03-01T11:00:00.000Z',
    participants: ['solution-architect', 'business-analyst', 'software-qa'],
    resourceFiles: [],
    agenda: [
      { id: 'item-1', text: 'Review proposed microservices split', status: 'pending' },
      { id: 'item-2', text: 'Agree on data ownership boundaries', status: 'pending' },
    ],
    rounds: [],
    actionItems: [],
    ...overrides,
  };
}

function addRound(meeting: Meeting, agendaItemId: string, agentId: string, response: string): Meeting {
  const round: MeetingRound = {
    agendaItemId,
    agentId,
    response,
    timestamp: new Date().toISOString(),
  };
  return { ...meeting, rounds: [...meeting.rounds, round] };
}

function resolveItem(meeting: Meeting, itemId: string, decision: string): Meeting {
  return {
    ...meeting,
    agenda: meeting.agenda.map(a =>
      a.id === itemId ? { ...a, status: 'resolved', decision } : a
    ),
  };
}

function addActionItem(meeting: Meeting, text: string, assignedTo: string): Meeting {
  const ai: ActionItem = { id: `ai-${meeting.actionItems.length + 1}`, text, assignedTo };
  return { ...meeting, actionItems: [...meeting.actionItems, ai] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Virtual meeting — full lifecycle flow', () => {
  let bormagiDir: string;
  let storage: MeetingStorage;

  beforeEach(() => {
    bormagiDir = createTmpBormagiDir();
    storage = new MeetingStorage(bormagiDir);
  });

  afterEach(() => {
    fs.rmSync(bormagiDir, { recursive: true, force: true });
  });

  test('meeting transitions from setup → active after save', async () => {
    let meeting = newMeeting();
    meeting = { ...meeting, status: 'active' };
    await storage.saveMeeting(meeting);

    const loaded = await storage.loadMeeting(meeting.id);
    expect(loaded!.status).toBe('active');
  });

  test('rounds accumulate correctly across multiple saves', async () => {
    let meeting = newMeeting({ status: 'active' });

    // Round 1: solution-architect responds to item-1
    meeting = addRound(meeting, 'item-1', 'solution-architect',
      'I recommend splitting into Auth, Search, and Notification services.');
    await storage.saveMeeting(meeting);

    // Round 2: business-analyst responds
    meeting = addRound(meeting, 'item-1', 'business-analyst',
      'Agreed — each service should own its database schema.');
    await storage.saveMeeting(meeting);

    // Round 3: software-qa responds
    meeting = addRound(meeting, 'item-1', 'software-qa',
      'I need contract tests between services before we finalise this.');
    await storage.saveMeeting(meeting);

    const loaded = await storage.loadMeeting(meeting.id);
    expect(loaded!.rounds).toHaveLength(3);
    expect(loaded!.rounds[0].agentId).toBe('solution-architect');
    expect(loaded!.rounds[2].agentId).toBe('software-qa');
    expect(loaded!.rounds[2].response).toContain('contract tests');
  });

  test('agenda items transition to resolved with decision recorded', async () => {
    let meeting = newMeeting({ status: 'active' });
    meeting = addRound(meeting, 'item-1', 'solution-architect', 'Split into 3 services.');
    meeting = resolveItem(meeting, 'item-1', 'Three-service split approved: Auth, Search, Notification.');
    await storage.saveMeeting(meeting);

    const loaded = await storage.loadMeeting(meeting.id);
    const resolvedItem = loaded!.agenda.find(a => a.id === 'item-1')!;
    expect(resolvedItem.status).toBe('resolved');
    expect(resolvedItem.decision).toContain('Three-service split');

    const pendingItem = loaded!.agenda.find(a => a.id === 'item-2')!;
    expect(pendingItem.status).toBe('pending');
  });

  test('action items are saved with assignedTo agent IDs', async () => {
    let meeting = newMeeting({ status: 'active' });
    meeting = addActionItem(meeting, 'Draft service boundary ADR', 'solution-architect');
    meeting = addActionItem(meeting, 'Write contract test plan', 'software-qa');
    meeting = addActionItem(meeting, 'Update requirements spec', 'business-analyst');
    await storage.saveMeeting(meeting);

    const loaded = await storage.loadMeeting(meeting.id);
    expect(loaded!.actionItems).toHaveLength(3);
    expect(loaded!.actionItems[0].assignedTo).toBe('solution-architect');
    expect(loaded!.actionItems[1].text).toBe('Write contract test plan');
  });

  test('full flow: setup → active → rounds → resolved → completed → minutes', async () => {
    let meeting = newMeeting();
    await storage.saveMeeting(meeting);

    // Activate
    meeting = { ...meeting, status: 'active' };
    await storage.saveMeeting(meeting);

    // Item-1 discussion
    for (const agentId of meeting.participants) {
      meeting = addRound(meeting, 'item-1', agentId, `Response from ${agentId} on microservices.`);
    }
    meeting = resolveItem(meeting, 'item-1', 'Adopt microservices architecture.');
    await storage.saveMeeting(meeting);

    // Item-2 discussion
    for (const agentId of meeting.participants) {
      meeting = addRound(meeting, 'item-2', agentId, `Response from ${agentId} on data ownership.`);
    }
    meeting = resolveItem(meeting, 'item-2', 'Each service owns its schema.');
    await storage.saveMeeting(meeting);

    // Action items and completion
    meeting = addActionItem(meeting, 'Write ADR-001: Microservices split', 'solution-architect');
    meeting = { ...meeting, status: 'completed' };
    await storage.saveMeeting(meeting);

    // Save minutes
    const minutes = `# Minutes: ${meeting.title}\n\n## Decisions\n- Adopt microservices.\n- Each service owns its schema.\n\n## Action Items\n- Write ADR-001 (solution-architect)\n`;
    await storage.saveMinutes(meeting.id, minutes);

    // Verify final state
    const loaded = await storage.loadMeeting(meeting.id);
    expect(loaded!.status).toBe('completed');
    expect(loaded!.agenda.every(a => a.status === 'resolved')).toBe(true);
    expect(loaded!.rounds).toHaveLength(6); // 3 agents × 2 items
    expect(loaded!.actionItems).toHaveLength(1);

    const minutesFile = path.join(bormagiDir, 'virtual-meetings', meeting.id, 'minutes.md');
    expect(fs.existsSync(minutesFile)).toBe(true);
    const savedMinutes = fs.readFileSync(minutesFile, 'utf8');
    expect(savedMinutes).toContain('ADR-001');
  });

  test('multiple concurrent meetings coexist without collision', async () => {
    const m1 = newMeeting({ id: 'meeting-2026-03-01-0900', title: 'Morning Standup' });
    const m2 = newMeeting({ id: 'meeting-2026-03-01-1400', title: 'Retrospective' });

    await storage.saveMeeting(m1);
    await storage.saveMeeting(m2);

    const ids = await storage.listMeetingIds();
    expect(ids).toHaveLength(2);

    const loaded1 = await storage.loadMeeting(m1.id);
    const loaded2 = await storage.loadMeeting(m2.id);
    expect(loaded1!.title).toBe('Morning Standup');
    expect(loaded2!.title).toBe('Retrospective');
  });

  test('meeting state is durable across new storage instance (simulates VS Code restart)', async () => {
    let meeting = newMeeting({ status: 'active' });
    meeting = addRound(meeting, 'item-1', 'solution-architect', 'This is the architecture recommendation.');
    await storage.saveMeeting(meeting);

    // Create a fresh storage instance pointing at the same directory
    const storage2 = new MeetingStorage(bormagiDir);
    const loaded = await storage2.loadMeeting(meeting.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('active');
    expect(loaded!.rounds).toHaveLength(1);
    expect(loaded!.rounds[0].response).toContain('architecture recommendation');
  });
});
