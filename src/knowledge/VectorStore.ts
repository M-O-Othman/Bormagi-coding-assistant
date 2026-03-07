// ─── Vector store ────────────────────────────────────────────────────────────
//
// File-based vector store for the knowledge base.
// Stores vectors + metadata as JSON files on disk.
// Performs cosine similarity search in-memory.
//
// Storage layout:
//   <basePath>/
//     index.json     — array of { id, vector, metadata, content }
//     manifest.json  — store metadata (dimensions, count, created, updated)

import * as fs from 'fs';
import * as path from 'path';
import type { VectorItem, SearchResult, MetadataFilter, ChunkMetadata } from './types';

/** Persisted manifest for the vector store. */
interface StoreManifest {
    dimensions: number;
    totalItems: number;
    createdAt: string;
    updatedAt: string;
    embeddingProvider: string;
}

/** Single entry in the index file. */
interface IndexEntry {
    id: string;
    vector: number[];
    metadata: ChunkMetadata;
    content: string;
}

export class VectorStore {
    private basePath: string;
    private items: Map<string, IndexEntry> = new Map();
    private manifest: StoreManifest;
    private dirty = false;

    constructor(basePath: string, dimensions = 384, embeddingProvider = 'local-hash') {
        this.basePath = basePath;
        this.manifest = {
            dimensions,
            totalItems: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            embeddingProvider,
        };
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────

    /** Load existing index from disk. */
    async load(): Promise<void> {
        const indexPath = path.join(this.basePath, 'index.json');
        const manifestPath = path.join(this.basePath, 'manifest.json');

        if (fs.existsSync(manifestPath)) {
            try {
                this.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            } catch { /* use defaults */ }
        }

        if (fs.existsSync(indexPath)) {
            try {
                const entries: IndexEntry[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
                for (const entry of entries) {
                    this.items.set(entry.id, entry);
                }
            } catch (err) {
                console.error('VectorStore: Failed to load index:', err);
            }
        }
    }

    /** Persist the current index to disk. */
    async save(): Promise<void> {
        // Ensure directory exists
        fs.mkdirSync(this.basePath, { recursive: true });

        const indexPath = path.join(this.basePath, 'index.json');
        const manifestPath = path.join(this.basePath, 'manifest.json');

        const entries = Array.from(this.items.values());
        this.manifest.totalItems = entries.length;
        this.manifest.updatedAt = new Date().toISOString();

        fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2), 'utf-8');
        fs.writeFileSync(manifestPath, JSON.stringify(this.manifest, null, 2), 'utf-8');
        this.dirty = false;
    }

    // ─── CRUD ──────────────────────────────────────────────────────────────

    /** Insert or update vector items. */
    async upsert(items: VectorItem[]): Promise<void> {
        for (const item of items) {
            this.items.set(item.id, {
                id: item.id,
                vector: item.vector,
                metadata: item.metadata,
                content: item.content,
            });
        }
        this.dirty = true;
    }

    /** Delete items by ID. */
    async delete(ids: string[]): Promise<void> {
        for (const id of ids) {
            this.items.delete(id);
        }
        this.dirty = true;
    }

    /** Clear all items from the store. */
    async clear(): Promise<void> {
        this.items.clear();
        this.dirty = true;
        // Also delete files on disk
        const indexPath = path.join(this.basePath, 'index.json');
        if (fs.existsSync(indexPath)) {
            fs.unlinkSync(indexPath);
        }
        await this.save();
    }

    /** Get statistics about the store. */
    async stats(): Promise<{ totalItems: number; dimensions: number; embeddingProvider: string }> {
        return {
            totalItems: this.items.size,
            dimensions: this.manifest.dimensions,
            embeddingProvider: this.manifest.embeddingProvider,
        };
    }

    // ─── Search ────────────────────────────────────────────────────────────

    /**
     * Search for the top-K most similar vectors.
     * Uses cosine similarity. Optionally filters by metadata.
     */
    async search(queryVector: number[], topK: number, filter?: MetadataFilter): Promise<SearchResult[]> {
        const scored: Array<{ entry: IndexEntry; score: number }> = [];

        for (const entry of this.items.values()) {
            // Apply metadata filter
            if (filter) {
                if (filter.filename && entry.metadata.filename !== filter.filename) { continue; }
                if (filter.format && entry.metadata.format !== filter.format) { continue; }
                if (filter.docId && entry.metadata.docId !== filter.docId) { continue; }
            }

            const score = this.cosineSimilarity(queryVector, entry.vector);
            scored.push({ entry, score });
        }

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        // Return top-K
        return scored.slice(0, topK).map(s => ({
            id: s.entry.id,
            score: s.score,
            content: s.entry.content,
            metadata: s.entry.metadata,
        }));
    }

    /** Check if the store has been modified since last save. */
    get isDirty(): boolean {
        return this.dirty;
    }

    /** Get total number of items. */
    get size(): number {
        return this.items.size;
    }

    // ─── Private ───────────────────────────────────────────────────────────

    /**
     * Cosine similarity between two vectors.
     * Returns a value between -1 and 1 (higher = more similar).
     */
    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) {
            // Dimension mismatch — return 0 to avoid crashes
            return 0;
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        if (denominator === 0) { return 0; }

        return dotProduct / denominator;
    }
}
