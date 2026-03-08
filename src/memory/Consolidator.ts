import { SessionMemory } from './SessionMemory';
import { PromotionEngine } from './PromotionEngine';
import { DecisionManager, DecisionRecord } from './DecisionManager';
import { TurnMemory } from './TurnMemory';
import * as fs from 'fs';
import * as path from 'path';

export interface EpisodicMemory {
    sessionId: string;
    timestamp: string;
    mainPoints: string[];
    actionItems: string[];
    decisionsMade: DecisionRecord[];
}

/**
 * Consolidator runs after conversational turns or sessions to
 * extract, structure, and persist semantic facts, decisions, and episodic summaries.
 */
export class Consolidator {
    private readonly storageDir: string;

    constructor(
        workspaceRoot: string,
        private readonly sessionMemory: SessionMemory,
        private readonly promotionEngine: PromotionEngine,
        private readonly decisionManager: DecisionManager
    ) {
        this.storageDir = path.join(workspaceRoot, '.bormagi', 'memory', 'episodes');
    }

    /**
     * Consolidate the session by promoting facts and generating an episodic summary.
     */
    async consolidateSession(agentId: string, sessionId: string, turns: TurnMemory): Promise<EpisodicMemory> {
        // 1. Run promotion engine to elevate facts confident enough to be published knowledge
        await this.promotionEngine.runPromotion(agentId, sessionId);

        // 2. Extract structured decisions from the session facts
        // The AgentRunner's natural heuristics in SessionMemory will have labeled some as 'decision'
        const sessionFacts = this.sessionMemory.getFacts(agentId, 'decision');
        const decisionsMade: DecisionRecord[] = [];

        // For each decision fact, promote it to a first-class DecisionRecord
        for (const fact of sessionFacts) {
            const record: DecisionRecord = {
                id: this.decisionManager.generateId(),
                timestamp: fact.createdAt,
                context: "Extracted from session semantic memory",
                optionsConsidered: [], // Would typically require LLM extraction to fully populate
                decision: fact.content,
                agentId: agentId
            };
            await this.decisionManager.saveDecision(record);
            decisionsMade.push(record);
        }

        // 3. Create episodic summary from the turn history
        const recentTurns = turns.getRecentTurns();

        const episodic: EpisodicMemory = {
            sessionId,
            timestamp: new Date().toISOString(),
            mainPoints: sessionFacts.map(f => f.content),
            actionItems: recentTurns.flatMap(t => t.toolResults.map(r => `Used tool ${r.toolName}`)),
            decisionsMade
        };

        // Persist episodic memory
        await this.saveEpisode(agentId, episodic);

        return episodic;
    }

    private async saveEpisode(agentId: string, episode: EpisodicMemory): Promise<void> {
        const agentDir = path.join(this.storageDir, agentId);
        if (!fs.existsSync(agentDir)) {
            fs.mkdirSync(agentDir, { recursive: true });
        }
        const filePath = path.join(agentDir, `${episode.sessionId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(episode, null, 2), 'utf-8');
    }
}
