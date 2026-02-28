import { ChatMessage, MCPToolDefinition, StreamEvent } from '../types';

export interface ILLMProvider {
  /**
   * Stream a chat completion. Yields StreamEvents: text deltas, tool_use calls, and a final done.
   */
  stream(
    messages: ChatMessage[],
    tools?: MCPToolDefinition[],
    maxTokens?: number
  ): AsyncIterable<StreamEvent>;

  /** Provider identifier for display purposes. */
  readonly providerType: string;
  readonly model: string;
}
