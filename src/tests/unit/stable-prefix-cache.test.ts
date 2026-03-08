// ─── Unit tests: StablePrefixCache ────────────────────────────────────────────
//
// Covers: registration, cache hits, hash-based invalidation, eviction,
// multi-segment coexistence, and the static previewKey helper.

import { StablePrefixCache } from '../../context/StablePrefixCache';
import type { CachedPromptSegment } from '../../context/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCache(): StablePrefixCache {
  return new StablePrefixCache();
}

// ─── getOrRegister ────────────────────────────────────────────────────────────

describe('StablePrefixCache.getOrRegister', () => {
  test('returns a segment with correct componentType and content', () => {
    const cache   = makeCache();
    const content = 'You are a helpful coding assistant.';
    const { segment } = cache.getOrRegister('system', content);

    expect(segment.componentType).toBe('system');
    expect(segment.content).toBe(content);
    expect(segment.cacheKey).toBeTruthy();
    expect(segment.contentHash).toBeTruthy();
    expect(segment.createdAtUtc).toBeTruthy();
  });

  test('returns hit=false on first registration', () => {
    const cache = makeCache();
    const { hit } = cache.getOrRegister('rules', 'some rules text');
    expect(hit).toBe(false);
  });

  test('returns hit=true when same content is registered again', () => {
    const cache   = makeCache();
    const content = 'same content';
    cache.getOrRegister('memory', content);
    const { hit } = cache.getOrRegister('memory', content);
    expect(hit).toBe(true);
  });

  test('same key is returned on second registration', () => {
    const cache   = makeCache();
    const content = 'identical content';
    const { segment: s1 } = cache.getOrRegister('repo-map', content);
    const { segment: s2 } = cache.getOrRegister('repo-map', content);
    expect(s1.cacheKey).toBe(s2.cacheKey);
  });

  test('different content produces different cache keys', () => {
    const cache = makeCache();
    const { segment: s1 } = cache.getOrRegister('tools', 'content A');
    const { segment: s2 } = cache.getOrRegister('system', 'content B');
    expect(s1.cacheKey).not.toBe(s2.cacheKey);
  });

  test('changing content for same componentType evicts previous entry', () => {
    const cache    = makeCache();
    const { segment: s1 } = cache.getOrRegister('system', 'version 1');
    const { segment: s2, hit } = cache.getOrRegister('system', 'version 2');

    expect(hit).toBe(false);
    expect(s1.cacheKey).not.toBe(s2.cacheKey);
    // Old key should no longer be in cache.
    expect(cache.getCachedSegment(s1.cacheKey)).toBeNull();
    expect(cache.size()).toBe(1);
  });

  test('multiple componentTypes coexist independently', () => {
    const cache = makeCache();
    cache.getOrRegister('system',   'system text');
    cache.getOrRegister('rules',    'rules text');
    cache.getOrRegister('memory',   'memory text');
    cache.getOrRegister('repo-map', 'repo-map text');
    cache.getOrRegister('tools',    'tools text');
    expect(cache.size()).toBe(5);
  });
});

// ─── getCachedSegment ─────────────────────────────────────────────────────────

describe('StablePrefixCache.getCachedSegment', () => {
  test('returns null for unknown key', () => {
    const cache = makeCache();
    expect(cache.getCachedSegment('nonexistent:key')).toBeNull();
  });

  test('returns stored segment by key', () => {
    const cache = makeCache();
    const { segment } = cache.getOrRegister('tools', 'tool schema text');
    const fetched = cache.getCachedSegment(segment.cacheKey);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe('tool schema text');
  });
});

// ─── setCachedSegment ─────────────────────────────────────────────────────────

