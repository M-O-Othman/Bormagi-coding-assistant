// ─── Retrieval service tests ─────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RetrievalService } from '../../knowledge/RetrievalService';
import { EmbeddingService } from '../../knowledge/EmbeddingService';
import { VectorStore } from '../../knowledge/VectorStore';
import type { VectorItem, ChunkMetadata, EvidencePack } from '../../knowledge/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMetadata(overrides: Partial<ChunkMetadata> = {}): ChunkMetadata {
    return {
        docId: 'doc-1',
        filename: 'test.md',
        sectionPath: 'Section 1',
        chunkPosition: 0,
        tokenCount: 50,
        format: 'markdown',
        ...overrides,
    };
}

function makeItem(id: string, vector: number[], content: string, meta?: Partial<ChunkMetadata>): VectorItem {
    return { id, vector, content, metadata: makeMetadata(meta) };
}

describe('RetrievalService', () => {
    let tmpDir: string;
    let vectorStore: VectorStore;
    let embeddings: EmbeddingService;
    let service: RetrievalService;

    const DIM = 4;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-test-retrieval-'));
        vectorStore = new VectorStore(tmpDir, DIM, 'test-hash');
        embeddings = new EmbeddingService();
        service = new RetrievalService(embeddings, vectorStore);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ─── retrieve ─────────────────────────────────────────────────────────

    describe('retrieve', () => {
        it('returns an EvidencePack with query and trace', async () => {
            // The embedding service uses a hash-based approach by default
            // so we need to pre-populate the store with items using vectors
            // that the service would generate. Instead, we test with known vectors.
            const embeddedQuery = await embeddings.embedText('test query');
            await vectorStore.upsert([
                makeItem('a', embeddedQuery, 'Relevant content about test query'),
            ]);

            const evidence = await service.retrieve('agent-1', 'test query', 5);

            expect(evidence).toBeDefined();
            expect(evidence.query).toBe('test query');
            expect(evidence.trace).toBeDefined();
            expect(evidence.trace.agentId).toBe('agent-1');
            expect(evidence.trace.topK).toBe(5);
            expect(evidence.trace.latencyMs).toBeGreaterThanOrEqual(0);
            expect(evidence.trace.timestamp).toBeTruthy();
        });

        it('returns matching chunks sorted by relevance', async () => {
            const queryVec = await embeddings.embedText('important topic');
            // Create items with the same vector (exact match) and a zero vector
            await vectorStore.upsert([
                makeItem('relevant', queryVec, 'Highly relevant content', { filename: 'relevant.md' }),
                makeItem('irrelevant', new Array(queryVec.length).fill(0), 'Unrelated content', { filename: 'unrelated.md' }),
            ]);

            const evidence = await service.retrieve('agent-1', 'important topic', 5);
            expect(evidence.chunks.length).toBeGreaterThanOrEqual(1);
            // First result should be the relevant one
            if (evidence.chunks.length > 1) {
                expect(evidence.chunks[0].score).toBeGreaterThanOrEqual(evidence.chunks[1].score);
            }
        });

        it('respects topK parameter', async () => {
            const vec = await embeddings.embedText('query');
            await vectorStore.upsert([
                makeItem('a', vec, 'Content A'),
                makeItem('b', vec, 'Content B'),
                makeItem('c', vec, 'Content C'),
            ]);

            const evidence = await service.retrieve('agent-1', 'query', 2);
            expect(evidence.chunks.length).toBeLessThanOrEqual(2);
            expect(evidence.trace.topK).toBe(2);
        });

        it('returns empty chunks when store is empty', async () => {
            const evidence = await service.retrieve('agent-1', 'query', 5);
            expect(evidence.chunks).toEqual([]);
            expect(evidence.trace.resultCount).toBe(0);
        });

        it('populates trace sources correctly', async () => {
            const vec = await embeddings.embedText('query');
            await vectorStore.upsert([
                makeItem('a', vec, 'From readme', { filename: 'readme.md' }),
                makeItem('b', vec, 'From design', { filename: 'design.md' }),
            ]);

            const evidence = await service.retrieve('agent-1', 'query', 10);
            expect(evidence.trace.sources).toContain('readme.md');
            expect(evidence.trace.sources).toContain('design.md');
        });
    });

    // ─── formatEvidenceForPrompt ──────────────────────────────────────────

    describe('formatEvidenceForPrompt', () => {
        it('returns empty string for empty evidence', () => {
            const evidence: EvidencePack = {
                query: 'test',
                chunks: [],
                trace: {
                    agentId: 'agent-1',
                    query: 'test',
                    topK: 5,
                    resultCount: 0,
                    sources: [],
                    latencyMs: 10,
                    timestamp: new Date().toISOString(),
                },
            };

            const formatted = RetrievalService.formatEvidenceForPrompt(evidence);
            expect(formatted).toBe('');
        });

        it('formats evidence with headers and source tags', () => {
            const evidence: EvidencePack = {
                query: 'How to deploy?',
                chunks: [
                    {
                        id: 'c1',
                        score: 0.95,
                        content: 'Run npm run deploy to deploy the application.',
                        metadata: makeMetadata({ filename: 'deploy.md', sectionPath: 'Deployment' }),
                    },
                ],
                trace: {
                    agentId: 'agent-1',
                    query: 'How to deploy?',
                    topK: 5,
                    resultCount: 1,
                    sources: ['deploy.md'],
                    latencyMs: 15,
                    timestamp: new Date().toISOString(),
                },
            };

            const formatted = RetrievalService.formatEvidenceForPrompt(evidence);
            expect(formatted).toContain('[Evidence from Knowledge Base]');
            expect(formatted).toContain('deploy.md');
            expect(formatted).toContain('npm run deploy');
            expect(formatted).toContain('[End of Evidence]');
            expect(formatted).toContain('95.0%');
        });
    });
});
