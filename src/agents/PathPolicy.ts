/**
 * PathPolicy — agent read/write path access control.
 *
 * Bug-fix-009 Fix 1.4:
 * Disallows agent discovery of internal framework paths (`.bormagi/`, `.git/`)
 * in normal coding mode. These paths are controller-internal and must never
 * be surfaced to the model as project source files.
 *
 * Usage:
 *   if (!canAgentReadPath(filePath, 'normal')) {
 *     return { status: 'blocked', reason: 'internal runtime path' };
 *   }
 */

/** Patterns identifying internal runtime / VCS paths. */
const INTERNAL_RUNTIME_PATTERNS: RegExp[] = [
  /^\.bormagi[/\\]/i,
  /^\.bormagi$/i,
  /^\.git[/\\]/i,
  /^\.git$/i,
];

/**
 * Operating mode for path access checks.
 * - 'normal'         — standard coding session (default)
 * - 'internal_debug' — explicit controller-debug mode (all paths allowed)
 */
export type PathAccessMode = 'normal' | 'internal_debug';

/**
 * Normalise a file path for policy checks.
 * Converts backslashes to forward slashes and strips leading ./
 */
function normalisePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Returns true if the path is an internal runtime/VCS path
 * that should be blocked from normal agent reads.
 */
export function isInternalRuntimePath(filePath: string): boolean {
  const normalised = normalisePath(filePath);
  return INTERNAL_RUNTIME_PATTERNS.some(rx => rx.test(normalised));
}

/**
 * Returns true if the agent is allowed to read the given path.
 *
 * In 'normal' mode, internal runtime paths (.bormagi/, .git/) are blocked.
 * In 'internal_debug' mode, all paths are allowed.
 */
export function canAgentReadPath(
  filePath: string,
  mode: PathAccessMode = 'normal',
): boolean {
  if (mode === 'internal_debug') { return true; }
  return !isInternalRuntimePath(filePath);
}

/**
 * Returns true if the agent is allowed to write the given path.
 *
 * Writing to internal paths is never allowed (even in internal_debug), because
 * the controller owns those files exclusively.
 */
export function canAgentWritePath(filePath: string): boolean {
  return !isInternalRuntimePath(filePath);
}

/**
 * Returns the blocking reason string, suitable for surfacing in a tool result.
 * Returns undefined when the path is allowed.
 */
export function getPathBlockReason(
  filePath: string,
  mode: PathAccessMode = 'normal',
): string | undefined {
  if (!canAgentReadPath(filePath, mode)) {
    return (
      `"${filePath}" is an internal controller path and cannot be read during ` +
      `normal coding sessions. Use execution state for diagnostic queries.`
    );
  }
  return undefined;
}
