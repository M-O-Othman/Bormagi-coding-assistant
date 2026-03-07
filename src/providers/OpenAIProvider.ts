import OpenAI from 'openai';
import { ILLMProvider } from './ILLMProvider';
import { ChatMessage, MCPToolDefinition, StreamEvent } from '../types';

interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  proxyUrl?: string;
  providerLabel?: string;
}

export class OpenAIProvider implements ILLMProvider {
  readonly providerType: string;
  readonly model: string;

  private client: OpenAI;

  constructor(options: OpenAIProviderOptions) {
    this.model = options.model;
    this.providerType = options.providerLabel ?? 'openai';

    const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: options.apiKey
    };

    if (options.baseUrl) {
      clientOptions.baseURL = options.baseUrl;
    }

    if (options.proxyUrl) {
      // Proxy routing is not configured directly here; this label is surfaced for observability.
      this.providerType = `${this.providerType} (proxy: ${options.proxyUrl})`;
    }

    this.client = new OpenAI(clientOptions);
  }

  private collectHeaders(headers: { forEach: (cb: (value: string, key: string) => void) => void }): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower.includes('ratelimit') || lower === 'retry-after' || lower.includes('request-id')) {
        out[lower] = value;
      }
    });
    return out;
  }

  async *stream(
    messages: ChatMessage[],
    tools?: MCPToolDefinition[],
    maxTokens = 4096
  ): AsyncIterable<StreamEvent> {
    const openaiMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content
    }));

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: openaiMessages,
      max_tokens: maxTokens,
      stream: true,
      // Include usage in the final streaming chunk.
      stream_options: { include_usage: true }
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as Record<string, unknown>
        }
      }));
    }

    const { data: stream, response } = await this.client.chat.completions.create(params).withResponse();
    const headers = this.collectHeaders(response.headers);
    if (Object.keys(headers).length > 0) {
      yield { type: 'provider_headers', provider: this.providerType, headers };
    }

    const toolCallAcc = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      // Final chunk with include_usage carries token usage.
      if (chunk.usage) {
        yield {
          type: 'token_usage',
          usage: { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens }
        };
      }

      const choice = chunk.choices[0];
      if (!choice) {
        continue;
      }

      const delta = choice.delta;

      if (delta.content) {
        yield { type: 'text', delta: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallAcc.has(idx)) {
            toolCallAcc.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
          }
          const acc = toolCallAcc.get(idx)!;
          if (tc.id) {
            acc.id = tc.id;
          }
          if (tc.function?.name) {
            acc.name = tc.function.name;
          }
          if (tc.function?.arguments) {
            acc.args += tc.function.arguments;
          }
        }
      }

      if (choice.finish_reason === 'tool_calls') {
        for (const [, tc] of toolCallAcc) {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(tc.args) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
          yield {
            type: 'tool_use',
            id: tc.id || `tool_${Date.now()}`,
            name: tc.name,
            input: parsed
          };
        }
        yield { type: 'done' };
        return;
      }

      if (choice.finish_reason === 'stop') {
        yield { type: 'done' };
        return;
      }
    }

    yield { type: 'done' };
  }
}
