import type { ILLMProvider } from '../../providers/ILLMProvider';
import { ChatMessage, MCPToolDefinition, StreamEvent } from '../../types';

export class StreamTimeoutError extends Error {
    constructor(kind: 'first-chunk' | 'inter-chunk', timeoutMs: number) {
        super(`LLM stream timeout (${kind}): no data received within ${Math.round(timeoutMs / 1000)}s`);
        this.name = 'StreamTimeoutError';
    }
}

const TRANSIENT_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

export function isTransientStreamError(err: unknown): boolean {
    if (err instanceof StreamTimeoutError) return true;
    if (err && typeof err === 'object') {
        const code = (err as Record<string, unknown>).code;
        if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) return true;
        const msg = (err as Record<string, unknown>).message;
        if (typeof msg === 'string') {
            for (const code of TRANSIENT_ERROR_CODES) {
                if (msg.includes(code)) return true;
            }
        }
    }
    return false;
}

export const STREAM_FIRST_CHUNK_TIMEOUT_MS = 180_000; // 3 minutes for first chunk
export const STREAM_INTER_CHUNK_TIMEOUT_MS = 60_000;  // 60s between chunks
export const MAX_STREAM_RETRIES = 2;

export async function* streamWithTimeout(
    provider: ILLMProvider,
    messages: ChatMessage[],
    tools: MCPToolDefinition[],
    maxTokens: number,
    firstChunkTimeoutMs = STREAM_FIRST_CHUNK_TIMEOUT_MS,
    interChunkTimeoutMs = STREAM_INTER_CHUNK_TIMEOUT_MS,
): AsyncGenerator<StreamEvent> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rejectTimeout: ((err: StreamTimeoutError) => void) | null = null;
    let receivedFirstChunk = false;

    const resetTimer = (ms: number, kind: 'first-chunk' | 'inter-chunk') => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            rejectTimeout?.(new StreamTimeoutError(kind, ms));
        }, ms);
    };

    resetTimer(firstChunkTimeoutMs, 'first-chunk');

    try {
        const stream = provider.stream(messages, tools, maxTokens);
        const iterator = stream[Symbol.asyncIterator]();

        while (true) {
            const result = await Promise.race<IteratorResult<StreamEvent>>([
                iterator.next(),
                new Promise<never>((_resolve, reject) => { rejectTimeout = reject; }),
            ]);

            if (result.done) break;
            if (!receivedFirstChunk) receivedFirstChunk = true;
            resetTimer(interChunkTimeoutMs, 'inter-chunk');
            yield result.value;
        }
    } finally {
        if (timer) clearTimeout(timer);
        rejectTimeout = null;
    }
}