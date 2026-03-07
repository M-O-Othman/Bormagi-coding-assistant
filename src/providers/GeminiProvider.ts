import {
  GoogleGenerativeAI,
  Content,
  Tool as GeminiTool,
  FunctionDeclaration
} from '@google/generative-ai';
import { ILLMProvider } from './ILLMProvider';
import { ChatMessage, MCPToolDefinition, StreamEvent } from '../types';
import * as childProcess from 'child_process';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';

interface GeminiProviderOptions {
  /** API key. Leave empty for OAuth / Vertex modes. */
  apiKey?: string;
  model: string;
  authMethod: 'api_key' | 'oauth_proxy' | 'vertex_ai' | 'gcp_adc';
  baseUrl?: string;
  proxyUrl?: string;
  /** GCP region for Vertex AI, e.g. "europe-west4". Overrides env vars when set. */
  vertexLocation?: string;
}

export class GeminiProvider implements ILLMProvider {
  readonly providerType = 'gemini';
  readonly model: string;
  private readonly authMethod: 'api_key' | 'oauth_proxy' | 'vertex_ai';
  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly proxyUrl?: string;
  private readonly vertexLocation?: string;
  private readonly apiClient: GoogleGenerativeAI | null;

  constructor(options: GeminiProviderOptions) {
    this.model = options.model;
    this.authMethod = options.authMethod === 'gcp_adc' ? 'vertex_ai' : options.authMethod;
    this.apiKey = options.apiKey?.trim() ?? '';
    this.baseUrl = options.baseUrl?.trim() || undefined;
    this.proxyUrl = options.proxyUrl?.trim() || undefined;
    this.vertexLocation = options.vertexLocation?.trim() || undefined;

    if (this.authMethod === 'api_key') {
      if (!this.apiKey) {
        throw new Error('Bormagi: Gemini API Key mode requires an API key.');
      }
      this.apiClient = new GoogleGenerativeAI(this.apiKey);
      return;
    }

    // OAuth-based modes use direct HTTPS calls with Bearer auth.
    this.apiClient = null;
  }

  private tryPrintAccessToken(command: string): string | null {
    try {
      const result = childProcess.execSync(command, { encoding: 'utf8', timeout: 8000 });
      const token = result.trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  private getAccessToken(): string {
    // Prefer ADC for Vertex/enterprise flows, fallback to user login token.
    const adcToken = this.tryPrintAccessToken('gcloud auth application-default print-access-token');
    if (adcToken) {
      return adcToken;
    }

    const userToken = this.tryPrintAccessToken('gcloud auth print-access-token');
    if (userToken) {
      return userToken;
    }

    throw new Error(
      'Bormagi: Could not obtain a GCP access token. ' +
      'Run "gcloud auth application-default login" (recommended) or "gcloud auth login".'
    );
  }

  private getGcpProjectId(): string {
    const fromEnv = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
    if (fromEnv?.trim()) {
      return fromEnv.trim();
    }

    try {
      const result = childProcess.execSync(
        'gcloud config get-value project',
        { encoding: 'utf8', timeout: 5000 }
      );
      const project = result.trim();
      if (!project || project === '(unset)') {
        throw new Error('No project configured');
      }
      return project;
    } catch {
      throw new Error(
        'Bormagi: Could not resolve GCP project for Vertex AI. ' +
        'Set GOOGLE_CLOUD_PROJECT or run "gcloud config set project YOUR_PROJECT_ID".'
      );
    }
  }

  private getVertexLocation(): string {
    return (
      this.vertexLocation ||
      process.env.GOOGLE_CLOUD_LOCATION ||
      process.env.GCP_LOCATION ||
      'us-central1'
    ).trim();
  }

  private stripTrailingSlash(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private parsePossibleJsonPayload(raw: string): unknown[] {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  private collectHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower.includes('ratelimit') || lower === 'retry-after' || lower.includes('request-id')) {
        out[lower] = value;
      }
    });
    return out;
  }

