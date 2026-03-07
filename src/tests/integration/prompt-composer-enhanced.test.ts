// ─── Prompt composer enhanced tests ──────────────────────────────────────────

import { PromptComposer } from '../../agents/PromptComposer';
import { __setTestData } from '../../data/DataStore';
// Mock ConfigManager with readPromptFile
const mockConfigManager = {
    readProjectConfig: jest.fn().mockResolvedValue({
        project: { name: 'test-project', created_at: '2024-01-01' },
        agents: [],
    }),
    readDefaultProvider: jest.fn().mockResolvedValue(null),
    readPromptFile: jest.fn().mockResolvedValue(''),
    bormagiDir: '/tmp/test/.bormagi',
    auditLogPath: '/tmp/test/.bormagi/audit.log',
    agentsDir: '/tmp/test/.bormagi/agents',
    ensureBormagiDir: jest.fn(),
    writeProjectConfig: jest.fn(),
    writeDefaultProvider: jest.fn(),
};

describe('PromptComposer', () => {
    let composer: PromptComposer;

    beforeEach(() => {
        jest.clearAllMocks();
        // Initialize DataStore with a test default prompt
        __setTestData({
            defaultSystemPrompt: 'You are {{name}}, a {{category}} agent. {{description}}',
        });
        // Default: readPromptFile returns empty string → triggers defaultPrompt
        mockConfigManager.readPromptFile.mockResolvedValue('');
        composer = new PromptComposer(mockConfigManager as any);
    });

    // ─── Basic prompt assembly ────────────────────────────────────────────

    describe('compose', () => {
        it('returns a non-empty string', async () => {
            const prompt = await composer.compose(
                {
                    id: 'test-agent',
                    name: 'Test Agent',
                    category: 'Custom Agent',
                    description: 'A test agent.',
                    enabled: true,
                    provider: { type: 'openai', model: 'gpt-4', base_url: null, proxy_url: null, auth_method: 'api_key' as const },
                    system_prompt_files: ['system-prompt.md'],
                    mcp_servers: [],
                    context_filter: { include_extensions: [], exclude_patterns: [] },
                },
                'test-project'
            );

            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(0);
        });

        it('falls back to default prompt when no prompt files have content', async () => {
            mockConfigManager.readPromptFile.mockResolvedValue('');
            const prompt = await composer.compose(
                {
                    id: 'test-agent',
                    name: 'Solution Architect',
                    category: 'Custom Agent',
                    description: 'Designs system architecture.',
                    enabled: true,
                    provider: { type: 'openai', model: 'gpt-4', base_url: null, proxy_url: null, auth_method: 'api_key' as const },
                    system_prompt_files: ['system-prompt.md'],
                    mcp_servers: [],
                    context_filter: { include_extensions: [], exclude_patterns: [] },
                },
                'test-project'
            );

            // The default prompt should reference the agent name
            expect(prompt.toLowerCase()).toContain('solution architect');
        });

        it('uses content from prompt files when available', async () => {
            mockConfigManager.readPromptFile.mockResolvedValue('You are a custom agent assistant.');
            const prompt = await composer.compose(
                {
                    id: 'test-agent',
                    name: 'Test Agent',
                    category: 'Custom Agent',
                    description: 'Test.',
                    enabled: true,
                    provider: { type: 'openai', model: 'gpt-4', base_url: null, proxy_url: null, auth_method: 'api_key' as const },
                    system_prompt_files: ['system-prompt.md'],
                    mcp_servers: [],
                    context_filter: { include_extensions: [], exclude_patterns: [] },
                },
                'test-project'
            );

            expect(prompt).toContain('custom agent assistant');
        });
    });

    // ─── Evidence injection ───────────────────────────────────────────────

    describe('evidence injection', () => {
        it('injects knowledge evidence when provided', async () => {
            const evidence = '[Evidence from Knowledge Base]\nSource: readme.md\nContent here.\n[End of Evidence]';

            const prompt = await composer.compose(
                {
                    id: 'test-agent',
                    name: 'Test Agent',
                    category: 'Custom Agent',
                    description: 'Test.',
                    enabled: true,
                    provider: { type: 'openai', model: 'gpt-4', base_url: null, proxy_url: null, auth_method: 'api_key' as const },
                    system_prompt_files: ['system-prompt.md'],
                    mcp_servers: [],
                    context_filter: { include_extensions: [], exclude_patterns: [] },
                },
                'test-project',
                evidence
            );

            expect(prompt).toContain('Evidence from Knowledge Base');
            expect(prompt).toContain('readme.md');
        });

        it('does not include evidence block when not provided', async () => {
            const prompt = await composer.compose(
                {
                    id: 'test-agent',
                    name: 'Test Agent',
                    category: 'Custom Agent',
                    description: 'Test.',
                    enabled: true,
                    provider: { type: 'openai', model: 'gpt-4', base_url: null, proxy_url: null, auth_method: 'api_key' as const },
                    system_prompt_files: ['system-prompt.md'],
                    mcp_servers: [],
                    context_filter: { include_extensions: [], exclude_patterns: [] },
                },
                'test-project'
            );

            expect(prompt).not.toContain('[Evidence from Knowledge Base]');
        });

        it('appends citation contract when evidence is present', async () => {
            const evidence = '[Evidence from Knowledge Base]\nSome evidence.\n[End of Evidence]';

            const prompt = await composer.compose(
                {
                    id: 'test-agent',
                    name: 'Test Agent',
                    category: 'Custom Agent',
                    description: 'Test.',
                    enabled: true,
                    provider: { type: 'openai', model: 'gpt-4', base_url: null, proxy_url: null, auth_method: 'api_key' as const },
                    system_prompt_files: ['system-prompt.md'],
                    mcp_servers: [],
                    context_filter: { include_extensions: [], exclude_patterns: [] },
                },
                'test-project',
                evidence
            );

            expect(prompt).toContain('[Output Guidelines]');
            expect(prompt).toContain('Cite');
        });

        it('does not append citation contract without evidence', async () => {
            const prompt = await composer.compose(
                {
                    id: 'test-agent',
                    name: 'Test Agent',
                    category: 'Custom Agent',
                    description: 'Test.',
                    enabled: true,
                    provider: { type: 'openai', model: 'gpt-4', base_url: null, proxy_url: null, auth_method: 'api_key' as const },
                    system_prompt_files: ['system-prompt.md'],
                    mcp_servers: [],
                    context_filter: { include_extensions: [], exclude_patterns: [] },
                },
                'test-project'
            );

            expect(prompt).not.toContain('[Output Guidelines]');
        });
    });
});
