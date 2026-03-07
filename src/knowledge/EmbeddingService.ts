// ─── Embedding service ───────────────────────────────────────────────────────
//
// Provides a unified interface for generating text embeddings.
// Supports two modes:
//   1. Local embeddings using a simple TF-IDF-like approach (zero dependencies)
//   2. Provider-based embeddings using the user's existing LLM API key
//
// The local approach uses a word-frequency vector with hashing trick,
// which gives reasonable results for similarity search without any
// external model or large dependency.

import * as crypto from 'crypto';

/** Interface for pluggable embedding providers. */
export interface IEmbeddingProvider {
    /** Generate embeddings for one or more text strings. */
    embed(texts: string[]): Promise<number[][]>;
    /** Dimensionality of the output vectors. */
    readonly dimensions: number;
    /** Human-readable name of the provider. */
    readonly name: string;
}

// ─── Local embedding provider (hash-based, zero deps) ────────────────────────

/**
 * A lightweight local embedding provider that uses a hashing-trick approach
 * to create fixed-size word-frequency vectors. No external model required.
 *
 * This is simpler than ONNX-based models but works well for small to medium
 * knowledge bases where document similarity is based on shared terminology.
 *
 * For better semantic quality, users can switch to a provider-based embedder.
 */
export class LocalEmbeddingProvider implements IEmbeddingProvider {
    readonly name = 'local-hash';
    readonly dimensions: number;

    constructor(dimensions = 384) {
        this.dimensions = dimensions;
    }

    async embed(texts: string[]): Promise<number[][]> {
        return texts.map(text => this.embedSingle(text));
    }

    private embedSingle(text: string): number[] {
        const vec = new Float64Array(this.dimensions);
        const words = this.tokenize(text);
        const totalWords = words.length || 1;

        // Build word frequency vector using hashing trick
        for (const word of words) {
            const hash = this.hashWord(word);
            const idx = Math.abs(hash) % this.dimensions;
            // Use a second hash to determine sign (+ or -)
            const sign = this.hashWord(word + '_sign') % 2 === 0 ? 1 : -1;
            vec[idx] += sign / totalWords;
        }

        // Add bigram features for better context capture
        for (let i = 0; i < words.length - 1; i++) {
            const bigram = words[i] + '_' + words[i + 1];
            const hash = this.hashWord(bigram);
            const idx = Math.abs(hash) % this.dimensions;
            const sign = this.hashWord(bigram + '_sign') % 2 === 0 ? 1 : -1;
            vec[idx] += sign * 0.5 / totalWords;
        }

        // L2 normalize
        return Array.from(this.normalize(vec));
    }

    private tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 1 && !STOP_WORDS.has(w));
    }

    private hashWord(word: string): number {
        const hash = crypto.createHash('md5').update(word).digest();
        // Use first 4 bytes as a 32-bit integer
        return hash.readInt32LE(0);
    }

    private normalize(vec: Float64Array): Float64Array {
        let norm = 0;
        for (let i = 0; i < vec.length; i++) {
            norm += vec[i] * vec[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < vec.length; i++) {
                vec[i] /= norm;
            }
        }
        return vec;
    }
}

// ─── Provider-based embedding (uses existing LLM API) ────────────────────────

export type ProviderEmbeddingType = 'openai' | 'gemini';

export interface ProviderEmbeddingOptions {
    type: ProviderEmbeddingType;
    apiKey: string;
    model?: string;
    baseUrl?: string;
}

/**
 * An embedding provider that calls an external API.
 * Uses the user's existing API key — no new account needed.
 */
export class ProviderEmbeddingProvider implements IEmbeddingProvider {
    readonly name: string;
    readonly dimensions: number;
    private readonly apiKey: string;
    private readonly model: string;
    private readonly baseUrl: string;
    private readonly type: ProviderEmbeddingType;

    constructor(opts: ProviderEmbeddingOptions) {
        this.type = opts.type;
        this.apiKey = opts.apiKey;

        switch (opts.type) {
            case 'openai':
                this.name = 'openai-embedding';
                this.model = opts.model || 'text-embedding-3-small';
                this.baseUrl = opts.baseUrl || 'https://api.openai.com/v1';
                this.dimensions = 1536;
                break;
            case 'gemini':
                this.name = 'gemini-embedding';
                this.model = opts.model || 'text-embedding-004';
                this.baseUrl = opts.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
                this.dimensions = 768;
                break;
            default:
                throw new Error(`Unsupported embedding provider: ${opts.type}`);
        }
    }

    async embed(texts: string[]): Promise<number[][]> {
        switch (this.type) {
            case 'openai':
                return this.embedOpenAI(texts);
            case 'gemini':
                return this.embedGemini(texts);
            default:
                throw new Error(`Unsupported provider type: ${this.type}`);
        }
    }

    private async embedOpenAI(texts: string[]): Promise<number[][]> {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                input: texts,
                model: this.model,
            }),
        });

        if (!response.ok) {
            throw new Error(`OpenAI embedding API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as { data: Array<{ embedding: number[] }> };
        return data.data.map(d => d.embedding);
    }

    private async embedGemini(texts: string[]): Promise<number[][]> {
        // Gemini uses a different API structure — one call per text
        const results: number[][] = [];
        for (const text of texts) {
            const response = await fetch(
                `${this.baseUrl}/models/${this.model}:embedContent?key=${this.apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: { parts: [{ text }] },
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(`Gemini embedding API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as { embedding: { values: number[] } };
            results.push(data.embedding.values);
        }
        return results;
    }
}

// ─── Embedding service facade ────────────────────────────────────────────────

export class EmbeddingService {
    private provider: IEmbeddingProvider;

    constructor(provider?: IEmbeddingProvider) {
        this.provider = provider || new LocalEmbeddingProvider();
    }

    /** Switch the active embedding provider. */
    setProvider(provider: IEmbeddingProvider): void {
        this.provider = provider;
    }

    /** Get the active provider name. */
    get providerName(): string {
        return this.provider.name;
    }

    /** Get vector dimensions. */
    get dimensions(): number {
        return this.provider.dimensions;
    }

    /** Embed a single text string. */
    async embedText(text: string): Promise<number[]> {
        const results = await this.provider.embed([text]);
        return results[0];
    }

    /** Embed multiple text strings in batch. */
    async embedBatch(texts: string[], batchSize = 32): Promise<number[][]> {
        const allResults: number[][] = [];

        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            const results = await this.provider.embed(batch);
            allResults.push(...results);
        }

        return allResults;
    }
}

// ─── Stop words (English) ────────────────────────────────────────────────────

const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'it', 'its',
    'this', 'that', 'these', 'those', 'he', 'she', 'they', 'we', 'you',
    'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their',
    'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
    'if', 'then', 'else', 'also', 'about', 'up', 'out', 'into', 'over',
    'after', 'before', 'between', 'under', 'above', 'as', 'while',
]);
