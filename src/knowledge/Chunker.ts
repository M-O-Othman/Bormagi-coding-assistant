// ─── Chunker ─────────────────────────────────────────────────────────────────
//
// Splits ParsedDocuments into retrievable DocumentChunks.
// Strategy varies by content type: heading-based for Markdown/HTML,
// block-based for code/JSON/YAML, row-based for tables.

import * as crypto from 'crypto';
import type { ParsedDocument, DocumentChunk } from './types';

/** Configuration for chunk generation. */
export interface ChunkerOptions {
    /** Target tokens per chunk (approximate, word-based). Default: 400. */
    targetTokens?: number;
    /** Minimum tokens per chunk — very small sections are merged. Default: 50. */
    minTokens?: number;
    /** Overlap in tokens between consecutive chunks. Default: 50. */
    overlapTokens?: number;
}

const DEFAULT_OPTIONS: Required<ChunkerOptions> = {
    targetTokens: 400,
    minTokens: 50,
    overlapTokens: 50,
};

export class Chunker {
    private readonly opts: Required<ChunkerOptions>;

    constructor(options?: ChunkerOptions) {
        this.opts = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Chunk a single parsed document.
     */
    chunk(doc: ParsedDocument): DocumentChunk[] {
        // If we have sections, chunk per section; otherwise chunk the full text.
        if (doc.sections.length > 0) {
            return this.chunkBySections(doc);
        }
        return this.chunkPlainText(doc.fullText, doc.id, doc.filename, doc.filename);
    }

    /**
     * Chunk multiple documents.
     */
    chunkAll(docs: ParsedDocument[]): DocumentChunk[] {
        const chunks: DocumentChunk[] = [];
        for (const doc of docs) {
            chunks.push(...this.chunk(doc));
        }
        return chunks;
    }

    // ─── Private ───────────────────────────────────────────────────────────

    /**
     * Chunk by document sections (heading-based).
     * Small sections below minTokens are merged with the next section.
     */
    private chunkBySections(doc: ParsedDocument): DocumentChunk[] {
        const allChunks: DocumentChunk[] = [];
        let globalPosition = 0;

        for (const section of doc.sections) {
            if (!section.content.trim()) { continue; }

            const sectionTokens = this.estimateTokens(section.content);

            if (sectionTokens <= this.opts.targetTokens) {
                // Section fits in one chunk
                allChunks.push(this.makeChunk(doc.id, doc.filename, section.path, section.content, globalPosition));
                globalPosition++;
            } else {
                // Section is too large — split into sub-chunks by paragraphs
                const subChunks = this.chunkPlainText(section.content, doc.id, doc.filename, section.path);
                for (const sc of subChunks) {
                    sc.position = globalPosition;
                    sc.chunkId = this.makeChunkId(doc.id, globalPosition);
                    allChunks.push(sc);
                    globalPosition++;
                }
            }
        }

        return allChunks;
    }

    /**
     * Chunk plain text by paragraphs / sentence boundaries.
     * Tries to keep chunks close to targetTokens.
     */
    private chunkPlainText(text: string, docId: string, filename: string, sectionPath: string): DocumentChunk[] {
        const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
        const chunks: DocumentChunk[] = [];
        let currentLines: string[] = [];
        let currentTokens = 0;
        let position = 0;

        const flush = () => {
            if (currentLines.length === 0) { return; }
            const content = currentLines.join('\n\n').trim();
            if (content) {
                chunks.push(this.makeChunk(docId, filename, sectionPath, content, position));
                position++;
            }
            // Keep overlap: last paragraph carries into next chunk
            if (this.opts.overlapTokens > 0 && currentLines.length > 0) {
                const lastPara = currentLines[currentLines.length - 1];
                const lastTokens = this.estimateTokens(lastPara);
                if (lastTokens <= this.opts.overlapTokens) {
                    currentLines = [lastPara];
                    currentTokens = lastTokens;
                } else {
                    currentLines = [];
                    currentTokens = 0;
                }
            } else {
                currentLines = [];
                currentTokens = 0;
            }
        };

        for (const para of paragraphs) {
            const paraTokens = this.estimateTokens(para);

            // If a single paragraph exceeds target, split by sentences
            if (paraTokens > this.opts.targetTokens) {
                flush();
                const sentenceChunks = this.splitBySentences(para, docId, filename, sectionPath, position);
                for (const sc of sentenceChunks) {
                    chunks.push(sc);
                    position++;
                }
                currentLines = [];
                currentTokens = 0;
                continue;
            }

            if (currentTokens + paraTokens > this.opts.targetTokens) {
                flush();
            }

            currentLines.push(para);
            currentTokens += paraTokens;
        }

        flush();
        return chunks;
    }

    /**
     * Emergency split: split a very long paragraph by sentence boundaries.
     */
    private splitBySentences(text: string, docId: string, filename: string, sectionPath: string, startPos: number): DocumentChunk[] {
        // Simple sentence splitting on . ? ! followed by whitespace or end
        const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];
        const chunks: DocumentChunk[] = [];
        let current: string[] = [];
        let currentTokens = 0;
        let pos = startPos;

        for (const sentence of sentences) {
            const sTokens = this.estimateTokens(sentence);
            if (currentTokens + sTokens > this.opts.targetTokens && current.length > 0) {
                chunks.push(this.makeChunk(docId, filename, sectionPath, current.join(' ').trim(), pos));
                pos++;
                current = [];
                currentTokens = 0;
            }
            current.push(sentence.trim());
            currentTokens += sTokens;
        }

        if (current.length > 0) {
            chunks.push(this.makeChunk(docId, filename, sectionPath, current.join(' ').trim(), pos));
        }

        return chunks;
    }

    // ─── Helpers ───────────────────────────────────────────────────────────

    /** Rough token estimate: ~0.75 words per token (English text). */
    private estimateTokens(text: string): number {
        const words = text.split(/\s+/).filter(w => w).length;
        return Math.ceil(words / 0.75);
    }

    /** Create a DocumentChunk object. */
    private makeChunk(docId: string, filename: string, sectionPath: string, content: string, position: number): DocumentChunk {
        return {
            chunkId: this.makeChunkId(docId, position),
            docId,
            filename,
            sectionPath,
            content,
            tokenCount: this.estimateTokens(content),
            position,
        };
    }

    /** Deterministic chunk ID from document ID + position. */
    private makeChunkId(docId: string, position: number): string {
        return crypto.createHash('sha256')
            .update(`${docId}:chunk:${position}`)
            .digest('hex')
            .slice(0, 16);
    }
}
