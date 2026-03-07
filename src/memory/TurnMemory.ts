// ─── Turn memory ─────────────────────────────────────────────────────────────
//
// Ephemeral per-request memory. Holds the current turn's context:
// user message, tool outputs, intermediate results, selected sources.
// Discarded after each request completes unless explicitly promoted.

import type { ChatMessage } from '../types';

/** A turn context holds ephemeral data for a single request/response cycle. */
export interface TurnContext {
    /** The user's message for this turn. */
    userMessage: string;
    /** Results from tool calls made during this turn. */
    toolResults: Array<{ toolName: string; result: string }>;
    /** Retrieved knowledge evidence (if any). */
    evidenceSources: string[];
    /** Timestamp when this turn started. */
    startedAt: string;
}

/**
 * TurnMemory manages ephemeral per-request context.
 * Each agent has its own TurnMemory instance.
 * The turn is created at the start of a request and discarded at the end.
 */
export class TurnMemory {
    private currentTurn: TurnContext | null = null;
    private turnHistory: TurnContext[] = [];
    private maxHistory = 10; // Keep last N turns in-memory for context

    /** Start a new turn. */
    startTurn(userMessage: string): TurnContext {
        this.currentTurn = {
            userMessage,
            toolResults: [],
            evidenceSources: [],
            startedAt: new Date().toISOString(),
        };
        return this.currentTurn;
    }

    /** Get the current turn context. */
    getCurrentTurn(): TurnContext | null {
        return this.currentTurn;
    }

    /** Add a tool result to the current turn. */
    addToolResult(toolName: string, result: string): void {
        if (this.currentTurn) {
            this.currentTurn.toolResults.push({ toolName, result });
        }
    }

    /** Record evidence sources used in this turn. */
    addEvidenceSources(sources: string[]): void {
        if (this.currentTurn) {
            this.currentTurn.evidenceSources.push(...sources);
        }
    }

    /** End the current turn. Moves it to history and clears current. */
    endTurn(): TurnContext | null {
        const ended = this.currentTurn;
        if (ended) {
            this.turnHistory.push(ended);
            // Trim history to max size
            if (this.turnHistory.length > this.maxHistory) {
                this.turnHistory.shift();
            }
        }
        this.currentTurn = null;
        return ended;
    }

    /** Get recent turn history. */
    getRecentTurns(count?: number): TurnContext[] {
        const n = count ?? this.maxHistory;
        return this.turnHistory.slice(-n);
    }

    /** Clear all turn history. */
    clear(): void {
        this.currentTurn = null;
        this.turnHistory = [];
    }
}
