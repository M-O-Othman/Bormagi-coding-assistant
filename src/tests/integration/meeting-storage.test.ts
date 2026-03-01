// ─── Integration tests for MeetingStorage (NF2-QA-001) ───────────────────────
//
// Exercises real filesystem I/O against a temporary directory.
// No VS Code APIs required — MeetingStorage only uses Node.js 'fs' and 'path'.
//
// Run with: npx jest src/tests/integration/meeting-storage.test.ts

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MeetingStorage } from '../../meeting/MeetingStorage';
import type { Meeting } from '../../meeting/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTmpBormagiDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-meeting-test-'));
}

function buildMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meeting-2026-03-01-1030',
    title: 'Sprint Planning',
    status: 'setup',
    created_at: new Date().toISOString(),
    participants: ['business-analyst', 'solution-architect'],
    resourceFiles: [],
    agenda: [
      { id: 'item-1', text: 'Define scope for next sprint', status: 'pending' },
      { id: 'item-2', text: 'Assign owners to backlog items', status: 'pending' },
    ],
    rounds: [],
    actionItems: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MeetingStorage — filesystem integration', () => {
  let bormagiDir: string;
  let storage: MeetingStorage;

  beforeEach(() => {
    bormagiDir = createTmpBormagiDir();
    storage = new MeetingStorage(bormagiDir);
  });

  afterEach(() => {
    fs.rmSync(bormagiDir, { recursive: true, force: true });
  });

  test('saveMeeting creates directory structure and meeting.json', async () => {
    const meeting = buildMeeting();
    await storage.saveMeeting(meeting);

    const expectedFile = path.join(bormagiDir, 'virtual-meetings', meeting.id, 'meeting.json');
    expect(fs.existsSync(expectedFile)).toBe(true);

    const raw = fs.readFileSync(expectedFile, 'utf8');
    const parsed = JSON.parse(raw) as Meeting;
    expect(parsed.id).toBe(meeting.id);
    expect(parsed.title).toBe('Sprint Planning');
    expect(parsed.participants).toHaveLength(2);
  });

  test('loadMeeting returns saved meeting with correct fields', async () => {
    const meeting = buildMeeting({ status: 'active' });
    await storage.saveMeeting(meeting);

    const loaded = await storage.loadMeeting(meeting.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(meeting.id);
    expect(loaded!.status).toBe('active');
    expect(loaded!.agenda).toHaveLength(2);
    expect(loaded!.agenda[0].text).toBe('Define scope for next sprint');
  });

  test('loadMeeting returns null for non-existent meeting', async () => {
    const result = await storage.loadMeeting('meeting-does-not-exist');
    expect(result).toBeNull();
  });

  test('saveMeeting overwrites existing meeting (update round-trip)', async () => {
    const meeting = buildMeeting();
    await storage.saveMeeting(meeting);

    const updated: Meeting = {
      ...meeting,
      status: 'completed',
      rounds: [
        { agendaItemId: 'item-1', agentId: 'business-analyst', response: 'We should focus on auth.', timestamp: new Date().toISOString() },
      ],
      actionItems: [
        { id: 'ai-1', text: 'Draft auth spec', assignedTo: 'business-analyst' },
      ],
    };
    await storage.saveMeeting(updated);

    const loaded = await storage.loadMeeting(meeting.id);
    expect(loaded!.status).toBe('completed');
    expect(loaded!.rounds).toHaveLength(1);
    expect(loaded!.actionItems[0].text).toBe('Draft auth spec');
  });

  test('listMeetingIds returns all saved meeting IDs', async () => {
    const m1 = buildMeeting({ id: 'meeting-2026-03-01-0900' });
    const m2 = buildMeeting({ id: 'meeting-2026-03-01-1030' });
    const m3 = buildMeeting({ id: 'meeting-2026-03-01-1400' });

    await storage.saveMeeting(m1);
    await storage.saveMeeting(m2);
    await storage.saveMeeting(m3);

    const ids = await storage.listMeetingIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain('meeting-2026-03-01-0900');
    expect(ids).toContain('meeting-2026-03-01-1400');
  });

  test('listMeetingIds returns empty array when no meetings exist', async () => {
    const ids = await storage.listMeetingIds();
    expect(ids).toEqual([]);
  });

  test('saveMinutes writes markdown to minutes.md', async () => {
    const meeting = buildMeeting();
    await storage.saveMeeting(meeting);

    const minutesMarkdown = `# Minutes: ${meeting.title}\n\n## Decisions\n- Focus on auth for next sprint.\n\n## Action Items\n- Draft auth spec (business-analyst)\n`;
    await storage.saveMinutes(meeting.id, minutesMarkdown);

    const minutesFile = path.join(bormagiDir, 'virtual-meetings', meeting.id, 'minutes.md');
    expect(fs.existsSync(minutesFile)).toBe(true);
    const content = fs.readFileSync(minutesFile, 'utf8');
    expect(content).toContain('## Decisions');
    expect(content).toContain('Draft auth spec');
  });

  test('saveMinutes creates directory if it does not already exist', async () => {
    // Call saveMinutes WITHOUT calling saveMeeting first
    const id = 'meeting-orphan';
    await storage.saveMinutes(id, '# Minutes');

    const minutesFile = path.join(bormagiDir, 'virtual-meetings', id, 'minutes.md');
    expect(fs.existsSync(minutesFile)).toBe(true);
  });

  test('generateId produces timestamp-based unique IDs', () => {
    const id1 = storage.generateId();
    // Small delay to ensure different Date if called in rapid succession — not needed for format check
    expect(id1).toMatch(/^meeting-\d{4}-\d{2}-\d{2}-\d{4}$/);
  });

  test('loadMeeting handles a corrupted JSON file gracefully', async () => {
    const meeting = buildMeeting();
    await storage.saveMeeting(meeting);

    // Corrupt the file
    const file = path.join(bormagiDir, 'virtual-meetings', meeting.id, 'meeting.json');
    fs.writeFileSync(file, '{invalid json:::', 'utf8');

    const result = await storage.loadMeeting(meeting.id);
    expect(result).toBeNull();
  });
});
