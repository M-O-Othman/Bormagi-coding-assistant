// ─── Memory types ────────────────────────────────────────────────────────────
//
// Type definitions for the three-tier memory system:
//   Tier 1: Turn memory   — ephemeral, per-request
//   Tier 2: Session memory — semantic facts, persisted per session
//   Tier 3: Published knowledge — auto-promoted, durable

/** A semantic fact extracted from conversation. */
export interface MemoryFact {
    /** Unique ID. */
    factId: string;
    /** The fact content (text). */
    content: string;
    /** Confidence score (0–1). */
    confidence: number;
    /** Origin of this fact — 'user', 'agent', 'tool', or 'system'. */
    origin: 'user' | 'agent' | 'tool' | 'system';
    /** ISO timestamp when the fact was first recorded. */
    createdAt: string;
    /** ISO timestamp when last validated/reaffirmed. */
    validationDate: string;
    /** Optional IDs of contradicting facts. */
    contradictionLinks: string[];
    /** The type of fact (decision, assumption, question, observation). */
    factType: 'decision' | 'assumption' | 'open_question' | 'observation' | 'preference';
}

/** A published knowledge entry (promoted from session). */
export interface PublishedEntry {
    /** Unique ID. */
    id: string;
    /** The knowledge content (text). */
    content: string;
    /** ID of the session fact this was promoted from. */
    promotedFrom: string;
    /** The rule that triggered promotion. */
    promotionRule: string;
    /** ISO timestamp of promotion. */
    promotedAt: string;
    /** Original source (agent ID + session ID). */
    source: string;
    /** The type of knowledge. */
    factType: string;
}

/** Configuration for auto-promotion rules. */
export interface PromotionRule {
    /** Rule identifier. */
    id: string;
    /** Human-readable name. */
    name: string;
    /** Whether this rule is enabled. */
    enabled: boolean;
    /** Minimum confidence to promote. */
    minConfidence: number;
    /** Fact types this rule applies to (empty = all). */
    factTypes: string[];
}

/** Session state persisted to disk. */
export interface SessionState {
    /** Session identifier. */
    sessionId: string;
    /** Agent this session belongs to. */
    agentId: string;
    /** ISO timestamp when the session started. */
    startedAt: string;
    /** ISO timestamp of last update. */
    updatedAt: string;
    /** Accumulated facts. */
    facts: MemoryFact[];
}
