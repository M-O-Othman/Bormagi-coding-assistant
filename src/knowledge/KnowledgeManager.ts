// ─── Knowledge manager ───────────────────────────────────────────────────────
//
// Top-level orchestrator for the knowledge pipeline.
// Manages: document ingestion, chunking, embedding, vector storage, and queries.

import * as fs from 'fs';
import * as path from 'path';
import { DocumentParser } from './DocumentParser';
import { Chunker } from './Chunker';
import { EmbeddingService } from './EmbeddingService';
import { VectorStore } from './VectorStore';
import { RetrievalService } from './RetrievalService';
import type { KnowledgeStats, EvidencePack, VectorItem, MetadataFilter } from './types';

/** Progress callback for UI reporting during long operations. */
export type ProgressCallback = (message: string, increment?: number) => void;

export class KnowledgeManager {
    private readonly parser: DocumentParser;
    private readonly chunker: Chunker;
    private readonly embeddings: EmbeddingService;
    /** Per-agent vector stores, lazily loaded. */
    private stores = new Map<string, VectorStore>();
    /** Per-agent retrieval services. */
    private retrievers = new Map<string, RetrievalService>();

    constructor(
        private readonly workspaceRoot: string,
        embeddings?: EmbeddingService
    ) {
        this.parser = new DocumentParser();
        this.chunker = new Chunker();
        this.embeddings = embeddings || new EmbeddingService();
    }

    // ─── Ingestion ─────────────────────────────────────────────────────────

    /**
     * Ingest all documents from the given source folders into the agent's
     * knowledge base. Clears existing knowledge and rebuilds from scratch.
     *
     * @param agentId       - The agent whose KB is being built
     * @param sourceFolders - Absolute or workspace-relative folder paths
     * @param onProgress    - Optional progress callback for UI
     */
    async ingestFolders(
        agentId: string,
        sourceFolders: string[],
        onProgress?: ProgressCallback
    ): Promise<KnowledgeStats> {
        const store = await this.getOrCreateStore(agentId);

        // Clear existing knowledge
        await store.clear();
        onProgress?.('Cleared existing knowledge base', 5);

        let totalDocs = 0;
        let totalChunks = 0;

        for (const folder of sourceFolders) {
            const resolvedFolder = path.isAbsolute(folder) ? folder : path.join(this.workspaceRoot, folder);

            if (!fs.existsSync(resolvedFolder)) {
                onProgress?.(`Skipping missing folder: ${folder}`);
                continue;
            }

            // 1. Parse documents
            onProgress?.(`Parsing documents from ${path.basename(resolvedFolder)}...`);
            const docs = await this.parser.parseFolder(resolvedFolder);
            totalDocs += docs.length;
            onProgress?.(`Parsed ${docs.length} documents`, 20);

            // 2. Chunk documents
            onProgress?.('Chunking documents...');
            const chunks = this.chunker.chunkAll(docs);
            totalChunks += chunks.length;
            onProgress?.(`Created ${chunks.length} chunks`, 10);

            // 3. Embed chunks in batches
            onProgress?.('Generating embeddings...');
            const texts = chunks.map(c => c.content);
            const vectors = await this.embeddings.embedBatch(texts);
            onProgress?.(`Generated ${vectors.length} embeddings`, 40);

            // 4. Build VectorItems and upsert
            const items: VectorItem[] = chunks.map((chunk, i) => ({
                id: chunk.chunkId,
                vector: vectors[i],
                metadata: {
                    docId: chunk.docId,
                    filename: chunk.filename,
                    sectionPath: chunk.sectionPath,
                    chunkPosition: chunk.position,
                    tokenCount: chunk.tokenCount,
                    format: docs.find(d => d.id === chunk.docId)?.format || 'text',
                },
                content: chunk.content,
            }));

            await store.upsert(items);
            onProgress?.('Stored vectors', 15);
        }

        // 5. Persist to disk
        await store.save();

        // 6. Save manifest
        const stats: KnowledgeStats = {
            documentCount: totalDocs,
            chunkCount: totalChunks,
            vectorCount: (await store.stats()).totalItems,
            lastRebuilt: new Date().toISOString(),
            sourceFolders,
        };

        this.saveAgentKBManifest(agentId, stats);
        onProgress?.('Knowledge base rebuilt successfully', 10);

        return stats;
    }

    /**
     * Rebuild the knowledge base for an agent using its configured source folders.
     */
    async rebuildKnowledgeBase(
        agentId: string,
        sourceFolders: string[],
        onProgress?: ProgressCallback
    ): Promise<KnowledgeStats> {
        return this.ingestFolders(agentId, sourceFolders, onProgress);
    }

    // ─── Retrieval ─────────────────────────────────────────────────────────

    /**
     * Query the agent's knowledge base and return an evidence pack.
     */
    async query(
        agentId: string,
        queryText: string,
        topK = 5,
        filter?: MetadataFilter
    ): Promise<EvidencePack> {
        const retriever = await this.getOrCreateRetriever(agentId);
        return retriever.retrieve(agentId, queryText, topK, filter);
    }

    /**
     * Check whether an agent has a built knowledge base.
     */
    async hasKnowledgeBase(agentId: string): Promise<boolean> {
        const store = await this.getOrCreateStore(agentId);
        return store.size > 0;
    }

    // ─── Stats ─────────────────────────────────────────────────────────────

    /**
     * Get knowledge base statistics for an agent.
     */
    async getStats(agentId: string): Promise<KnowledgeStats> {
        const manifestPath = this.agentKBManifestPath(agentId);
        if (fs.existsSync(manifestPath)) {
            try {
                return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            } catch { /* fall through */ }
        }

        // No manifest — return empty stats
        return {
            documentCount: 0,
            chunkCount: 0,
            vectorCount: 0,
            lastRebuilt: null,
            sourceFolders: [],
        };
    }

    // ─── Internal ──────────────────────────────────────────────────────────

    private knowledgeBasePath(agentId: string): string {
        return path.join(this.workspaceRoot, '.bormagi', 'knowledge', agentId, 'vectors');
    }

    private agentKBManifestPath(agentId: string): string {
        return path.join(this.workspaceRoot, '.bormagi', 'knowledge', agentId, 'manifest.json');
    }

    private saveAgentKBManifest(agentId: string, stats: KnowledgeStats): void {
        const dir = path.join(this.workspaceRoot, '.bormagi', 'knowledge', agentId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'manifest.json'),
            JSON.stringify(stats, null, 2),
            'utf-8'
        );
    }

    private async getOrCreateStore(agentId: string): Promise<VectorStore> {
        let store = this.stores.get(agentId);
        if (!store) {
            const storePath = this.knowledgeBasePath(agentId);
            store = new VectorStore(storePath, this.embeddings.dimensions, this.embeddings.providerName);
            await store.load();
            this.stores.set(agentId, store);
        }
        return store;
    }

    private async getOrCreateRetriever(agentId: string): Promise<RetrievalService> {
        let retriever = this.retrievers.get(agentId);
        if (!retriever) {
            const store = await this.getOrCreateStore(agentId);
            retriever = new RetrievalService(this.embeddings, store);
            this.retrievers.set(agentId, retriever);
        }
        return retriever;
    }
}
