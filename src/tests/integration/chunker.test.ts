// ─── Chunker tests ───────────────────────────────────────────────────────────

import { Chunker } from '../../knowledge/Chunker';
import type { ParsedDocument, DocumentSection } from '../../knowledge/types';

function makeDoc(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
    return {
        id: 'doc-1',
        filename: 'test.md',
        format: 'markdown',
        fullText: 'Test document text.',
        sections: [],
        metadata: {},
        ...overrides,
    };
}

function makeSection(heading: string, content: string, depth = 0): DocumentSection {
    return { heading, path: heading, content, depth };
}

describe('Chunker', () => {

    // ─── Basic chunking ───────────────────────────────────────────────────

    describe('constructor', () => {
        it('uses default options when none provided', () => {
            const chunker = new Chunker();
            expect(chunker).toBeDefined();
        });

        it('accepts custom options', () => {
            const chunker = new Chunker({ targetTokens: 200, minTokens: 20, overlapTokens: 30 });
            expect(chunker).toBeDefined();
        });
    });

    describe('chunk (plain text)', () => {
        it('produces at least one chunk for non-empty text', () => {
            const chunker = new Chunker();
            const doc = makeDoc({ fullText: 'Hello world. This is a test document.' });

            const chunks = chunker.chunk(doc);
            expect(chunks.length).toBeGreaterThanOrEqual(1);
            expect(chunks[0].content).toContain('Hello world');
        });

        it('assigns deterministic chunk IDs', () => {
            const chunker = new Chunker();
            const doc = makeDoc({ fullText: 'Some text content.' });

            const chunks1 = chunker.chunk(doc);
            const chunks2 = chunker.chunk(doc);
            expect(chunks1[0].chunkId).toBe(chunks2[0].chunkId);
        });

        it('splits long text into multiple chunks', () => {
            const chunker = new Chunker({ targetTokens: 20 });
            // Create text with multiple paragraphs
            const paragraphs = Array.from({ length: 10 }, (_, i) =>
                `This is paragraph ${i + 1} with some content that adds words to meet the token target.`
            );
            const doc = makeDoc({ fullText: paragraphs.join('\n\n') });

            const chunks = chunker.chunk(doc);
            expect(chunks.length).toBeGreaterThan(1);
        });
    });

    // ─── Section-based chunking ───────────────────────────────────────────

    describe('chunk (with sections)', () => {
        it('chunks by sections when document has sections', () => {
            const chunker = new Chunker();
            const doc = makeDoc({
                sections: [
                    makeSection('Introduction', 'This is the introduction section with some initial content.'),
                    makeSection('Details', 'Here are the details of the project and implementation.'),
                ],
            });

            const chunks = chunker.chunk(doc);
            expect(chunks.length).toBeGreaterThanOrEqual(2);
        });

        it('preserves section path in chunk metadata', () => {
            const chunker = new Chunker();
            const doc = makeDoc({
                sections: [
                    makeSection('Chapter 1', 'Content of chapter 1.'),
                ],
            });

            const chunks = chunker.chunk(doc);
            expect(chunks[0].sectionPath).toBe('Chapter 1');
        });

        it('includes token count estimate in each chunk', () => {
            const chunker = new Chunker();
            const doc = makeDoc({ fullText: 'A short sentence with several words for testing.' });

            const chunks = chunker.chunk(doc);
            expect(chunks[0].tokenCount).toBeGreaterThan(0);
        });
    });

    // ─── chunkAll ────────────────────────────────────────────────────────

    describe('chunkAll', () => {
        it('chunks multiple documents', () => {
            const chunker = new Chunker();
            const docs = [
                makeDoc({ id: 'doc-1', fullText: 'First document content.' }),
                makeDoc({ id: 'doc-2', fullText: 'Second document content.' }),
            ];

            const chunks = chunker.chunkAll(docs);
            expect(chunks.length).toBeGreaterThanOrEqual(2);
            const docIds = new Set(chunks.map(c => c.docId));
            expect(docIds.has('doc-1')).toBe(true);
            expect(docIds.has('doc-2')).toBe(true);
        });

        it('returns empty array for empty input', () => {
            const chunker = new Chunker();
            const chunks = chunker.chunkAll([]);
            expect(chunks).toEqual([]);
        });
    });

    // ─── Chunk properties ─────────────────────────────────────────────────

    describe('chunk properties', () => {
        it('each chunk has required fields', () => {
            const chunker = new Chunker();
            const doc = makeDoc({ fullText: 'This is the test document text.' });

            const chunks = chunker.chunk(doc);
            for (const chunk of chunks) {
                expect(chunk.chunkId).toBeDefined();
                expect(typeof chunk.chunkId).toBe('string');
                expect(chunk.docId).toBe('doc-1');
                expect(chunk.filename).toBe('test.md');
                expect(chunk.content).toBeTruthy();
                expect(typeof chunk.tokenCount).toBe('number');
                expect(typeof chunk.position).toBe('number');
            }
        });

        it('chunk IDs are unique within a document', () => {
            const chunker = new Chunker({ targetTokens: 10 });
            const text = Array.from({ length: 20 }, (_, i) => `Sentence ${i}.`).join('\n\n');
            const doc = makeDoc({ fullText: text });

            const chunks = chunker.chunk(doc);
            const ids = chunks.map(c => c.chunkId);
            expect(new Set(ids).size).toBe(ids.length);
        });
    });
});
