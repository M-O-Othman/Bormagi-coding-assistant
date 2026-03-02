import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { loadMeetingGuardrails } from '../../meeting/MeetingGuardrails';

function mkTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-guardrails-test-'));
}

describe('Meeting guardrails config', () => {
  let root: string;

  afterEach(() => {
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('loads bundled JSON and applies workspace override', () => {
    root = mkTmpRoot();
    const dataDir = path.join(root, 'data');
    const overrideDir = path.join(root, '.bormagi', 'meeting-config');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(overrideDir, { recursive: true });

    fs.writeFileSync(
      path.join(dataDir, 'meeting-guardrails.json'),
      JSON.stringify({
        decisionLock: { allowedTagsAfterFinalDecision: ['ACTION', 'SKIP'] },
        topicGuard: { defaultAllowedDimensions: ['content', 'automation'] }
      }),
      'utf8'
    );

    fs.writeFileSync(
      path.join(overrideDir, 'guardrails.json'),
      JSON.stringify({
        decisionLock: { enabled: false },
        humanIntent: { deferPatterns: ['\\bmove on\\b'] }
      }),
      'utf8'
    );

    const cfg = loadMeetingGuardrails(root);
    expect(cfg.decisionLock.enabled).toBe(false);
    expect(cfg.decisionLock.allowedTagsAfterFinalDecision).toEqual(['ACTION', 'SKIP']);
    expect(cfg.topicGuard.defaultAllowedDimensions).toEqual(['content', 'automation']);
    expect(cfg.humanIntent.deferPatterns).toEqual(['\\bmove on\\b']);
  });

  test('defaults include robust defer/final-decision intent patterns', () => {
    root = mkTmpRoot();
    const cfg = loadMeetingGuardrails(root);

    const isDefer = cfg.humanIntent.deferPatterns.some(p => new RegExp(p, 'i').test('proceed'));
    const isFinalDecision = cfg.humanIntent.finalDecisionPatterns.some(p => new RegExp(p, 'i').test('i already decided to use rag'));

    expect(isDefer).toBe(true);
    expect(isFinalDecision).toBe(true);
  });
});