describe('StablePrefixCache.setCachedSegment', () => {
  test('can store and retrieve a manually constructed segment', () => {
    const cache = makeCache();
    const segment: CachedPromptSegment = {
      cacheKey:      'rules:abc123',
      content:       'manual rules',
      contentHash:   'abc123',
      createdAtUtc:  new Date().toISOString(),
      componentType: 'rules',
    };
    cache.setCachedSegment(segment);
    expect(cache.getCachedSegment('rules:abc123')).toEqual(segment);
  });

  test('setCachedSegment replaces any existing entry of same componentType', () => {
    const cache = makeCache();
    cache.getOrRegister('memory', 'original memory');

    const replacement: CachedPromptSegment = {
      cacheKey:      'memory:xyz',
      content:       'replaced memory',
      contentHash:   'xyz',
      createdAtUtc:  new Date().toISOString(),
      componentType: 'memory',
    };
    cache.setCachedSegment(replacement);
    expect(cache.size()).toBe(1);
    expect(cache.getCachedSegment('memory:xyz')).toEqual(replacement);
  });
});

// ─── invalidate ───────────────────────────────────────────────────────────────

describe('StablePrefixCache.invalidate', () => {
  test('invalidate with no types clears everything', () => {
    const cache = makeCache();
    cache.getOrRegister('system',   'sys');
    cache.getOrRegister('rules',    'rules');
    cache.getOrRegister('repo-map', 'map');
    expect(cache.size()).toBe(3);

    const removed = cache.invalidate('manual');
    expect(removed).toBe(3);
    expect(cache.size()).toBe(0);
  });

  test('invalidate with specific type removes only matching entries', () => {
    const cache = makeCache();
    cache.getOrRegister('system',   'sys');
    cache.getOrRegister('rules',    'rules');
    cache.getOrRegister('repo-map', 'map');

    const removed = cache.invalidate('repo-map-updated', 'repo-map');
    expect(removed).toBe(1);
    expect(cache.size()).toBe(2);
  });

  test('invalidate with multiple types removes all matching', () => {
    const cache = makeCache();
    cache.getOrRegister('system', 'sys');
    cache.getOrRegister('rules',  'rules');
    cache.getOrRegister('tools',  'tools');

    const removed = cache.invalidate('tool-schema-revised', 'rules', 'tools');
    expect(removed).toBe(2);
    expect(cache.size()).toBe(1);
  });

  test('invalidate returns 0 when nothing matches', () => {
    const cache = makeCache();
    cache.getOrRegister('system', 'sys');
    const removed = cache.invalidate('workspace-switched', 'tools');
    expect(removed).toBe(0);
    expect(cache.size()).toBe(1);
  });
});

// ─── allSegments ──────────────────────────────────────────────────────────────

describe('StablePrefixCache.allSegments', () => {
  test('returns all registered segments', () => {
    const cache = makeCache();
    cache.getOrRegister('system', 'a');
    cache.getOrRegister('rules',  'b');
    const segments = cache.allSegments();
    expect(segments).toHaveLength(2);
    const types = segments.map(s => s.componentType);
    expect(types).toContain('system');
    expect(types).toContain('rules');
  });

  test('returns empty array when cache is empty', () => {
    const cache = makeCache();
    expect(cache.allSegments()).toEqual([]);
  });
});

// ─── previewKey ───────────────────────────────────────────────────────────────

describe('StablePrefixCache.previewKey', () => {
  test('is deterministic for the same input', () => {
    const k1 = StablePrefixCache.previewKey('system', 'hello world');
    const k2 = StablePrefixCache.previewKey('system', 'hello world');
    expect(k1).toBe(k2);
  });

  test('differs for different content', () => {
    const k1 = StablePrefixCache.previewKey('system', 'content A');
    const k2 = StablePrefixCache.previewKey('system', 'content B');
    expect(k1).not.toBe(k2);
  });

  test('differs for different componentType', () => {
    const k1 = StablePrefixCache.previewKey('system', 'same content');
    const k2 = StablePrefixCache.previewKey('rules',  'same content');
    expect(k1).not.toBe(k2);
  });

  test('matches the key produced by getOrRegister for same content', () => {
    const cache   = makeCache();
    const content = 'preview key match test';
    const { segment } = cache.getOrRegister('memory', content);
    const preview     = StablePrefixCache.previewKey('memory', content);
    expect(segment.cacheKey).toBe(preview);
  });
});
