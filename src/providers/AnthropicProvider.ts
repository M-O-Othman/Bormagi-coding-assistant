import Anthropic from '@anthropic-ai/sdk';
import { ILLMProvider } from './ILLMProvider';
import { ChatMessage, MCPToolDefinition, StreamEvent } from '../types';

interface AnthropicProviderOptions {
  credential?: string;
  authMethod?: 'api_key' | 'subscription';
  model: string;
  baseUrl?: string;
  proxyUrl?: string;
}

export class AnthropicProvider implements ILLMProvider {
  readonly providerType = 'anthropic';
  readonly model: string;

  private client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;

    const clientOptions: ConstructorParameters<typeof Anthropic>[0] = {
      apiKey: options.authMethod === 'subscription' ? undefined : options.credential,
      authToken: options.authMethod === 'subscription' ? options.credential : undefined
    };

    if (options.baseUrl) {
      clientOptions.baseURL = options.baseUrl;
    }

    this.client = new Anthropic(clientOptions);
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

  private shouldCacheMessageContent(content: string): boolean {
    return content.startsWith('[Bootstrap phase:')
      || content.startsWith('[Long-term memory')
      || content.startsWith('[Task-scoped Repository Context]');
  }

  private toPromptCachingMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages
      .filter(m => m.role !== 'system')
      .map(m => {
        const block: Record<string, unknown> = {
          type: 'text',
          text: m.content
        };
        if (this.shouldCacheMessageContent(m.content)) {
          block.cache_control = { type: 'ephemeral' };
        }
        return {
          role: m.role as 'user' | 'assistant',
          content: [block]
        };
      });
  }

  async *stream(
    messages: ChatMessage[],
    tools?: MCPToolDefinition[],
    maxTokens = 4096
  ): AsyncIterable<StreamEvent> {
    const systemPrompt = messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n\n');

    const promptCachingParams: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      stream: true,
      messages: this.toPromptCachingMessages(messages)
    };

    if (systemPrompt) {
      promptCachingParams.system = [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ];
    }

    if (tools && tools.length > 0) {
      promptCachingParams.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        cache_control: { type: 'ephemeral' }
      }));
    }

    let streamSource: AsyncIterable<any>;

    try {
      const responseWithStream = await (this.client.beta.promptCaching.messages
        .create(promptCachingParams as any) as any)
        .withResponse();

      const headers = this.collectHeaders(responseWithStream.response.headers);
      if (Object.keys(headers).length > 0) {
        yield { type: 'provider_headers', provider: this.providerType, headers };
      }

      streamSource = responseWithStream.data as AsyncIterable<any>;
    } catch {
      // Fallback for models/accounts where prompt-caching endpoint is unavailable.
      const fallbackParams: Anthropic.Messages.MessageStreamParams = {
        model: this.model,
        max_tokens: maxTokens,
        messages: messages
          .filter(m => m.role !== 'system')
          .map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content
          }))
      };

      if (systemPrompt) {
        fallbackParams.system = systemPrompt;
      }

      if (tools && tools.length > 0) {
        fallbackParams.tools = tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema']
        }));
      }

      streamSource = this.client.messages.stream(fallbackParams);
    }

    let pendingToolUseId: string | undefined;
    let pendingToolName: string | undefined;
    let pendingToolInput = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationInputTokens = 0;
    let cacheReadInputTokens = 0;

    for await (const event of streamSource) {
      if (event.type === 'message_start') {
        inputTokens = event.message?.usage?.input_tokens ?? 0;
        cacheCreationInputTokens = event.message?.usage?.cache_creation_input_tokens ?? 0;
        cacheReadInputTokens = event.message?.usage?.cache_read_input_tokens ?? 0;
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          pendingToolUseId = event.content_block.id;
          pendingToolName = event.content_block.name;
          pendingToolInput = '';
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', delta: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          pendingToolInput += event.delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        if (pendingToolUseId && pendingToolName) {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(pendingToolInput) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
          yield {
            type: 'tool_use',
            id: pendingToolUseId,
            name: pendingToolName,
            input: parsed
          };
          pendingToolUseId = undefined;
          pendingToolName = undefined;
          pendingToolInput = '';
        }
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage?.output_tokens ?? outputTokens;
      } else if (event.type === 'message_stop') {
        if (inputTokens > 0 || outputTokens > 0 || cacheCreationInputTokens > 0 || cacheReadInputTokens > 0) {
          yield {
            type: 'token_usage',
            usage: {
              inputTokens,
              outputTokens,
              cacheCreationInputTokens,
              cacheReadInputTokens
            }
          };
        }
        yield { type: 'done' };
        return;
      }
    }

    yield { type: 'done' };
  }
}
