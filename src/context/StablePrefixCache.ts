// ─── Stable Prefix Cache ──────────────────────────────────────────────────────
//
// Tracks which prompt segments have been sent unchanged in prior turns so that:
//   - Anthropic providers can attach `cache_control` markers to those segments
//     (leveraging Anthropic's prompt-caching feature).
//   - Non-Anthropic providers can skip re-serialising unchanged tool schemas
//     by comparing content hashes.
//
// Design decisions (from spec §FR-8):
//   - Each segment is identified by a `componentType` + a SHA-256 content hash.
//   - Invalidation is eager: any change to a segment clears it from the cache.
//   - The cache is in-process only (no disk persistence); it resets at extension
//     restart.  This matches the lifetime of a single VS Code session.
//
// Spec reference: §FR-8 + Phase 5, §5.1.

import * as crypto from 'crypto';
import type { CachedPromptSegment } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

function buildCacheKey(componentType: CachedPromptSegment['componentType'], contentHash: string): string {
  return `${componentType}:${contentHash}`;
}

// ─── Invalidation reasons ─────────────────────────────────────────────────────

export type InvalidationReason =
  | 'rules-changed'
  | 'workspace-switched'
  | 'tool-schema-revised'
  | 'repo-map-updated'
  | 'memory-updated'
  | 'manual';

// ─── Class ────────────────────────────────────────────────────────────────────

/**
 * In-process cache for stable prompt segments.
 *
 * Lifecycle:
 *   1. Before assembling a prompt, call `getOrRegister()` for each stable block.
 *   2. The returned segment includes `cacheKey` — pass this to the provider
 *      adapter so it can attach `cache_control: { type: "ephemeral" }` (Anthropic)
 *      or skip re-serialisation (other providers).
 *   3. When a segment changes (e.g. the repo map is rebuilt), call `invalidate()`
 *      with the relevant `componentType` to clear stale entries.
 */
export class StablePrefixCache {
  /** Live segment registry keyed by cacheKey. */
  private readonly segments = new Map<string, CachedPromptSegment>();

  /**
   * Register a prompt segment and return the cached entry.
   *
   * If an entry with the same `componentType` and content hash already exists
   * the existing entry is returned (cache hit).  Otherwise a new entry is
   * created, stored, and returned (cache miss).
   *
   * @param componentType  The logical role of the segment in the prompt.
   * @param content        The raw text content of the segment.
   * @returns              The `CachedPromptSegment` for this content.
   */
  getOrRegister(
    componentType: CachedPromptSegment['componentType'],
    content: string,
  ): { segment: CachedPromptSegment; hit: boolean } {
    const contentHash = sha256(content);
    const cacheKey    = buildCacheKey(componentType, contentHash);

    const existing = this.segments.get(cacheKey);
    if (existing) {
      return { segment: existing, hit: true };
    }

    // Also remove any prior entry for the same componentType (content changed).
    this.evictByType(componentType);

    const segment: CachedPromptSegment = {
      cacheKey,
      content,
      contentHash,
      createdAtUtc: new Date().toISOString(),
      componentType,
    };
    this.segments.set(cacheKey, segment);
    return { segment, hit: false };
  }

  /**
   * Look up an existing cached segment by its cache key.
   * Returns `null` when no matching segment is stored.
   */
  getCachedSegment(cacheKey: string): CachedPromptSegment | null {
    return this.segments.get(cacheKey) ?? null;
  }

  /**
   * Explicitly store a segment (e.g. when restoring from a checkpoint).
   * If a segment with the same key already exists it is silently overwritten.
   */
  setCachedSegment(segment: CachedPromptSegment): void {
    this.evictByType(segment.componentType);
    this.segments.set(segment.cacheKey, segment);
  }

  /**
   * Invalidate all cached segments that match the given component types.
   * Pass no types to clear the entire cache.
   *
   * @param reason         Human-readable reason for the invalidation (telemetry).
   * @param componentTypes Component types to clear.  If omitted, all are cleared.
   * @returns              Number of entries removed.
   */
  invalidate(
    reason: InvalidationReason,
    ...componentTypes: Array<CachedPromptSegment['componentType']>
  ): number {
    if (componentTypes.length === 0) {
      const count = this.segments.size;
      this.segments.clear();
      return count;
    }

    let removed = 0;
    for (const [key, seg] of this.segments) {
      if (componentTypes.includes(seg.componentType)) {
        this.segments.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Returns the current number of cached segments.
   */
  size(): number {
    return this.segments.size;
  }

  /**
   * Returns all cached segments, sorted by creation time (oldest first).
   * Useful for inspection and telemetry.
   */
  allSegments(): CachedPromptSegment[] {
    return Array.from(this.segments.values())
      .sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
  }

  /**
   * Returns the cache key that would be assigned to this content without
   * storing anything.  Useful for pre-flight checks.
   */
  static previewKey(
    componentType: CachedPromptSegment['componentType'],
    content: string,
  ): string {
    return buildCacheKey(componentType, sha256(content));
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Remove any existing entry for the given componentType (there should be at
   * most one per type since content changed).
   */
  private evictByType(componentType: CachedPromptSegment['componentType']): void {
    for (const [key, seg] of this.segments) {
      if (seg.componentType === componentType) {
        this.segments.delete(key);
        break;
      }
    }
  }
}
