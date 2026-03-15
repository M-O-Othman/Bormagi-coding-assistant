import * as crypto from 'crypto';
import type { ResolvedInputSummary } from '../ExecutionStateManager';

/**
 * In-memory store for file content summaries keyed by path + content hash (DD7).
 *
 * After a successful read_file, the caller stores a summary and hash.
 * On subsequent turns, if the file hash is unchanged, the stored summary
 * is reused instead of re-reading and re-injecting the full file content.
 */
export class FileSummaryStore {
  private readonly store = new Map<string, ResolvedInputSummary>();

  /** Compute a SHA-256 hash of file content. */
  static hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /** Classify a file path into a kind for ResolvedInputSummary. */
  static classifyKind(filePath: string): ResolvedInputSummary['kind'] {
    const lower = filePath.toLowerCase();
    if (lower.includes('requirement') || lower.includes('spec')) return 'requirements';
    if (lower.includes('plan')) return 'plan';
    if (lower.includes('config') || lower.includes('package.json') || lower.includes('tsconfig')) return 'config';
    const ext = lower.split('.').pop() ?? '';
    if (['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs'].includes(ext)) return 'source';
    return 'other';
  }

  /** Store a file summary after a successful read. */
  put(filePath: string, content: string, summary: string): ResolvedInputSummary {
    const hash = FileSummaryStore.hashContent(content);
    const kind = FileSummaryStore.classifyKind(filePath);
    const entry: ResolvedInputSummary = {
      path: filePath,
      hash,
      summary: summary.slice(0, 500),
      kind,
      lastReadAt: new Date().toISOString(),
    };
    this.store.set(filePath, entry);
    return entry;
  }

  /**
   * Get a stored summary if the file content hash matches.
   * Returns null if no summary exists or the hash has changed.
   */
  get(filePath: string, currentHash: string): ResolvedInputSummary | null {
    const entry = this.store.get(filePath);
    if (!entry) return null;
    if (entry.hash !== currentHash) return null;
    return entry;
  }

  /** Get summary by path only (ignoring hash — for context injection). */
  getByPath(filePath: string): ResolvedInputSummary | null {
    return this.store.get(filePath) ?? null;
  }

  /** Check if a file has been summarised (regardless of hash). */
  has(filePath: string): boolean {
    return this.store.has(filePath);
  }

  /** Get all stored summaries. */
  getAll(): ResolvedInputSummary[] {
    return Array.from(this.store.values());
  }

  /** Clear all stored summaries (e.g. on recovery). */
  clear(): void {
    this.store.clear();
  }
}
