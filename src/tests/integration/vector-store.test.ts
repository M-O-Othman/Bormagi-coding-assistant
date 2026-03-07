// ─── Vector store tests ──────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VectorStore } from '../../knowledge/VectorStore';
import type { VectorItem, ChunkMetadata } from '../../knowledge/types';

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

function makeVectorItem(id: string, vector: number[], content = 'Test content', meta?: Partial<ChunkMetadata>): VectorItem {
    return { id, vector, content, metadata: makeMetadata(meta) };
}

describe('VectorStore', () => {
    let tmpDir: string;
    let store: VectorStore;
    const DIM = 4; // Use small dimensions for test speed

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-test-vs-'));
        store = new VectorStore(tmpDir, DIM, 'test');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ─── CRUD ─────────────────────────────────────────────────────────────

    describe('upsert', () => {
        it('inserts new items', async () => {
            await store.upsert([makeVectorItem('a', [1, 0, 0, 0])]);
            expect(store.size).toBe(1);
        });

        it('updates existing items by ID', async () => {
            await store.upsert([makeVectorItem('a', [1, 0, 0, 0], 'original')]);
            await store.upsert([makeVectorItem('a', [0, 1, 0, 0], 'updated')]);
            expect(store.size).toBe(1);

            const results = await store.search([0, 1, 0, 0], 1);
            expect(results[0].content).toBe('updated');
        });

        it('inserts multiple items at once', async () => {
            await store.upsert([
                makeVectorItem('a', [1, 0, 0, 0]),
                makeVectorItem('b', [0, 1, 0, 0]),
                makeVectorItem('c', [0, 0, 1, 0]),
            ]);
            expect(store.size).toBe(3);
        });
    });

    describe('delete', () => {
        it('removes items by ID', async () => {
            await store.upsert([
                makeVectorItem('a', [1, 0, 0, 0]),
                makeVectorItem('b', [0, 1, 0, 0]),
            ]);
            await store.delete(['a']);
            expect(store.size).toBe(1);

            const results = await store.search([1, 0, 0, 0], 10);
            expect(results.every(r => r.id !== 'a')).toBe(true);
        });

        it('handles deletion of non-existent IDs gracefully', async () => {
            await store.upsert([makeVectorItem('a', [1, 0, 0, 0])]);
            await store.delete(['nonexistent']);
            expect(store.size).toBe(1);
        });
    });

    describe('clear', () => {
        it('removes all items', async () => {
            await store.upsert([
                makeVectorItem('a', [1, 0, 0, 0]),
                makeVectorItem('b', [0, 1, 0, 0]),
            ]);
            await store.clear();
            expect(store.size).toBe(0);
        });
    });

    describe('stats', () => {
        it('returns correct statistics', async () => {
            await store.upsert([
                makeVectorItem('a', [1, 0, 0, 0]),
                makeVectorItem('b', [0, 1, 0, 0]),
            ]);

            const stats = await store.stats();
            expect(stats.totalItems).toBe(2);
            expect(stats.dimensions).toBe(DIM);
            expect(stats.embeddingProvider).toBe('test');
        });
    });

    // ─── Search ───────────────────────────────────────────────────────────

    describe('search', () => {
        it('returns most similar vectors first', async () => {
            await store.upsert([
                makeVectorItem('a', [1, 0, 0, 0], 'First'),
                makeVectorItem('b', [0, 1, 0, 0], 'Second'),
                makeVectorItem('c', [0.9, 0.1, 0, 0], 'Close to first'),
            ]);

            const results = await store.search([1, 0, 0, 0], 3);
            expect(results.length).toBe(3);
            // 'a' should be most similar to the query
            expect(results[0].id).toBe('a');
            // Scores should be in descending order
            for (let i = 1; i < results.length; i++) {
                expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
            }
        });

        it('respects topK limit', async () => {
            await store.upsert([
                makeVectorItem('a', [1, 0, 0, 0]),
                makeVectorItem('b', [0, 1, 0, 0]),
                makeVectorItem('c', [0, 0, 1, 0]),
            ]);

            const results = await store.search([1, 0, 0, 0], 1);
            expect(results.length).toBe(1);
        });

        it('returns scores between -1 and 1', async () => {
            await store.upsert([
                makeVectorItem('a', [1, 0, 0, 0]),
                makeVectorItem('b', [0, 1, 0, 0]),
            ]);

            const results = await store.search([1, 0, 0, 0], 10);
            for (const r of results) {
                expect(r.score).toBeGreaterThanOrEqual(-1);
                expect(r.score).toBeLessThanOrEqual(1);
            }
        });

        it('returns empty for empty store', async () => {
            const results = await store.search([1, 0, 0, 0], 5);
            expect(results).toEqual([]);
        });

        it('applies metadata filter (filename)', async () => {
            await store.upsert([
                makeVectorItem('a', [1, 0, 0, 0], 'From readme', { filename: 'readme.md' }),
                makeVectorItem('b', [0.9, 0.1, 0, 0], 'From notes', { filename: 'notes.txt' }),
            ]);

            const results = await store.search([1, 0, 0, 0], 10, { filename: 'readme.md' });
            expect(results.length).toBe(1);
            expect(results[0].id).toBe('a');
        });
    });

    // ─── Persistence ──────────────────────────────────────────────────────

    describe('save and load', () => {
        it('persists and reloads items', async () => {
            await store.upsert([
                makeVectorItem('a', [1, 0, 0, 0], 'Content A'),
                makeVectorItem('b', [0, 1, 0, 0], 'Content B'),
            ]);
            await store.save();

            // Create a new store instance pointing to the same path
            const store2 = new VectorStore(tmpDir, DIM, 'test');
            await store2.load();

            expect(store2.size).toBe(2);
            const results = await store2.search([1, 0, 0, 0], 1);
            expect(results[0].content).toBe('Content A');
        });

        it('creates necessary files on save', async () => {
            await store.upsert([makeVectorItem('a', [1, 0, 0, 0])]);
            await store.save();

            expect(fs.existsSync(path.join(tmpDir, 'index.json'))).toBe(true);
            expect(fs.existsSync(path.join(tmpDir, 'manifest.json'))).toBe(true);
        });

        it('tracks dirty state', async () => {
            expect(store.isDirty).toBe(false);
            await store.upsert([makeVectorItem('a', [1, 0, 0, 0])]);
            expect(store.isDirty).toBe(true);
            await store.save();
            expect(store.isDirty).toBe(false);
        });
    });

    // ─── Cosine similarity edge cases ─────────────────────────────────────

    describe('cosine similarity correctness', () => {
        it('exact match returns score 1', async () => {
            await store.upsert([makeVectorItem('a', [1, 0, 0, 0])]);
            const results = await store.search([1, 0, 0, 0], 1);
            expect(results[0].score).toBeCloseTo(1.0, 5);
        });

        it('orthogonal vectors return score 0', async () => {
            await store.upsert([makeVectorItem('a', [1, 0, 0, 0])]);
            const results = await store.search([0, 1, 0, 0], 1);
            expect(results[0].score).toBeCloseTo(0.0, 5);
        });

        it('handles dimension mismatch gracefully', async () => {
            await store.upsert([makeVectorItem('a', [1, 0, 0, 0])]);
            // Search with wrong dimensions should not crash
            const results = await store.search([1, 0], 1);
            expect(results[0].score).toBe(0);
        });
    });
});
