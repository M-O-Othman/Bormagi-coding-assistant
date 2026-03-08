import * as fs from 'fs';
import * as path from 'path';
export type MessageType = 'task_delegation' | 'knowledge_share' | 'task_result';

export interface AgentMessage {
    id: string;
    type: MessageType;
    from: string;
    to: string;
    thread_id?: string;
    parent_message_id?: string;
    payload: Record<string, unknown>;
    requires_response: boolean;
    timestamp: string;
}

export type MessageHandler = (message: AgentMessage) => Promise<void>;

/**
 * MessageBusClient defines the protocol for agents to communicate locally.
 */
export interface MessageBusClient {
    connect(agentId: string): Promise<void>;
    send(message: AgentMessage): Promise<void>;
    broadcast(message: Omit<AgentMessage, 'to'>): Promise<void>;
    subscribe(type: MessageType, handler: MessageHandler): void;
    getUnread(): Promise<AgentMessage[]>;
}

/**
 * FileMessageBus implements a simple file-based Message Bus for inter-agent asynchronous
 * communication without heavy external dependencies like Redis.
 */
export class FileMessageBus implements MessageBusClient {
    private handlers: Map<MessageType, MessageHandler[]> = new Map();
    private globalHandlers: MessageHandler[] = [];
    private watcher?: any;
    private agentId: string = '';
    private readonly busDir: string;

    constructor(workspaceRoot: string) {
        this.busDir = path.join(workspaceRoot, '.bormagi', 'shared', 'bus');
    }

    async connect(agentId: string): Promise<void> {
        this.agentId = agentId;
        const inboxDir = path.join(this.busDir, agentId, 'inbox');

        if (!fs.existsSync(inboxDir)) {
            fs.mkdirSync(inboxDir, { recursive: true });
        }

        // Watch inbox for new messages in real-time
        const chokidar = await import('chokidar');
        this.watcher = chokidar.watch(inboxDir, { ignoreInitial: true });
        this.watcher.on('add', async (filePath: string) => {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const message: AgentMessage = JSON.parse(content);
                await this.dispatch(message);

                // Optionally move to 'processed' or delete after handling
                fs.unlinkSync(filePath);
            } catch (err) {
                console.error(`FileMessageBus: Failed to process incoming file ${filePath}`, err);
            }
        });
    }

    async send(message: AgentMessage): Promise<void> {
        const targetDir = path.join(this.busDir, message.to, 'inbox');
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const filePath = path.join(targetDir, `${message.id}.json`);
        // Atomic write approach (write then rename could be safer but fine for local simple dev)
        fs.writeFileSync(filePath, JSON.stringify(message, null, 2), 'utf-8');
    }

    async broadcast(message: Omit<AgentMessage, 'to'>): Promise<void> {
        if (!fs.existsSync(this.busDir)) { return; }
        const agents = fs.readdirSync(this.busDir);

        for (const agent of agents) {
            if (agent !== this.agentId && fs.statSync(path.join(this.busDir, agent)).isDirectory()) {
                await this.send({ ...message, to: agent } as AgentMessage);
            }
        }
    }

    subscribe(type: MessageType, handler: MessageHandler): void {
        const existing = this.handlers.get(type) || [];
        existing.push(handler);
        this.handlers.set(type, existing);
    }

    async getUnread(): Promise<AgentMessage[]> {
        const inboxDir = path.join(this.busDir, this.agentId, 'inbox');
        if (!fs.existsSync(inboxDir)) return [];

        const unread: AgentMessage[] = [];
        const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));

        for (const file of files) {
            try {
                const data = fs.readFileSync(path.join(inboxDir, file), 'utf-8');
                unread.push(JSON.parse(data) as AgentMessage);
            } catch {
                // Ignore parse errors safely
            }
        }
        return unread;
    }

    private async dispatch(message: AgentMessage): Promise<void> {
        const typeHandlers = this.handlers.get(message.type) || [];
        for (const handler of [...typeHandlers, ...this.globalHandlers]) {
            try {
                await handler(message);
            } catch (err) {
                console.error('FileMessageBus: Handler execution failed', err);
            }
        }
    }

    static createMessageId(): string {
        return `MSG-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    }
}
