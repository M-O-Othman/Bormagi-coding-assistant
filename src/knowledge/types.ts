// ─── Knowledge module types ──────────────────────────────────────────────────

/** Supported document formats for ingestion. */
export type DocumentFormat =
    | 'markdown'
    | 'html'
    | 'pdf'
    | 'docx'
    | 'xlsx'
    | 'csv'
    | 'text'
    | 'json'
    | 'yaml'
    | 'image';

/** A section extracted from a parsed document. */
export interface DocumentSection {
    /** Heading or identifier for this section. */
    heading: string;
    /** Full heading hierarchy path, e.g. "Chapter 1 > Section 1.2". */
    path: string;
    /** The text content of this section. */
    content: string;
    /** 0-based depth in the heading hierarchy. */
    depth: number;
}

/** Result of parsing a single document. */
export interface ParsedDocument {
    /** Unique identifier (deterministic from filename + last modified). */
    id: string;
    /** Original filename (basename). */
    filename: string;
    /** Detected format. */
    format: DocumentFormat;
    /** Full extracted text (all sections concatenated). */
    fullText: string;
    /** Structured sections if the format supports headings. */
    sections: DocumentSection[];
    /** Arbitrary metadata from the source file. */
    metadata: Record<string, unknown>;
}

/** A chunk produced by the Chunker from a ParsedDocument. */
export interface DocumentChunk {
    /** Unique chunk identifier (deterministic from docId + position). */
    chunkId: string;
    /** Parent document identifier. */
    docId: string;
    /** Original filename. */
    filename: string;
    /** Section path / heading hierarchy. */
    sectionPath: string;
    /** The text content of this chunk. */
    content: string;
    /** Approximate token count (word-based estimate). */
    tokenCount: number;
    /** 0-based position of this chunk within the document. */
    position: number;
}

/** A vector item ready for storage. */
export interface VectorItem {
    /** Same as chunkId. */
    id: string;
    /** The vector embedding. */
    vector: number[];
    /** Metadata stored alongside the vector. */
    metadata: ChunkMetadata;
    /** Original text content for retrieval display. */
    content: string;
}

/** Metadata attached to each vector. */
export interface ChunkMetadata {
    docId: string;
    filename: string;
    sectionPath: string;
    chunkPosition: number;
    tokenCount: number;
    format: DocumentFormat;
}

/** A single search result from the vector store. */
export interface SearchResult {
    /** Chunk / vector ID. */
    id: string;
    /** Cosine similarity score (0–1). */
    score: number;
    /** The original text content. */
    content: string;
    /** Associated metadata. */
    metadata: ChunkMetadata;
}

/** Filter criteria for vector search. */
export interface MetadataFilter {
    filename?: string;
    format?: DocumentFormat;
    docId?: string;
}

/** Agent-level knowledge configuration (stored in agent config.json). */
export interface KnowledgeConfig {
    /** Absolute or workspace-relative paths to folders containing source documents. */
    source_folders: string[];
    /** Whether to automatically consult knowledge base before answering. */
    auto_consult: boolean;
    /** Number of top results to retrieve. */
    retrieval_top_k: number;
    /** ISO timestamp of last rebuild, or null if never built. */
    last_rebuilt: string | null;
}

/** Stats about an agent's knowledge base. */
export interface KnowledgeStats {
    documentCount: number;
    chunkCount: number;
    vectorCount: number;
    lastRebuilt: string | null;
    sourceFolders: string[];
}

/** A retrieved evidence pack for prompt injection. */
export interface EvidencePack {
    /** The original user query. */
    query: string;
    /** Retrieved chunks, sorted by relevance. */
    chunks: SearchResult[];
    /** Retrieval performance data. */
    trace: RetrievalTrace;
}

/** Retrieval trace for logging / debugging. */
export interface RetrievalTrace {
    agentId: string;
    query: string;
    topK: number;
    resultCount: number;
    sources: string[];
    latencyMs: number;
    timestamp: string;
}
