import Anthropic from '@anthropic-ai/sdk';
import { ILLMProvider } from './ILLMProvider';
import { ChatMessage, MCPToolDefinition, StreamEvent } from '../types';

interface AnthropicProviderOptions {
  apiKey: string;
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
      apiKey: options.apiKey
    };

    if (options.baseUrl) {
      clientOptions.baseURL = options.baseUrl;
    }

    this.client = new Anthropic(clientOptions);
  }

  async *stream(
    messages: ChatMessage[],
    tools?: MCPToolDefinition[],
    maxTokens = 4096
  ): AsyncIterable<StreamEvent> {
    // Separate system message from conversation
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');
    const systemPrompt = systemMessages.map(m => m.content).join('\n\n');

    const params: Anthropic.Messages.MessageStreamParams = {
      model: this.model,
      max_tokens: maxTokens,
      messages: conversationMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      }))
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    if (tools && tools.length > 0) {
      params.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema']
      }));
    }

    const stream = this.client.messages.stream(params);

    let pendingToolUseId: string | undefined;
    let pendingToolName: string | undefined;
    let pendingToolInput = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
      if (event.type === 'message_start') {
        // Anthropic reports prompt token count at the start of the stream
        inputTokens = event.message.usage.input_tokens;
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
        // Anthropic reports output token count in the message_delta event
        outputTokens = event.usage.output_tokens;
      } else if (event.type === 'message_stop') {
        if (inputTokens > 0 || outputTokens > 0) {
          yield { type: 'token_usage', usage: { inputTokens, outputTokens } };
        }
        yield { type: 'done' };
        return;
      }
    }

    yield { type: 'done' };
  }
}
