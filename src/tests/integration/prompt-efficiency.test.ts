import {
  buildRepoSummary,
  extractQueryTerms,
  formatRelevantContext,
  measureRequestSize,
  minifyToolDefinitions,
  selectRelevantFileSnippets
} from '../../agents/execution/PromptEfficiency';
import type { ChatMessage, MCPToolDefinition } from '../../types';

describe('Prompt efficiency helpers', () => {
  test('extractQueryTerms removes stop words and keeps meaningful terms', () => {
    const terms = extractQueryTerms('Please update the authentication token refresh logic in src/auth/service.ts');
    expect(terms).toContain('authentication');
    expect(terms).toContain('token');
    expect(terms).toContain('src/auth/service.ts');
    expect(terms).not.toContain('please');
    expect(terms).not.toContain('the');
  });

  test('minifyToolDefinitions strips verbose schema fields', () => {
    const tools: MCPToolDefinition[] = [
      {
        name: 'write_file',
        description: 'Write a full file to disk. This includes many details.',
        inputSchema: {
          type: 'object',
          title: 'Write file schema',
          properties: {
            path: { type: 'string', description: 'File path' },
            content: { type: 'string', description: 'File content' }
          },
          required: ['path', 'content']
        }
      }
    ];

    const minified = minifyToolDefinitions(tools);
    expect(minified[0].description.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(minified[0].inputSchema)).not.toContain('description');
    expect(JSON.stringify(minified[0].inputSchema)).not.toContain('title');
  });

  test('selectRelevantFileSnippets ranks files by query relevance', () => {
    const files = [
      {
        relativePath: 'src/auth/service.ts',
        content: 'export function refreshToken() { return "ok"; }'
      },
      {
        relativePath: 'src/ui/view.ts',
        content: 'render main panel'
      }
    ];

    const snippets = selectRelevantFileSnippets(files, 'token refresh service', 2, 200);
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0].relativePath).toBe('src/auth/service.ts');

    const block = formatRelevantContext('token refresh service', snippets);
    expect(block).toContain('[Task-scoped Repository Context]');
    expect(block).toContain('src/auth/service.ts');
  });

  test('buildRepoSummary respects character cap', () => {
    const files = [
      { relativePath: 'README.md', content: '# Project\n\nExample readme body.' },
      { relativePath: 'src/extension.ts', content: 'import * as vscode from "vscode";' },
      { relativePath: 'package.json', content: '{ "name": "example" }' }
    ];

    const summary = buildRepoSummary(files, 140);
    expect(summary.length).toBeLessThanOrEqual(140);
    expect(summary).toContain('Repository Summary');
  });

  test('measureRequestSize returns component and total sizes', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'previous user message' },
      { role: 'assistant', content: 'previous assistant response' }
    ];

    const tools: MCPToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      }
    ];

    const size = measureRequestSize({
      systemPrompt: 'You are a coding assistant.',
      history,
      repoSummaryContext: '[repo summary]',
      retrievalContext: '[retrieval context]',
      userMessage: 'Fix token counting.',
      tools
    });

    expect(size.totalChars).toBeGreaterThan(0);
    expect(size.totalBytes).toBeGreaterThan(0);
    expect(size.estimatedInputTokens).toBeGreaterThan(0);
  });
});
