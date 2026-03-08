import * as readline from 'readline';
import { AgentRegistry } from '../../agents/AgentRegistry';
import { FileMessageBus } from '../../collaboration/FileMessageBus';
import { DelegationManager } from '../../collaboration/DelegationManager';

const workspaceRoot = process.argv[2];
if (!workspaceRoot) {
    console.error('Workspace root argument required');
    process.exit(1);
}

// Instantiate shared layer (file-backed)
const registry = new AgentRegistry(workspaceRoot);
registry.load();

const bus = new FileMessageBus(workspaceRoot);
const delegationManager = new DelegationManager(bus, registry);

const tools = [
    {
        name: 'delegate_task',
        description: 'Delegate a sub-task to another agent in the registry. Ensure you have delegation permissions.',
        inputSchema: {
            type: 'object',
            properties: {
                fromAgentId: { type: 'string', description: 'Your active agent ID.' },
                toAgentId: { type: 'string', description: 'The agent ID to delegate to.' },
                taskDescription: { type: 'string', description: 'Detailed instruction for the agent.' }
            },
            required: ['fromAgentId', 'toAgentId', 'taskDescription']
        }
    },
    {
        name: 'share_knowledge',
        description: 'Broadcast important semantic facts to all other agents on the message bus.',
        inputSchema: {
            type: 'object',
            properties: {
                fromAgentId: { type: 'string', description: 'Your active agent ID.' },
                facts: { type: 'array', items: { type: 'string' }, description: 'List of text facts to share.' }
            },
            required: ['fromAgentId', 'facts']
        }
    }
];

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', async (line) => {
    try {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
            console.log(JSON.stringify({ id: msg.id, result: { serverInfo: { name: 'collaboration', version: '1.0.0' }, capabilities: { tools: {} } } }));
        } else if (msg.method === 'tools/list') {
            console.log(JSON.stringify({ id: msg.id, result: { tools } }));
        } else if (msg.method === 'tools/call') {
            const { name, arguments: args } = msg.params;

            if (name === 'delegate_task') {
                try {
                    const messageId = await delegationManager.delegateTask(args.fromAgentId, args.toAgentId, args.taskDescription);
                    console.log(JSON.stringify({
                        id: msg.id,
                        result: { content: [{ type: 'text', text: `Task successfully delegated. Message ID: ${messageId}` }] }
                    }));
                } catch (err: any) {
                    console.log(JSON.stringify({ id: msg.id, result: { content: [{ type: 'text', text: `Delegation failed: ${err.message}` }], isError: true } }));
                }
            } else if (name === 'share_knowledge') {
                try {
                    await delegationManager.broadcastKnowledge(args.fromAgentId, args.facts);
                    console.log(JSON.stringify({
                        id: msg.id,
                        result: { content: [{ type: 'text', text: 'Knowledge successfully broadcasted to the message bus.' }] }
                    }));
                } catch (err: any) {
                    console.log(JSON.stringify({ id: msg.id, result: { content: [{ type: 'text', text: `Broadcast failed: ${err.message}` }], isError: true } }));
                }
            } else {
                console.log(JSON.stringify({ id: msg.id, result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true } }));
            }
        }
    } catch {
        // Ignore malformed json
    }
});
