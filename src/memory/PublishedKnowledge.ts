// ─── Published knowledge ─────────────────────────────────────────────────────
//
// Tier 3: Durable promoted knowledge.
// Auto-promoted from session memory based on rules.
// Stored in .bormagi/memory/<agent-id>/published/
// Provides a reset function to clear all promoted knowledge.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { PublishedEntry, MemoryFact } from './types';

export class PublishedKnowledge {
    private entries = new Map<string, PublishedEntry[]>(); // agentId → entries
    private readonly storageDir: string;

    constructor(private readonly workspaceRoot: string) {
        this.storageDir = path.join(workspaceRoot, '.bormagi', 'memory');
    }

    /**
     * Promote a session fact to published knowledge.
     */
    promote(agentId: string, fact: MemoryFact, ruleName: string, sessionId: string): PublishedEntry {
        const entry: PublishedEntry = {
            id: crypto.randomBytes(8).toString('hex'),
            content: fact.content,
            promotedFrom: fact.factId,
            promotionRule: ruleName,
            promotedAt: new Date().toISOString(),
            source: `${agentId}/${sessionId}`,
            factType: fact.factType,
        };

        const agentEntries = this.getAgentEntries(agentId);
        agentEntries.push(entry);
        this.entries.set(agentId, agentEntries);

        // Persist immediately
        this.persistEntries(agentId);

        return entry;
    }

    /**
     * Get all published entries for an agent.
     */
    getEntries(agentId: string): PublishedEntry[] {
        return this.getAgentEntries(agentId);
    }

    /**
     * Build a text summary of published knowledge for prompt injection.
     */
    buildKnowledgeSummary(agentId: string): string {
        const entries = this.getAgentEntries(agentId);
        if (entries.length === 0) { return ''; }

        const lines: string[] = ['[Published Knowledge from Previous Sessions]'];
        const grouped: Record<string, PublishedEntry[]> = {};

        for (const entry of entries) {
            if (!grouped[entry.factType]) { grouped[entry.factType] = []; }
            grouped[entry.factType].push(entry);
        }

        for (const [type, typeEntries] of Object.entries(grouped)) {
            lines.push(`\n**${type.charAt(0).toUpperCase() + type.slice(1)}s:**`);
            for (const e of typeEntries.slice(-10)) { // Last 10 per type
                lines.push(`- ${e.content}`);
            }
        }

        lines.push('\n[End of Published Knowledge]');
        return lines.join('\n');
    }

    /**
     * Delete a specific published entry.
     */
    deleteEntry(agentId: string, entryId: string): boolean {
        const entries = this.getAgentEntries(agentId);
        const idx = entries.findIndex(e => e.id === entryId);
        if (idx === -1) { return false; }

        entries.splice(idx, 1);
        this.entries.set(agentId, entries);
        this.persistEntries(agentId);
        return true;
    }

    /**
     * Reset (clear) all published knowledge for an agent.
     * This is the user-facing reset function available from the UI.
     */
    resetAll(agentId: string): number {
        const entries = this.getAgentEntries(agentId);
        const count = entries.length;

        this.entries.set(agentId, []);

        // Delete the published file on disk
        const filePath = this.publishedFilePath(agentId);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        return count;
    }

    /**
     * Get stats about published knowledge.
     */
    getStats(agentId: string): { totalEntries: number; byType: Record<string, number> } {
        const entries = this.getAgentEntries(agentId);
        const byType: Record<string, number> = {};
        for (const e of entries) {
            byType[e.factType] = (byType[e.factType] || 0) + 1;
        }
        return { totalEntries: entries.length, byType };
    }

    // ─── Internal ──────────────────────────────────────────────────────────

    private getAgentEntries(agentId: string): PublishedEntry[] {
        if (!this.entries.has(agentId)) {
            // Try loading from disk
            const loaded = this.loadEntries(agentId);
            this.entries.set(agentId, loaded);
        }
        return this.entries.get(agentId) || [];
    }

    private publishedFilePath(agentId: string): string {
        return path.join(this.storageDir, agentId, 'published', 'knowledge.json');
    }

    private persistEntries(agentId: string): void {
        const dir = path.join(this.storageDir, agentId, 'published');
        fs.mkdirSync(dir, { recursive: true });

        const entries = this.entries.get(agentId) || [];
        fs.writeFileSync(
            this.publishedFilePath(agentId),
            JSON.stringify(entries, null, 2),
            'utf-8'
        );
    }

    private loadEntries(agentId: string): PublishedEntry[] {
        const filePath = this.publishedFilePath(agentId);
        if (!fs.existsSync(filePath)) { return []; }

        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return [];
        }
    }
}
