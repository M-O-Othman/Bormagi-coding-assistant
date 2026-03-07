// ─── Session memory ──────────────────────────────────────────────────────────
//
// Tier 2: Active task context memory.
// Stores semantic facts extracted from the conversation.
// Each fact carries confidence, origin, and validation metadata.
// Sessions are persisted to .bormagi/memory/<agent-id>/sessions/

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { MemoryFact, SessionState } from './types';

export class SessionMemory {
    private sessions = new Map<string, SessionState>();
    private readonly storageDir: string;

    constructor(private readonly workspaceRoot: string) {
        this.storageDir = path.join(workspaceRoot, '.bormagi', 'memory');
    }

    /**
     * Get or create a session for an agent.
     * Sessions are identified by agent ID; one active session per agent.
     */
    getOrCreateSession(agentId: string): SessionState {
        let session = this.sessions.get(agentId);
        if (!session) {
            // Try loading from disk
            session = this.loadSession(agentId);
            if (!session) {
                session = {
                    sessionId: this.generateId(),
                    agentId,
                    startedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    facts: [],
                };
            }
            this.sessions.set(agentId, session);
        }
        return session;
    }

    /**
     * Add a semantic fact to the agent's session.
     */
    addFact(agentId: string, fact: Omit<MemoryFact, 'factId' | 'createdAt' | 'validationDate'>): MemoryFact {
        const session = this.getOrCreateSession(agentId);
        const now = new Date().toISOString();

        const fullFact: MemoryFact = {
            factId: this.generateId(),
            createdAt: now,
            validationDate: now,
            ...fact,
        };

        session.facts.push(fullFact);
        session.updatedAt = now;
        return fullFact;
    }

    /**
     * Extract and store facts from an agent's response.
     * Uses simple heuristics to identify decisions, assumptions, and preferences.
     */
    extractFactsFromResponse(agentId: string, userMessage: string, agentResponse: string): MemoryFact[] {
        const facts: MemoryFact[] = [];

        // Extract decisions (phrases like "I'll use", "we should", "the best approach is")
        const decisionPatterns = [
            /(?:I(?:'ll| will) use|we should|the (?:best|recommended) (?:approach|solution|way) is|let's go with|I recommend)\s+(.+?)(?:\.|$)/gi,
            /(?:decided to|choosing|selected|opting for)\s+(.+?)(?:\.|$)/gi,
        ];

        for (const pattern of decisionPatterns) {
            let match;
            while ((match = pattern.exec(agentResponse)) !== null) {
                facts.push(this.addFact(agentId, {
                    content: match[0].trim(),
                    confidence: 0.7,
                    origin: 'agent',
                    contradictionLinks: [],
                    factType: 'decision',
                }));
            }
        }

        // Extract user preferences from the user message (phrases like "I want", "I prefer", "please use")
        const preferencePatterns = [
            /(?:I (?:want|prefer|need|like)|please (?:use|make|ensure))\s+(.+?)(?:\.|$)/gi,
        ];

        for (const pattern of preferencePatterns) {
            let match;
            while ((match = pattern.exec(userMessage)) !== null) {
                facts.push(this.addFact(agentId, {
                    content: match[0].trim(),
                    confidence: 0.9,
                    origin: 'user',
                    contradictionLinks: [],
                    factType: 'preference',
                }));
            }
        }

        return facts;
    }

    /**
     * Get all facts for an agent, optionally filtered by type.
     */
    getFacts(agentId: string, factType?: string): MemoryFact[] {
        const session = this.getOrCreateSession(agentId);
        if (factType) {
            return session.facts.filter(f => f.factType === factType);
        }
        return session.facts;
    }

    /**
     * Build a summary of session memory for prompt injection.
     */
    buildMemorySummary(agentId: string): string {
        const facts = this.getFacts(agentId);
        if (facts.length === 0) { return ''; }

        const grouped: Record<string, MemoryFact[]> = {};
        for (const fact of facts) {
            if (!grouped[fact.factType]) { grouped[fact.factType] = []; }
            grouped[fact.factType].push(fact);
        }

        const lines: string[] = ['[Session Memory]'];
        for (const [type, typeFacts] of Object.entries(grouped)) {
            lines.push(`\n**${type.charAt(0).toUpperCase() + type.slice(1)}s:**`);
            for (const f of typeFacts.slice(-5)) { // Last 5 per type
                lines.push(`- ${f.content} (confidence: ${(f.confidence * 100).toFixed(0)}%, origin: ${f.origin})`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Persist the session to disk.
     */
    async persistSession(agentId: string): Promise<void> {
        const session = this.sessions.get(agentId);
        if (!session) { return; }

        const dir = path.join(this.storageDir, agentId, 'sessions');
        fs.mkdirSync(dir, { recursive: true });

        const filePath = path.join(dir, `${session.sessionId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
    }

    /**
     * Clear the session for an agent (start fresh).
     */
    clearSession(agentId: string): void {
        this.sessions.delete(agentId);
        // Remove the session file from disk
        const dir = path.join(this.storageDir, agentId, 'sessions');
        if (fs.existsSync(dir)) {
            try {
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    fs.unlinkSync(path.join(dir, f));
                }
            } catch { /* ignore */ }
        }
    }

    // ─── Private ───────────────────────────────────────────────────────────

    private loadSession(agentId: string): SessionState | undefined {
        const dir = path.join(this.storageDir, agentId, 'sessions');
        if (!fs.existsSync(dir)) { return undefined; }

        try {
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
            if (files.length === 0) { return undefined; }

            // Load the most recent session
            files.sort();
            const latest = files[files.length - 1];
            const data = fs.readFileSync(path.join(dir, latest), 'utf-8');
            return JSON.parse(data);
        } catch {
            return undefined;
        }
    }

    private generateId(): string {
        return crypto.randomBytes(8).toString('hex');
    }
}
