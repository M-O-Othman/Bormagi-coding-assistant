// ─── Three-tier memory tests ─────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TurnMemory } from '../../memory/TurnMemory';
import { SessionMemory } from '../../memory/SessionMemory';
import { PublishedKnowledge } from '../../memory/PublishedKnowledge';
import { PromotionEngine } from '../../memory/PromotionEngine';

describe('Three-Tier Memory', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-test-memory-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Tier 1: Turn Memory (ephemeral)
    // ═══════════════════════════════════════════════════════════════════════

    describe('TurnMemory', () => {
        let turn: TurnMemory;

        beforeEach(() => {
            turn = new TurnMemory();
        });

        it('starts with no current turn', () => {
            expect(turn.getCurrentTurn()).toBeNull();
        });

        it('creates a turn with startTurn', () => {
            const ctx = turn.startTurn('Hello world');
            expect(ctx).toBeDefined();
            expect(ctx.userMessage).toBe('Hello world');
            expect(ctx.toolResults).toEqual([]);
            expect(ctx.evidenceSources).toEqual([]);
            expect(ctx.startedAt).toBeTruthy();
        });

        it('returns the current turn via getCurrentTurn', () => {
            turn.startTurn('Test message');
            expect(turn.getCurrentTurn()).not.toBeNull();
            expect(turn.getCurrentTurn()!.userMessage).toBe('Test message');
        });

        it('records tool results', () => {
            turn.startTurn('Query');
            turn.addToolResult('search', 'Found 3 results');
            turn.addToolResult('read_file', 'File content...');

            const ctx = turn.getCurrentTurn();
            expect(ctx!.toolResults.length).toBe(2);
            expect(ctx!.toolResults[0].toolName).toBe('search');
        });

        it('records evidence sources', () => {
            turn.startTurn('Query');
            turn.addEvidenceSources(['readme.md', 'design.md']);

            const ctx = turn.getCurrentTurn();
            expect(ctx!.evidenceSources).toContain('readme.md');
            expect(ctx!.evidenceSources).toContain('design.md');
        });

        it('endTurn moves turn to history and clears current', () => {
            turn.startTurn('Message 1');
            const ended = turn.endTurn();

            expect(ended).not.toBeNull();
            expect(ended!.userMessage).toBe('Message 1');
            expect(turn.getCurrentTurn()).toBeNull();
        });

        it('tracks turn history', () => {
            turn.startTurn('Turn 1');
            turn.endTurn();
            turn.startTurn('Turn 2');
            turn.endTurn();
            turn.startTurn('Turn 3');
            turn.endTurn();

            const history = turn.getRecentTurns();
            expect(history.length).toBe(3);
        });

        it('limits history to maxHistory', () => {
            for (let i = 0; i < 15; i++) {
                turn.startTurn(`Turn ${i}`);
                turn.endTurn();
            }

            const history = turn.getRecentTurns();
            expect(history.length).toBe(10); // Default maxHistory
        });

        it('clear resets everything', () => {
            turn.startTurn('Active turn');
            turn.clear();
            expect(turn.getCurrentTurn()).toBeNull();
            expect(turn.getRecentTurns()).toEqual([]);
        });

        it('does not add tool results when no turn is active', () => {
            // Should not throw
            turn.addToolResult('search', 'result');
            expect(turn.getCurrentTurn()).toBeNull();
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Tier 2: Session Memory
    // ═══════════════════════════════════════════════════════════════════════

    describe('SessionMemory', () => {
        let session: SessionMemory;

        beforeEach(() => {
            session = new SessionMemory(tmpDir);
        });

        it('creates a new session for an agent', () => {
            const state = session.getOrCreateSession('agent-1');
            expect(state).toBeDefined();
            expect(state.agentId).toBe('agent-1');
            expect(state.facts).toEqual([]);
        });

        it('returns same session on repeated calls', () => {
            const s1 = session.getOrCreateSession('agent-1');
            const s2 = session.getOrCreateSession('agent-1');
            expect(s1.sessionId).toBe(s2.sessionId);
        });

        it('creates separate sessions for different agents', () => {
            const s1 = session.getOrCreateSession('agent-1');
            const s2 = session.getOrCreateSession('agent-2');
            expect(s1.sessionId).not.toBe(s2.sessionId);
        });

        it('adds facts with auto-generated fields', () => {
            const fact = session.addFact('agent-1', {
                content: 'We decided to use React.',
                confidence: 0.8,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'decision',
            });

            expect(fact.factId).toBeTruthy();
            expect(fact.createdAt).toBeTruthy();
            expect(fact.validationDate).toBeTruthy();
            expect(fact.content).toBe('We decided to use React.');
        });

        it('retrieves facts by agent', () => {
            session.addFact('agent-1', {
                content: 'Fact A',
                confidence: 0.9,
                origin: 'user',
                contradictionLinks: [],
                factType: 'preference',
            });
            session.addFact('agent-1', {
                content: 'Fact B',
                confidence: 0.7,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'decision',
            });

            const facts = session.getFacts('agent-1');
            expect(facts.length).toBe(2);
        });

        it('filters facts by type', () => {
            session.addFact('agent-1', {
                content: 'Decision 1',
                confidence: 0.8,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'decision',
            });
            session.addFact('agent-1', {
                content: 'Preference 1',
                confidence: 0.9,
                origin: 'user',
                contradictionLinks: [],
                factType: 'preference',
            });

            const decisions = session.getFacts('agent-1', 'decision');
            expect(decisions.length).toBe(1);
            expect(decisions[0].content).toBe('Decision 1');
        });

        it('extracts facts from agent responses', () => {
            const facts = session.extractFactsFromResponse(
                'agent-1',
                'I want to use TypeScript for the project.',
                "I'll use Next.js for the frontend. The best approach is to use server-side rendering."
            );

            expect(facts.length).toBeGreaterThanOrEqual(1);
        });

        it('builds a memory summary for prompt injection', () => {
            session.addFact('agent-1', {
                content: 'Use React for frontend.',
                confidence: 0.9,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'decision',
            });

            const summary = session.buildMemorySummary('agent-1');
            expect(summary).toContain('[Session Memory]');
            expect(summary).toContain('React');
        });

        it('returns empty summary when no facts', () => {
            const summary = session.buildMemorySummary('no-agent');
            expect(summary).toBe('');
        });

        it('persists and re-loads session from disk', async () => {
            session.addFact('agent-1', {
                content: 'Persisted fact.',
                confidence: 0.8,
                origin: 'user',
                contradictionLinks: [],
                factType: 'observation',
            });

            await session.persistSession('agent-1');

            // Create new instance pointing to same workspace
            const session2 = new SessionMemory(tmpDir);
            const state = session2.getOrCreateSession('agent-1');
            expect(state.facts.length).toBe(1);
            expect(state.facts[0].content).toBe('Persisted fact.');
        });

        it('clears session data', () => {
            session.addFact('agent-1', {
                content: 'Temp fact.',
                confidence: 0.5,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'observation',
            });

            session.clearSession('agent-1');
            const state = session.getOrCreateSession('agent-1');
            expect(state.facts.length).toBe(0);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Tier 3: Published Knowledge
    // ═══════════════════════════════════════════════════════════════════════

    describe('PublishedKnowledge', () => {
        let published: PublishedKnowledge;

        beforeEach(() => {
            published = new PublishedKnowledge(tmpDir);
        });

        it('starts with no entries', () => {
            const entries = published.getEntries('agent-1');
            expect(entries).toEqual([]);
        });

        it('promotes a fact to published knowledge', () => {
            const fact = {
                factId: 'f1',
                content: 'Use PostgreSQL for the database.',
                confidence: 0.9,
                origin: 'agent' as const,
                createdAt: new Date().toISOString(),
                validationDate: new Date().toISOString(),
                contradictionLinks: [],
                factType: 'decision' as const,
            };

            const entry = published.promote('agent-1', fact, 'Always Promote', 'session-1');
            expect(entry.content).toBe('Use PostgreSQL for the database.');
            expect(entry.promotionRule).toBe('Always Promote');
            expect(entry.promotedFrom).toBe('f1');
        });

        it('retrieves entries after promotion', () => {
            const fact = {
                factId: 'f1',
                content: 'Use PostgreSQL.',
                confidence: 0.9,
                origin: 'agent' as const,
                createdAt: new Date().toISOString(),
                validationDate: new Date().toISOString(),
                contradictionLinks: [],
                factType: 'decision' as const,
            };

            published.promote('agent-1', fact, 'rule-1', 'session-1');
            const entries = published.getEntries('agent-1');
            expect(entries.length).toBe(1);
        });

        it('builds prompt-ready knowledge summary', () => {
            const fact = {
                factId: 'f1',
                content: 'Use TypeScript over JavaScript.',
                confidence: 0.85,
                origin: 'user' as const,
                createdAt: new Date().toISOString(),
                validationDate: new Date().toISOString(),
                contradictionLinks: [],
                factType: 'preference' as const,
            };

            published.promote('agent-1', fact, 'rule-1', 'session-1');
            const summary = published.buildKnowledgeSummary('agent-1');
            expect(summary).toContain('[Published Knowledge');
            expect(summary).toContain('TypeScript');
        });

        it('deletes a specific entry', () => {
            const fact = {
                factId: 'f1',
                content: 'Deletable fact.',
                confidence: 0.5,
                origin: 'agent' as const,
                createdAt: new Date().toISOString(),
                validationDate: new Date().toISOString(),
                contradictionLinks: [],
                factType: 'observation' as const,
            };

            const entry = published.promote('agent-1', fact, 'rule-1', 'session-1');
            const deleted = published.deleteEntry('agent-1', entry.id);
            expect(deleted).toBe(true);
            expect(published.getEntries('agent-1').length).toBe(0);
        });

        it('resetAll clears all entries for an agent', () => {
            const makeFact = (id: string, content: string) => ({
                factId: id,
                content,
                confidence: 0.8,
                origin: 'agent' as const,
                createdAt: new Date().toISOString(),
                validationDate: new Date().toISOString(),
                contradictionLinks: [],
                factType: 'decision' as const,
            });

            published.promote('agent-1', makeFact('f1', 'Fact 1'), 'r1', 's1');
            published.promote('agent-1', makeFact('f2', 'Fact 2'), 'r1', 's1');

            const count = published.resetAll('agent-1');
            expect(count).toBe(2);
            expect(published.getEntries('agent-1')).toEqual([]);
        });

        it('getStats returns correct counts', () => {
            const makeFact = (id: string, type: string) => ({
                factId: id,
                content: `Fact ${id}`,
                confidence: 0.8,
                origin: 'agent' as const,
                createdAt: new Date().toISOString(),
                validationDate: new Date().toISOString(),
                contradictionLinks: [],
                factType: type as 'decision' | 'observation',
            });

            published.promote('agent-1', makeFact('f1', 'decision'), 'r1', 's1');
            published.promote('agent-1', makeFact('f2', 'decision'), 'r1', 's1');
            published.promote('agent-1', makeFact('f3', 'observation'), 'r1', 's1');

            const stats = published.getStats('agent-1');
            expect(stats.totalEntries).toBe(3);
            expect(stats.byType['decision']).toBe(2);
            expect(stats.byType['observation']).toBe(1);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Promotion Engine
    // ═══════════════════════════════════════════════════════════════════════

    describe('PromotionEngine', () => {
        let session: SessionMemory;
        let published: PublishedKnowledge;
        let engine: PromotionEngine;

        beforeEach(() => {
            session = new SessionMemory(tmpDir);
            published = new PublishedKnowledge(tmpDir);
            engine = new PromotionEngine(session, published);
        });

        it('starts with default "always promote" rule', () => {
            const rules = engine.getRules();
            expect(rules.length).toBe(1);
            expect(rules[0].id).toBe('always-promote');
        });

        it('promotes all session facts with default rules', async () => {
            session.addFact('agent-1', {
                content: 'Decision A.',
                confidence: 0.8,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'decision',
            });
            session.addFact('agent-1', {
                content: 'Preference B.',
                confidence: 0.9,
                origin: 'user',
                contradictionLinks: [],
                factType: 'preference',
            });

            const sessionState = session.getOrCreateSession('agent-1');
            const log = await engine.runPromotion('agent-1', sessionState.sessionId);

            expect(log.length).toBe(2);
            expect(published.getEntries('agent-1').length).toBe(2);
        });

        it('does not duplicate already-published facts', async () => {
            session.addFact('agent-1', {
                content: 'Unique fact.',
                confidence: 0.8,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'decision',
            });

            const sessionState = session.getOrCreateSession('agent-1');
            await engine.runPromotion('agent-1', sessionState.sessionId);
            const log2 = await engine.runPromotion('agent-1', sessionState.sessionId);

            expect(log2.length).toBe(0); // Already published
            expect(published.getEntries('agent-1').length).toBe(1);
        });

        it('respects minConfidence thresholds', async () => {
            engine.setRules([{
                id: 'high-confidence',
                name: 'High Confidence Only',
                enabled: true,
                minConfidence: 0.8,
                factTypes: [],
            }]);

            session.addFact('agent-1', {
                content: 'Low confidence fact.',
                confidence: 0.3,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'observation',
            });
            session.addFact('agent-1', {
                content: 'High confidence fact.',
                confidence: 0.95,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'decision',
            });

            const sessionState = session.getOrCreateSession('agent-1');
            const log = await engine.runPromotion('agent-1', sessionState.sessionId);
            expect(log.length).toBe(1);
            expect(log[0].factContent).toBe('High confidence fact.');
        });

        it('filters by fact types', async () => {
            engine.setRules([{
                id: 'decisions-only',
                name: 'Decisions Only',
                enabled: true,
                minConfidence: 0,
                factTypes: ['decision'],
            }]);

            session.addFact('agent-1', {
                content: 'A decision.',
                confidence: 0.8,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'decision',
            });
            session.addFact('agent-1', {
                content: 'An observation.',
                confidence: 0.9,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'observation',
            });

            const sessionState = session.getOrCreateSession('agent-1');
            const log = await engine.runPromotion('agent-1', sessionState.sessionId);
            expect(log.length).toBe(1);
            expect(log[0].factContent).toBe('A decision.');
        });

        it('supports adding and removing rules', () => {
            engine.addRule({
                id: 'custom-rule',
                name: 'Custom',
                enabled: true,
                minConfidence: 0.5,
                factTypes: ['preference'],
            });

            expect(engine.getRules().length).toBe(2);

            const removed = engine.removeRule('custom-rule');
            expect(removed).toBe(true);
            expect(engine.getRules().length).toBe(1);
        });

        it('tracks promotion log', async () => {
            session.addFact('agent-1', {
                content: 'Logged fact.',
                confidence: 0.8,
                origin: 'agent',
                contradictionLinks: [],
                factType: 'decision',
            });

            const sessionState = session.getOrCreateSession('agent-1');
            await engine.runPromotion('agent-1', sessionState.sessionId);

            const log = engine.getPromotionLog();
            expect(log.length).toBe(1);
            expect(log[0].agentId).toBe('agent-1');
            expect(log[0].ruleName).toBe('Always Promote');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // End-to-end: Full 3-tier flow
    // ═══════════════════════════════════════════════════════════════════════

    describe('End-to-end 3-tier flow', () => {
        it('turn → session → published pipeline works', async () => {
            const turn = new TurnMemory();
            const sessionMem = new SessionMemory(tmpDir);
            const pub = new PublishedKnowledge(tmpDir);
            const engine = new PromotionEngine(sessionMem, pub);

            // Tier 1: Start a turn
            turn.startTurn('I want to use React for the frontend.');
            turn.addToolResult('search', 'Found React docs');
            turn.addEvidenceSources(['react-docs.md']);

            // End the turn
            const endedTurn = turn.endTurn();
            expect(endedTurn).not.toBeNull();

            // Tier 2: Extract facts from the conversation
            sessionMem.extractFactsFromResponse(
                'agent-1',
                'I want to use React for the frontend.',
                "I'll use React with TypeScript. The best approach is server-side rendering."
            );

            const facts = sessionMem.getFacts('agent-1');
            expect(facts.length).toBeGreaterThanOrEqual(1);

            // Tier 3: Promote to published knowledge
            const sessionState = sessionMem.getOrCreateSession('agent-1');
            const promoted = await engine.runPromotion('agent-1', sessionState.sessionId);
            expect(promoted.length).toBeGreaterThanOrEqual(1);

            // Verify published knowledge
            const entries = pub.getEntries('agent-1');
            expect(entries.length).toBeGreaterThanOrEqual(1);

            // Verify knowledge summary can be built
            const summary = pub.buildKnowledgeSummary('agent-1');
            expect(summary).toContain('[Published Knowledge');
        });
    });
});
