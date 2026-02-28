import {
  GoogleGenerativeAI,
  GenerativeModel,
  Content,
  Tool as GeminiTool,
  FunctionDeclaration
} from '@google/generative-ai';
import { ILLMProvider } from './ILLMProvider';
import { ChatMessage, MCPToolDefinition, StreamEvent } from '../types';
import * as childProcess from 'child_process';

interface GeminiProviderOptions {
  /** API key. Leave empty when using GCP ADC (auth_method = 'gcp_adc'). */
  apiKey?: string;
  model: string;
  authMethod: 'api_key' | 'gcp_adc';
  baseUrl?: string;
  proxyUrl?: string;
}

export class GeminiProvider implements ILLMProvider {
  readonly providerType = 'gemini';
  readonly model: string;

  private genAI: GoogleGenerativeAI;
  private geminiModel: GenerativeModel;

  constructor(options: GeminiProviderOptions) {
    this.model = options.model;

    let effectiveApiKey = options.apiKey ?? '';

    if (options.authMethod === 'gcp_adc' && !effectiveApiKey) {
      // Attempt to get an access token from Application Default Credentials via gcloud CLI.
      // This allows corporate SSO users to authenticate without a separate API key.
      effectiveApiKey = this.getAdcAccessToken();
    }

    this.genAI = new GoogleGenerativeAI(effectiveApiKey);
    this.geminiModel = this.genAI.getGenerativeModel({ model: options.model });
  }

  private getAdcAccessToken(): string {
    try {
      const result = childProcess.execSync(
        'gcloud auth print-access-token',
        { encoding: 'utf8', timeout: 5000 }
      );
      return result.trim();
    } catch {
      throw new Error(
        'Bormagi: Could not obtain a GCP access token. ' +
        'Run "gcloud auth application-default login" or provide an API key.'
      );
    }
  }

  async *stream(
    messages: ChatMessage[],
    tools?: MCPToolDefinition[],
    maxTokens = 4096
  ): AsyncIterable<StreamEvent> {
    // Build Gemini history (all but last user message)
    const history: Content[] = [];
    let lastUserMessage = '';

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Prepend system as a user/model pair (Gemini does not have a system role)
        history.push({ role: 'user', parts: [{ text: `[System instruction]\n${msg.content}` }] });
        history.push({ role: 'model', parts: [{ text: 'Understood.' }] });
      } else if (msg.role === 'user') {
        lastUserMessage = msg.content;
        if (messages.indexOf(msg) < messages.length - 1) {
          history.push({ role: 'user', parts: [{ text: msg.content }] });
        }
      } else if (msg.role === 'assistant') {
        history.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }

    const geminiTools: GeminiTool[] | undefined =
      tools && tools.length > 0
        ? [
            {
              functionDeclarations: tools.map(
                (t): FunctionDeclaration => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema as unknown as FunctionDeclaration['parameters']
                })
              )
            }
          ]
        : undefined;

    const chat = this.geminiModel.startChat({
      history,
      generationConfig: { maxOutputTokens: maxTokens },
      tools: geminiTools
    });

    const result = await chat.sendMessageStream(lastUserMessage);

    let lastInputTokens = 0;
    let lastOutputTokens = 0;

    for await (const chunk of result.stream) {
      // Capture token usage from the metadata sent on each chunk (last value wins)
      if (chunk.usageMetadata) {
        lastInputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
        lastOutputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
      }

      const candidates = chunk.candidates;
      if (!candidates || candidates.length === 0) {
        continue;
      }

      for (const candidate of candidates) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            yield { type: 'text', delta: part.text };
          }
          if (part.functionCall) {
            yield {
              type: 'tool_use',
              id: `gemini_fn_${Date.now()}`,
              name: part.functionCall.name,
              input: (part.functionCall.args ?? {}) as Record<string, unknown>
            };
          }
        }
      }
    }

    if (lastInputTokens > 0 || lastOutputTokens > 0) {
      yield { type: 'token_usage', usage: { inputTokens: lastInputTokens, outputTokens: lastOutputTokens } };
    }

    yield { type: 'done' };
  }
}