  private getDeveloperEndpointBase(): string {
    const raw = this.proxyUrl || this.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    return this.stripTrailingSlash(raw);
  }

  private getDeveloperModelPath(): string {
    return this.model.startsWith('models/') ? this.model : `models/${this.model}`;
  }

  private buildOAuthEndpointAndHeaders(): { url: string; headers: Record<string, string> } {
    const token = this.getAccessToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    };

    if (this.authMethod === 'oauth_proxy') {
      const base = this.getDeveloperEndpointBase();
      const url = `${base}/${this.getDeveloperModelPath()}:streamGenerateContent?alt=sse`;
      return { url, headers };
    }

    const projectId = this.getGcpProjectId();
    const location = this.getVertexLocation();
    headers['x-goog-user-project'] = projectId;
    // proxyUrl is a network proxy, not the API endpoint — use baseUrl or the default
    const base = this.stripTrailingSlash(this.baseUrl || `https://${location}-aiplatform.googleapis.com/v1`);
    const modelId = this.model.replace(/^models\//, '');
    const url = `${base}/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:streamGenerateContent?alt=sse`;
    return { url, headers };
  }

  private buildGeminiPayload(
    messages: ChatMessage[],
    tools: MCPToolDefinition[] | undefined,
    maxTokens: number
  ): Record<string, unknown> {
    const history: Content[] = [];
    let lastUserMessage = '';

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system') {
        // Gemini API has no explicit system role in message history.
        history.push({ role: 'user', parts: [{ text: `[System instruction]\n${msg.content}` }] });
        history.push({ role: 'model', parts: [{ text: 'Understood.' }] });
      } else if (msg.role === 'user') {
        lastUserMessage = msg.content;
        if (i < messages.length - 1) {
          history.push({ role: 'user', parts: [{ text: msg.content }] });
        }
      } else if (msg.role === 'assistant') {
        history.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }

    const contents: Content[] = [...history];
    if (lastUserMessage) {
      contents.push({ role: 'user', parts: [{ text: lastUserMessage }] });
    }

