import { FileMessageBus, AgentMessage } from './FileMessageBus';
import { AgentRegistry } from '../agents/AgentRegistry';

/**
 * Manages task delegation and knowledge sharing between agents.
 * Enforces `canDelegate` constraints from the AgentRegistry JSON store.
 */
export class DelegationManager {
    constructor(
        private readonly bus: FileMessageBus,
        private readonly registry: AgentRegistry
    ) { }

    /**
     * Send a task_delegation message from one agent to another.
     */
    async delegateTask(fromAgentId: string, toAgentId: string, taskDescription: string): Promise<string> {
        // Enforce constraints
        if (!this.registry.canDelegate(fromAgentId, toAgentId)) {
            throw new Error(`Agent ${fromAgentId} is not allowed to delegate tasks to ${toAgentId}`);
        }

        const messageId = FileMessageBus.createMessageId();
        const message: AgentMessage = {
            id: messageId,
            type: 'task_delegation',
            from: fromAgentId,
            to: toAgentId,
            payload: { description: taskDescription },
            requires_response: true,
            timestamp: new Date().toISOString()
        };

        await this.bus.send(message);
        return messageId;
    }

    /**
     * Reply to a previous task with results.
     */
    async sendTaskResult(fromAgentId: string, toAgentId: string, result: string, parentMessageId: string): Promise<void> {
        const message: AgentMessage = {
            id: FileMessageBus.createMessageId(),
            type: 'task_result',
            from: fromAgentId,
            to: toAgentId,
            parent_message_id: parentMessageId,
            payload: { result },
            requires_response: false,
            timestamp: new Date().toISOString()
        };

        await this.bus.send(message);
    }

    /**
     * Broadcast a knowledge_share message pushing context to all relevant agents.
     */
    async broadcastKnowledge(fromAgentId: string, knowledge: string[]): Promise<void> {
        const message: Omit<AgentMessage, 'to'> = {
            id: FileMessageBus.createMessageId(),
            type: 'knowledge_share',
            from: fromAgentId,
            payload: { facts: knowledge },
            requires_response: false,
            timestamp: new Date().toISOString()
        };

        await this.bus.broadcast(message);
    }
}
