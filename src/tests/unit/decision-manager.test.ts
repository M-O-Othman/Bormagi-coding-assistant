import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { DecisionManager } from '../../memory/DecisionManager';

describe('DecisionManager Unit Tests', () => {
    let workspaceRoot: string;
    let decisionManager: DecisionManager;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-test-'));
        decisionManager = new DecisionManager(workspaceRoot);
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test('should save and retrieve a decision record', async () => {
        const record = {
            id: decisionManager.generateId(),
            timestamp: new Date().toISOString(),
            context: 'Test context',
            optionsConsidered: ['A', 'B'],
            decision: 'B',
            agentId: 'agent-1'
        };

        await decisionManager.saveDecision(record);

        const decisions = await decisionManager.getDecisions('agent-1');
        assert.strictEqual(decisions.length, 1);
        assert.strictEqual(decisions[0].id, record.id);
        assert.strictEqual(decisions[0].decision, 'B');
    });

    test('should filter decisions by agentId', async () => {
        await decisionManager.saveDecision({
            id: decisionManager.generateId(),
            timestamp: new Date().toISOString(),
            context: 'Ctx 1',
            optionsConsidered: [],
            decision: 'Choice 1',
            agentId: 'agent-1'
        });

        await decisionManager.saveDecision({
            id: decisionManager.generateId(),
            timestamp: new Date().toISOString(),
            context: 'Ctx 2',
            optionsConsidered: [],
            decision: 'Choice 2',
            agentId: 'agent-2'
        });

        const agent1Decisions = await decisionManager.getDecisions('agent-1');
        assert.strictEqual(agent1Decisions.length, 1);
        assert.strictEqual(agent1Decisions[0].decision, 'Choice 1');
    });
});
