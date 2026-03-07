// ─── Retrieval service ───────────────────────────────────────────────────────
//
// Orchestrates retrieval from the vector store for a user query.
// Flow: embed query → vector search (top-K) → assemble evidence pack.

import { EmbeddingService } from './EmbeddingService';
import { VectorStore } from './VectorStore';
import type { SearchResult, MetadataFilter, EvidencePack, RetrievalTrace } from './types';

export class RetrievalService {
    constructor(
        private readonly embeddings: EmbeddingService,
        private readonly vectorStore: VectorStore
    ) { }

    /**
     * Retrieve the most relevant chunks for a query.
     *
     * @param agentId  - Agent performing the query (for trace logging)
     * @param query    - The user's question or search text
     * @param topK     - Number of results to return
     * @param filter   - Optional metadata filter
     * @returns An EvidencePack with chunks and retrieval trace
     */
    async retrieve(
        agentId: string,
        query: string,
        topK = 5,
        filter?: MetadataFilter
    ): Promise<EvidencePack> {
        const start = Date.now();

        // 1. Embed the query
        const queryVector = await this.embeddings.embedText(query);

        // 2. Search the vector store
        const results = await this.vectorStore.search(queryVector, topK, filter);

        // 3. Build retrieval trace
        const latencyMs = Date.now() - start;
        const sources = [...new Set(results.map(r => r.metadata.filename))];

        const trace: RetrievalTrace = {
            agentId,
            query,
            topK,
            resultCount: results.length,
            sources,
            latencyMs,
            timestamp: new Date().toISOString(),
        };

        return { query, chunks: results, trace };
    }

    /**
     * Format retrieved chunks as a text block for prompt injection.
     * Each chunk includes its source filename and relevance score.
     */
    static formatEvidenceForPrompt(evidence: EvidencePack): string {
        if (evidence.chunks.length === 0) {
            return '';
        }

        const lines: string[] = [
            '[Evidence from Knowledge Base]',
            `Query: "${evidence.query}"`,
            `Sources consulted: ${evidence.trace.sources.join(', ')}`,
            '',
        ];

        for (let i = 0; i < evidence.chunks.length; i++) {
            const chunk = evidence.chunks[i];
            const score = (chunk.score * 100).toFixed(1);
            lines.push(`--- Source ${i + 1}: ${chunk.metadata.filename} (${chunk.metadata.sectionPath}) [relevance: ${score}%] ---`);
            lines.push(chunk.content.trim());
            lines.push('');
        }

        lines.push('[End of Evidence]');
        return lines.join('\n');
    }
}