    const payload: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: maxTokens }
    };

    if (tools && tools.length > 0) {
      const geminiTools: GeminiTool[] = [
        {
          functionDeclarations: tools.map(
            (t): FunctionDeclaration => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema as unknown as FunctionDeclaration['parameters']
            })
          )
        }
      ];
      payload.tools = geminiTools;
    }

    return payload;
  }

  private async *streamViaApiKeySdk(
    payloadMessages: ChatMessage[],
    tools: MCPToolDefinition[] | undefined,
    maxTokens: number
  ): AsyncIterable<StreamEvent> {
    const history: Content[] = [];
    let lastUserMessage = '';

    for (let i = 0; i < payloadMessages.length; i++) {
      const msg = payloadMessages[i];
      if (msg.role === 'system') {
        history.push({ role: 'user', parts: [{ text: `[System instruction]\n${msg.content}` }] });
        history.push({ role: 'model', parts: [{ text: 'Understood.' }] });
      } else if (msg.role === 'user') {
        lastUserMessage = msg.content;
        if (i < payloadMessages.length - 1) {
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

    if (!this.apiClient) {
      throw new Error('Bormagi: Gemini API client is not initialised for API key mode.');
    }

    // The API-key SDK stream does not expose raw HTTP headers; emit this explicitly for observability.
    yield {
      type: 'provider_headers',
      provider: this.providerType,
      headers: { note: 'headers_unavailable_in_gemini_api_key_sdk_mode' }
    };

    const requestOptions = this.baseUrl
      ? { baseUrl: this.stripTrailingSlash(this.baseUrl) }
      : undefined;

    const chat = this.apiClient.getGenerativeModel({ model: this.model }, requestOptions).startChat({
      history,
      generationConfig: { maxOutputTokens: maxTokens },
      tools: geminiTools
    });

    const result = await chat.sendMessageStream(lastUserMessage);

    let lastInputTokens = 0;
    let lastOutputTokens = 0;
    let emittedOutput = false;
    let emptyReason = '';

    for await (const chunk of result.stream) {
      if (chunk.usageMetadata) {
        lastInputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
        lastOutputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
      }

      const candidates = chunk.candidates;
      if (!candidates || candidates.length === 0) {
        continue;
      }

      for (const candidate of candidates) {
        const finishReason = candidate.finishReason;
        if (!emptyReason && typeof finishReason === 'string' && finishReason !== 'STOP') {
          emptyReason = `finish reason: ${finishReason}`;
        }

        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            yield { type: 'text', delta: part.text };
            emittedOutput = true;
          }
          if (part.functionCall) {
            yield {
              type: 'tool_use',
              id: `gemini_fn_${Date.now()}`,
              name: part.functionCall.name,
              input: (part.functionCall.args ?? {}) as Record<string, unknown>
            };
            emittedOutput = true;
          }
        }
      }
    }

    if (!emittedOutput) {
      const detail = emptyReason ? ` (${emptyReason})` : '';
      yield {
        type: 'text',
        delta: `Gemini returned an empty response${detail}. Please try again or adjust the prompt/model settings.`
      };
    }

    if (lastInputTokens > 0 || lastOutputTokens > 0) {
      yield { type: 'token_usage', usage: { inputTokens: lastInputTokens, outputTokens: lastOutputTokens } };
    }

    yield { type: 'done' };
  }

  /** Wraps fetch to route through an HTTP network proxy when proxyUrl is set. */
  private fetchWithOptionalProxy(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string }
  ): Promise<Response> {
    if (!this.proxyUrl || this.authMethod !== 'vertex_ai') {
      return fetch(url, init);
    }

    const agent = new HttpsProxyAgent(this.proxyUrl);
    const parsed = new URL(url);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : 443,
          path: parsed.pathname + parsed.search,
          method: init.method,
          headers: { ...init.headers, 'Content-Length': Buffer.byteLength(init.body) },
          agent
        },
        (res) => {
          const readable = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
              res.on('end', () => controller.close());
              res.on('error', (err: Error) => controller.error(err));
            }
          });

          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders[key] = value;
            } else if (Array.isArray(value)) {
              responseHeaders[key] = value.join(', ');
            }
          }

          resolve(new Response(readable, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders
          }));
        }
      );
      req.on('error', reject);
      req.write(init.body);
      req.end();
    });
  }

  private async *streamViaOAuthFetch(
    messages: ChatMessage[],
    tools: MCPToolDefinition[] | undefined,
    maxTokens: number
  ): AsyncIterable<StreamEvent> {
    const { url, headers } = this.buildOAuthEndpointAndHeaders();
    const payload = this.buildGeminiPayload(messages, tools, maxTokens);

    const response = await this.fetchWithOptionalProxy(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const headerSnapshot = this.collectHeaders(response.headers);
    if (Object.keys(headerSnapshot).length > 0) {
      yield { type: 'provider_headers', provider: this.providerType, headers: headerSnapshot };
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Gemini ${this.authMethod} request failed (${response.status} ${response.statusText}): ${errBody}`);
    }

    if (!response.body) {
      throw new Error('Gemini response body is empty.');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let lastInputTokens = 0;
    let lastOutputTokens = 0;
    let emittedOutput = false;
    let emptyReason = '';
    const isRecord = (value: unknown): value is Record<string, unknown> => this.isRecord(value);
    type ParseCtx = {
      lastInputTokens: number;
      lastOutputTokens: number;
      emittedOutput: boolean;
      emptyReason: string;
    };

    const parsePayload = (payload: unknown, ctx: ParseCtx): StreamEvent[] => {
      const out: StreamEvent[] = [];

      if (Array.isArray(payload)) {
        for (const item of payload) {
          out.push(...parsePayload(item, ctx));
        }
        return out;
      }

      if (!isRecord(payload)) {
        return out;
      }

      const usageMetadata = isRecord(payload.usageMetadata)
        ? payload.usageMetadata
        : undefined;
      if (usageMetadata) {
        if (typeof usageMetadata.promptTokenCount === 'number') {
          ctx.lastInputTokens = usageMetadata.promptTokenCount;
        }
        if (typeof usageMetadata.candidatesTokenCount === 'number') {
          ctx.lastOutputTokens = usageMetadata.candidatesTokenCount;
        }
      }

      const promptFeedback = isRecord(payload.promptFeedback)
        ? payload.promptFeedback
        : undefined;
      if (!ctx.emptyReason && promptFeedback && typeof promptFeedback.blockReason === 'string') {
        ctx.emptyReason = `blocked: ${promptFeedback.blockReason}`;
      }

      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      for (const candidateRaw of candidates) {
        if (!isRecord(candidateRaw)) {
          continue;
        }

        const finishReason = candidateRaw.finishReason;
        if (!ctx.emptyReason && typeof finishReason === 'string' && finishReason !== 'STOP') {
          ctx.emptyReason = `finish reason: ${finishReason}`;
        }

        const content = isRecord(candidateRaw.content)
          ? candidateRaw.content
          : undefined;
        const parts = Array.isArray(content?.parts) ? content.parts : [];

        for (const partRaw of parts) {
          if (!isRecord(partRaw)) {
            continue;
          }

          if (typeof partRaw.text === 'string' && partRaw.text.length > 0) {
            out.push({ type: 'text', delta: partRaw.text });
            ctx.emittedOutput = true;
          }

          const functionCall = isRecord(partRaw.functionCall)
            ? partRaw.functionCall
            : undefined;
          const name = functionCall?.name;
          const args = isRecord(functionCall?.args) ? functionCall.args : {};
          if (typeof name === 'string' && name.length > 0) {
            out.push({
              type: 'tool_use',
              id: `gemini_fn_${Date.now()}`,
              name,
              input: args
            });
            ctx.emittedOutput = true;
          }
        }
      }

      return out;
    };

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');

        const dataLines = block
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim());

        const payloads = dataLines.length > 0
          ? this.parsePossibleJsonPayload(dataLines.join('\n'))
          : this.parsePossibleJsonPayload(block);

        for (const payload of payloads) {
          const ctx: ParseCtx = { lastInputTokens, lastOutputTokens, emittedOutput, emptyReason };
          const events = parsePayload(payload, ctx);
          for (const event of events) {
            yield event;
          }
          lastInputTokens = ctx.lastInputTokens;
          lastOutputTokens = ctx.lastOutputTokens;
          emittedOutput = ctx.emittedOutput;
          emptyReason = ctx.emptyReason;
        }
      }
    }

    // Some proxy implementations return a single JSON object instead of SSE blocks.
    const trailingPayloads = this.parsePossibleJsonPayload(buffer);
    for (const payload of trailingPayloads) {
      const ctx: ParseCtx = { lastInputTokens, lastOutputTokens, emittedOutput, emptyReason };
      const events = parsePayload(payload, ctx);
      for (const event of events) {
        yield event;
      }
      lastInputTokens = ctx.lastInputTokens;
      lastOutputTokens = ctx.lastOutputTokens;
      emittedOutput = ctx.emittedOutput;
      emptyReason = ctx.emptyReason;
    }

    if (!emittedOutput) {
      const detail = emptyReason ? ` (${emptyReason})` : '';
      yield {
        type: 'text',
        delta: `Gemini returned an empty response${detail}. Please try again or adjust the prompt/model settings.`
      };
    }

    if (lastInputTokens > 0 || lastOutputTokens > 0) {
      yield { type: 'token_usage', usage: { inputTokens: lastInputTokens, outputTokens: lastOutputTokens } };
    }

    yield { type: 'done' };
  }

  async *stream(
    messages: ChatMessage[],
    tools?: MCPToolDefinition[],
    maxTokens = 4096
  ): AsyncIterable<StreamEvent> {
    if (this.authMethod === 'api_key') {
      yield* this.streamViaApiKeySdk(messages, tools, maxTokens);
      return;
    }

    yield* this.streamViaOAuthFetch(messages, tools, maxTokens);
  }
}
