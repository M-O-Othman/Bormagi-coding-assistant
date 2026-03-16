import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLogger } from '../../agents/AgentLogger';

jest.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_k: string, d: unknown) => d,
    }),
  },
}));

describe('AgentLogger prompt redaction', () => {
  test('logs prompt source reference without dumping prompt body', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-logtest-'));
    const logger = new AgentLogger(root, 'agent-x');

    logger.sessionStart('code');
    logger.logSystemPrompt('SECRET PROMPT CONTENT SHOULD NOT APPEAR', ['system-prompt.md']);
    logger.logApiCall(1, [
      { role: 'system', content: 'SECRET PROMPT CONTENT SHOULD NOT APPEAR' },
      { role: 'user', content: 'hello' },
    ] as any);

    const logPath = path.join(root, '.bormagi', 'logs', 'agent-x.log');
    const text = fs.readFileSync(logPath, 'utf8');

    expect(text).toContain('[system prompt used from file(s): system-prompt.md]');
    expect(text).not.toContain('SECRET PROMPT CONTENT SHOULD NOT APPEAR');
  });
});
