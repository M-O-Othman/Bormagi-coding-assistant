// ─── Capability Registry ──────────────────────────────────────────────────────
//
// Lazily loads specialised capability instruction sets from the workspace's
// `.bormagi/capabilities/` directory.  Only capabilities that are applicable
// to the current assistant mode and fit within the remaining token budget are
// activated.
//
// Directory layout expected on disk:
//
//   .bormagi/capabilities/
//     <id>/
//       manifest.json   ← CapabilityManifest (without `instructions` field)
//       instructions.md ← Full instruction text (loaded on demand)
//
// Activation flow:
//   1. Call `loadManifests(capabilitiesDir)` once at session start to read all
//      manifest.json files (cheap — no instruction text loaded).
//   2. On each request, call `maybeLoadCapability(manifests, query, budget)`.
//      The registry selects the best-matching manifest that fits the budget,
//      reads its instructions.md, records the activation in the session, and
//      returns a `LoadedCapability`.
//   3. Activated capabilities are tracked per-session so repeated activations
//      of the same capability within one session are returned from an
//      in-process cache.
//
// Spec reference: §FR-15B (capability loading) + Phase 5, §5.4.

import * as fs   from 'fs';
import * as path from 'path';
import type {
  AssistantMode,
  CapabilityManifest,
  LoadedCapability,
} from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const CAPABILITIES_DIR_RELATIVE = path.join('.bormagi', 'capabilities');
const MANIFEST_FILENAME         = 'manifest.json';
const INSTRUCTIONS_FILENAME     = 'instructions.md';

// ─── Manifest loading ─────────────────────────────────────────────────────────

/**
 * Read all capability manifests from a capabilities directory.
 *
 * Each sub-directory that contains a valid `manifest.json` is loaded.
 * Malformed manifests are skipped silently.
 *
 * @param capabilitiesDir  Absolute path to the `.bormagi/capabilities/` folder,
 *                         or a custom override path.
 * @returns                Array of all valid `CapabilityManifest` objects found.
 */
export function loadManifests(capabilitiesDir: string): CapabilityManifest[] {
  if (!fs.existsSync(capabilitiesDir)) { return []; }

  const entries = fs.readdirSync(capabilitiesDir, { withFileTypes: true });
  const manifests: CapabilityManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) { continue; }

    const manifestPath = path.join(capabilitiesDir, entry.name, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) { continue; }

    try {
      const raw      = fs.readFileSync(manifestPath, 'utf-8');
      const parsed   = JSON.parse(raw) as Partial<CapabilityManifest>;

      // Validate required fields.
      if (
        typeof parsed.id              !== 'string' ||
        typeof parsed.name            !== 'string' ||
        typeof parsed.description     !== 'string' ||
        !Array.isArray(parsed.applicableModes) ||
        typeof parsed.estimatedTokens !== 'number'
      ) {
        continue;
      }

      manifests.push({
        id:               parsed.id,
        name:             parsed.name,
        description:      parsed.description,
        applicableModes:  parsed.applicableModes as AssistantMode[],
        requiredTools:    Array.isArray(parsed.requiredTools) ? parsed.requiredTools : [],
        estimatedTokens:  parsed.estimatedTokens,
        manifestPath,
      });
    } catch {
      // Skip unparseable manifests.
    }
  }

  return manifests;
}

// ─── Candidate selection ──────────────────────────────────────────────────────

/**
 * Score a capability manifest against the current query and mode.
 * Higher score = better match.
 */
function scoreManifest(manifest: CapabilityManifest, query: string, mode: AssistantMode): number {
  // Must apply to the current mode.
  if (!manifest.applicableModes.includes(mode)) { return -1; }

  const lowerQuery = query.toLowerCase();
  const lowerDesc  = manifest.description.toLowerCase();
  const lowerName  = manifest.name.toLowerCase();

  let score = 0;

  // Name keyword overlap.
  const nameWords = lowerName.split(/\W+/).filter(w => w.length > 2);
  for (const word of nameWords) {
    if (lowerQuery.includes(word)) { score += 2; }
  }

  // Description keyword overlap.
  const descWords = lowerDesc.split(/\W+/).filter(w => w.length > 3);
  for (const word of descWords) {
    if (lowerQuery.includes(word)) { score += 1; }
  }

  return score;
}

// ─── In-process activation cache ──────────────────────────────────────────────

/**
 * Registry of per-session activated capabilities.
 * Keyed by `${sessionId}:${capabilityId}`.
 */
const activationCache = new Map<string, LoadedCapability>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempt to select and load a capability that is applicable to the current
 * request.
 *
 * Selection criteria (in order):
 *   1. The capability's `applicableModes` must include the current mode.
 *   2. The capability's `estimatedTokens` must not exceed `availableBudget`.
 *   3. Among eligible candidates, the one with the highest query relevance
 *      score is chosen.
 *
 * If the winning capability has already been activated in this session it is
 * returned from the in-process cache without re-reading the file.
 *
 * @param manifests      Pre-loaded capability manifests (from `loadManifests`).
 * @param query          The current user request text (used for relevance scoring).
 * @param mode           The current assistant mode.
 * @param availableBudget  Token budget remaining for capability instructions.
 * @param sessionId      Optional session identifier for caching (defaults to `'default'`).
 * @returns              The best-match `LoadedCapability`, or `null` when none
 *                       is applicable or fits the budget.
 */
export async function maybeLoadCapability(
  manifests: CapabilityManifest[],
  query: string,
  mode: AssistantMode,
  availableBudget: number,
  sessionId = 'default',
): Promise<LoadedCapability | null> {
  // Score and filter.
  const candidates = manifests
    .map(m => ({ manifest: m, score: scoreManifest(m, query, mode) }))
    .filter(c => c.score >= 0 && c.manifest.estimatedTokens <= availableBudget)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) { return null; }

  const best = candidates[0].manifest;

  // Return cached activation if available.
  const cacheKey = `${sessionId}:${best.id}`;
  const cached   = activationCache.get(cacheKey);
  if (cached) { return cached; }

  // Load the instructions file.
  const capDir          = path.dirname(best.manifestPath);
  const instructionsPath = path.join(capDir, INSTRUCTIONS_FILENAME);

  let instructions = '';
  try {
    instructions = fs.readFileSync(instructionsPath, 'utf-8');
  } catch {
    // Instructions file missing — return null rather than a broken capability.
    return null;
  }

  const loaded: LoadedCapability = {
    ...best,
    instructions,
  };

  activationCache.set(cacheKey, loaded);
  return loaded;
}

/**
 * Evict all cached activations for a given session.
 * Call at session end or when the workspace changes.
 *
 * @param sessionId  Session identifier to clear.  If omitted, all sessions
 *                   are cleared.
 */
export function clearActivations(sessionId?: string): void {
  if (!sessionId) {
    activationCache.clear();
    return;
  }
  const prefix = `${sessionId}:`;
  for (const key of activationCache.keys()) {
    if (key.startsWith(prefix)) {
      activationCache.delete(key);
    }
  }
}

/**
 * Return all currently cached activated capabilities.
 * Useful for telemetry and session snapshots.
 */
export function getActivatedCapabilities(sessionId = 'default'): LoadedCapability[] {
  const prefix = `${sessionId}:`;
  return Array.from(activationCache.values())
    .filter((_, i) => Array.from(activationCache.keys())[i].startsWith(prefix));
}

/**
 * Resolve the default capabilities directory for a workspace.
 */
export function defaultCapabilitiesDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, CAPABILITIES_DIR_RELATIVE);
}
