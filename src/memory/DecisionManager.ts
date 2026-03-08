import * as fs from 'fs';
import * as path from 'path';

export interface DecisionRecord {
    id: string;
    timestamp: string;
    context: string;
    optionsConsidered: string[];
    decision: string;
    agentId: string;
}

/**
 * Manages DecisionRecord objects representing architectural or tactical
 * choices made by agents. Features local JSON storage for durability and cross-agent access.
 */
export class DecisionManager {
    private readonly storageDir: string;

    constructor(workspaceRoot: string) {
        this.storageDir = path.join(workspaceRoot, '.bormagi', 'memory', 'decisions');
    }

    /**
     * Store a decision record to disk.
     */
    async saveDecision(record: DecisionRecord): Promise<void> {
        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }
        const filePath = path.join(this.storageDir, `${record.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    }

    /**
     * Retrieve all decision records, optionally filtered by agent ID.
     */
    async getDecisions(agentId?: string): Promise<DecisionRecord[]> {
        if (!fs.existsSync(this.storageDir)) {
            return [];
        }

        const files = fs.readdirSync(this.storageDir).filter(f => f.endsWith('.json'));
        const decisions: DecisionRecord[] = [];

        for (const file of files) {
            try {
                const data = fs.readFileSync(path.join(this.storageDir, file), 'utf-8');
                const record: DecisionRecord = JSON.parse(data);
                if (!agentId || record.agentId === agentId) {
                    decisions.push(record);
                }
            } catch {
                // Ignore parse errors safely
            }
        }

        return decisions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }

    /**
     * Generate a unique decision ID.
     */
    generateId(): string {
        return `DE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    }
}
