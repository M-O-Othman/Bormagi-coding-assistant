// ─── Agent registry ──────────────────────────────────────────────────────────
//
// JSON-based agent registry per workspace.
// Stored at .bormagi/agent-registry.json
// Lists all agents with capabilities, delegation permissions, and constraints.

import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig } from '../types';

// ─── System context agent ──────────────────────────────────────────────────────

/**
 * The ID of the reserved system agent used by the context pipeline for
 * mode classification, history compaction, and summarization.
 *
 * This agent is:
 *  - always present in the registry (recreated with defaults if missing)
 *  - configurable by the user (provider / model / system prompt)
 *  - undeletable (remove() is a no-op for this ID; UI hides the delete button)
 *
 * Spec reference: §OQ-17 / §Section 16.
 */
export const CONTEXT_AGENT_ID = '__bormagi_context_agent__';

/** Default registry entry for the system context agent. */
const DEFAULT_CONTEXT_AGENT_ENTRY: AgentRegistryEntry = {
  id: CONTEXT_AGENT_ID,
  name: 'Bormagi Context Agent',
  category: 'system',
  capabilities: ['chat', 'context-pipeline'],
  delegationPermissions: [],
  acceptsFrom: [],
  concurrencyLimit: 1,
  knowledgeEnabled: false,
};

/** Registry entry for an agent (extends config with registry-level metadata). */
export interface AgentRegistryEntry {
    id: string;
    name: string;
    category: string;
    capabilities: string[];
    delegationPermissions: string[];
    acceptsFrom: string[]; // agent IDs that can delegate to this agent ('*' = all)
    concurrencyLimit: number;
    knowledgeEnabled: boolean;
}

/** The full registry file. */
export interface AgentRegistryData {
    version: string;
    updatedAt: string;
    agents: AgentRegistryEntry[];
}

export class AgentRegistry {
    private data: AgentRegistryData;
    private readonly filePath: string;

    constructor(private readonly workspaceRoot: string) {
        this.filePath = path.join(workspaceRoot, '.bormagi', 'agent-registry.json');
        this.data = {
            version: '1.0.0',
            updatedAt: new Date().toISOString(),
            agents: [],
        };
    }

    /** Load registry from disk. */
    load(): void {
        if (fs.existsSync(this.filePath)) {
            try {
                this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            } catch {
                console.warn('AgentRegistry: Failed to load, using empty registry');
            }
        }
        // Always guarantee the system context agent is present after loading.
        this.ensureContextAgent();
    }

    /**
     * Remove an agent entry from the registry.
     * This is a no-op for the system context agent (`CONTEXT_AGENT_ID`) — it
     * cannot be deleted.
     */
    remove(agentId: string): void {
        if (agentId === CONTEXT_AGENT_ID) { return; }
        this.data.agents = this.data.agents.filter(a => a.id !== agentId);
        this.save();
    }

    /** Persist registry to disk. */
    save(): void {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        this.data.updatedAt = new Date().toISOString();
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    }

    /**
     * Sync the registry with the current agent configs.
     * Adds new agents, removes deleted ones, preserves user edits to permissions/capabilities.
     */
    syncWithAgents(agents: AgentConfig[]): void {
        const existingIds = new Set(this.data.agents.map(a => a.id));
        const currentIds = new Set(agents.map(a => a.id));

        // Add new agents
        for (const agent of agents) {
            if (!existingIds.has(agent.id)) {
                this.data.agents.push({
                    id: agent.id,
                    name: agent.name,
                    category: agent.category,
                    capabilities: this.inferCapabilities(agent),
                    delegationPermissions: ['*'],
                    acceptsFrom: ['*'],
                    concurrencyLimit: 1,
                    knowledgeEnabled: !!agent.knowledge?.source_folders?.length,
                });
            } else {
                // Update name/category but preserve user-set fields
                const existing = this.data.agents.find(a => a.id === agent.id)!;
                existing.name = agent.name;
                existing.category = agent.category;
                existing.knowledgeEnabled = !!agent.knowledge?.source_folders?.length;
            }
        }

        // Remove agents no longer in config — but always keep the system context agent.
        this.data.agents = this.data.agents.filter(
          a => currentIds.has(a.id) || a.id === CONTEXT_AGENT_ID,
        );

        // Ensure the system context agent exists (recreate with defaults if missing).
        this.ensureContextAgent();
        this.save();
    }

    /** Get all registered agents. */
    getAll(): AgentRegistryEntry[] {
        return this.data.agents;
    }

    /** Get a specific agent entry. */
    get(agentId: string): AgentRegistryEntry | undefined {
        return this.data.agents.find(a => a.id === agentId);
    }

    /** Update an agent's registry entry. */
    update(agentId: string, updates: Partial<Omit<AgentRegistryEntry, 'id'>>): void {
        const entry = this.data.agents.find(a => a.id === agentId);
        if (entry) {
            Object.assign(entry, updates);
            this.save();
        }
    }

    /** Check if agentA can delegate to agentB. */
    canDelegate(fromAgentId: string, toAgentId: string): boolean {
        const target = this.data.agents.find(a => a.id === toAgentId);
        if (!target) { return false; }
        return target.acceptsFrom.includes('*') || target.acceptsFrom.includes(fromAgentId);
    }

    // ─── Private ───────────────────────────────────────────────────────────

    /**
     * Ensure the system context agent entry exists in the registry.
     * If it is absent (e.g., first run or accidental deletion from JSON),
     * it is recreated with default values.
     */
    private ensureContextAgent(): void {
        const exists = this.data.agents.some(a => a.id === CONTEXT_AGENT_ID);
        if (!exists) {
            this.data.agents.push({ ...DEFAULT_CONTEXT_AGENT_ENTRY });
        }
    }

    /** Infer capabilities from agent config. */
    private inferCapabilities(agent: AgentConfig): string[] {
        const caps: string[] = ['chat'];
        if (agent.mcp_servers?.length > 0) { caps.push('tools'); }
        if (agent.knowledge?.source_folders?.length) { caps.push('knowledge'); }
        return caps;
    }
}
