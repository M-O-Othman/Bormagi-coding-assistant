// ─── Promotion engine ────────────────────────────────────────────────────────
//
// Auto-promotion rules engine for the three-tier memory system.
// Runs after each session turn and promotes qualifying facts
// from session memory to published knowledge.
//
// Initial rule: "always promote" — all session facts get promoted.
// Extensible for future rules (confidence thresholds, type filters, etc.)

import type { MemoryFact, PromotionRule } from './types';
import { SessionMemory } from './SessionMemory';
import { PublishedKnowledge } from './PublishedKnowledge';

/** Default rules — initially just "always promote". */
const DEFAULT_RULES: PromotionRule[] = [
    {
        id: 'always-promote',
        name: 'Always Promote',
        enabled: true,
        minConfidence: 0,
        factTypes: [], // empty = all types
    },
];

/** Log entry for promotion audit. */
export interface PromotionLogEntry {
    timestamp: string;
    agentId: string;
    factId: string;
    ruleName: string;
    factContent: string;
}

export class PromotionEngine {
    private rules: PromotionRule[];
    private promotionLog: PromotionLogEntry[] = [];

    constructor(
        private readonly sessionMemory: SessionMemory,
        private readonly publishedKnowledge: PublishedKnowledge,
        rules?: PromotionRule[]
    ) {
        this.rules = rules || [...DEFAULT_RULES];
    }

    /**
     * Run the promotion engine for an agent.
     * Checks all session facts against promotion rules and promotes qualifying ones.
     *
     * @param agentId   - The agent whose facts to evaluate
     * @param sessionId - The session ID for source tracking
     * @returns Array of promoted entries
     */
    async runPromotion(agentId: string, sessionId: string): Promise<PromotionLogEntry[]> {
        const facts = this.sessionMemory.getFacts(agentId);
        const existingPublished = this.publishedKnowledge.getEntries(agentId);
        const existingContents = new Set(existingPublished.map(e => e.content));
        const promoted: PromotionLogEntry[] = [];

        for (const fact of facts) {
            // Skip if already published (avoid duplicates)
            if (existingContents.has(fact.content)) { continue; }

            // Check against each enabled rule
            for (const rule of this.rules) {
                if (!rule.enabled) { continue; }

                if (this.matchesRule(fact, rule)) {
                    this.publishedKnowledge.promote(agentId, fact, rule.name, sessionId);

                    const logEntry: PromotionLogEntry = {
                        timestamp: new Date().toISOString(),
                        agentId,
                        factId: fact.factId,
                        ruleName: rule.name,
                        factContent: fact.content,
                    };

                    promoted.push(logEntry);
                    this.promotionLog.push(logEntry);
                    existingContents.add(fact.content); // Prevent re-promoting in same run
                    break; // Only promote once per fact (first matching rule wins)
                }
            }
        }

        return promoted;
    }

    /**
     * Check if a fact matches a promotion rule.
     */
    private matchesRule(fact: MemoryFact, rule: PromotionRule): boolean {
        // Check confidence threshold
        if (fact.confidence < rule.minConfidence) { return false; }

        // Check fact type filter (empty = all types pass)
        if (rule.factTypes.length > 0 && !rule.factTypes.includes(fact.factType)) {
            return false;
        }

        return true;
    }

    // ─── Rule management ──────────────────────────────────────────────────

    /** Get current rules. */
    getRules(): PromotionRule[] {
        return [...this.rules];
    }

    /** Update the rules set. */
    setRules(rules: PromotionRule[]): void {
        this.rules = rules;
    }

    /** Add a new rule. */
    addRule(rule: PromotionRule): void {
        this.rules.push(rule);
    }

    /** Remove a rule by ID. */
    removeRule(ruleId: string): boolean {
        const idx = this.rules.findIndex(r => r.id === ruleId);
        if (idx === -1) { return false; }
        this.rules.splice(idx, 1);
        return true;
    }

    /** Get the promotion log. */
    getPromotionLog(): PromotionLogEntry[] {
        return [...this.promotionLog];
    }
}
