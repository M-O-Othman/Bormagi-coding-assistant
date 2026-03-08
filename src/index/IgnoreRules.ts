// ─── Ignore Rules ─────────────────────────────────────────────────────────────
//
// Determines which workspace files should be excluded from the repo map index.
//
// Precedence (highest → lowest):
//   1. Explicit user includes (always allowed through)
//   2. Project allowlist (.bormagi/config/allowlist.json)
//   3. Project ignore file (.bormagi/config/.bormagiignore)
//   4. Built-in defaults (node_modules, binaries, generated files, etc.)
//
// Spec reference: §FR-3.

import * as fs from 'fs';
import * as path from 'path';

// ─── Default excludes ─────────────────────────────────────────────────────────

/**
 * Built-in path patterns that are excluded from the repo map index by default.
 * Each entry is matched against the file's forward-slash–normalised relative path.
 */
export const DEFAULT_EXCLUDES: ReadonlyArray<RegExp> = [
  // Dependency trees
  /\bnode_modules\b/,
  /\bvendor\b/,
  /\b\.pnp\b/,

  // Build & dist output
  /\bdist\b/,
  /\bout\b/,
  /\bbuild\b/,
  /\b\.next\b/,
  /\b\.nuxt\b/,
  /\b\.svelte-kit\b/,

  // Package lock files (large, not useful for retrieval)
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /composer\.lock$/,
  /Gemfile\.lock$/,

  // IDE / OS metadata
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.idea(\/|$)/,
  /(^|\/)\.vscode(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /Thumbs\.db$/,

  // Compiled / binary artefacts
  /\.class$/,
  /\.pyc$/,
  /\.pyo$/,
  /\.o$/,
  /\.a$/,
  /\.so$/,
  /\.dll$/,
  /\.exe$/,
  /\.bin$/,
  /\.wasm$/,

  // Media / large assets
  /\.(png|jpe?g|gif|ico|svg|webp|bmp|tiff|mp4|mov|avi|mp3|wav|ogg|pdf|zip|tar|gz|rar|7z)$/i,

  // Font files
  /\.(ttf|otf|woff2?)$/i,

  // Minified / generated JS/CSS
  /\.min\.(js|css)$/,
  /\.(js\.map|css\.map)$/,

  // Test snapshots and coverage
  /\b__snapshots__\b/,
  /\bcoverage\b/,
  /\.lcov$/,

  // Bormagi workspace data (not user code)
  /(^|\/)\.bormagi(\/|$)/,
];

// ─── Allowlist / ignore file helpers ──────────────────────────────────────────

/**
 * Load a newline-separated plain-text allowlist or ignore file.
 * Lines starting with `#` are treated as comments and skipped.
 * Returns an array of non-empty, trimmed pattern strings.
 */
function loadTextPatterns(filePath: string): string[] {
  if (!fs.existsSync(filePath)) { return []; }
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

function matchesGlob(normalizedPath: string, pattern: string): boolean {
  // Simple glob: support leading **, * within a segment, and literal paths.
  // Convert glob to regex.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials except * and ?
    .replace(/\*\*/g, '\x00')               // placeholder for **
    .replace(/\*/g, '[^/]*')                // * = any non-separator chars
    .replace(/\?/g, '[^/]')                 // ? = single non-separator char
    .replace(/\x00/g, '.*');                // ** = anything including /

  const regex = new RegExp(`(^|/)${escaped}($|/)`);
  return regex.test(normalizedPath);
}

// ─── Core predicate ───────────────────────────────────────────────────────────

/**
 * Return `true` when the file at `relativePath` should be **excluded** from
 * the repo map index.
 *
 * @param relativePath    Forward-slash or OS-native relative path from workspace root.
 * @param userIncludes    Paths explicitly provided by the user (override everything).
 * @param projectAllowlistFile  Path to `.bormagi/config/allowlist.json` (optional).
 * @param projectIgnoreFile     Path to `.bormagi/config/.bormagiignore` (optional).
 */
export function shouldExclude(
  relativePath: string,
  userIncludes: ReadonlyArray<string> = [],
  projectAllowlistFile?: string,
  projectIgnoreFile?: string,
): boolean {
  const normalized = toForwardSlash(relativePath);

  // 1. Explicit user includes always pass through.
  for (const include of userIncludes) {
    if (normalized === toForwardSlash(include)) {
      return false;
    }
  }

  // 2. Project allowlist: if explicitly listed, permit the file.
  if (projectAllowlistFile) {
    const allowlist = loadTextPatterns(projectAllowlistFile);
    for (const pattern of allowlist) {
      if (matchesGlob(normalized, pattern)) {
        return false;
      }
    }
  }

  // 3. Project ignore file: if matched, exclude.
  if (projectIgnoreFile) {
    const ignorePatterns = loadTextPatterns(projectIgnoreFile);
    for (const pattern of ignorePatterns) {
      if (matchesGlob(normalized, pattern)) {
        return true;
      }
    }
  }

  // 4. Built-in defaults.
  for (const re of DEFAULT_EXCLUDES) {
    if (re.test(normalized)) {
      return true;
    }
  }

  return false;
}

// ─── Language detection ───────────────────────────────────────────────────────

const LANGUAGE_MAP: ReadonlyArray<[RegExp, string]> = [
  [/\.tsx?$/, 'typescript'],
  [/\.jsx?$/, 'javascript'],
  [/\.py$/, 'python'],
  [/\.java$/, 'java'],
  [/\.go$/, 'go'],
  [/\.rs$/, 'rust'],
  [/\.cs$/, 'csharp'],
  [/\.cpp$|\.cc$|\.cxx$|\.h$|\.hpp$/, 'cpp'],
  [/\.c$/, 'c'],
  [/\.rb$/, 'ruby'],
  [/\.php$/, 'php'],
  [/\.swift$/, 'swift'],
  [/\.kt$|\.kts$/, 'kotlin'],
  [/\.json$/, 'json'],
  [/\.yaml$|\.yml$/, 'yaml'],
  [/\.md$/, 'markdown'],
  [/\.html?$/, 'html'],
  [/\.css$|\.scss$|\.sass$|\.less$/, 'css'],
  [/\.sh$|\.bash$/, 'shellscript'],
  [/\.sql$/, 'sql'],
];

/** Detect language from file extension. Falls back to `"plaintext"`. */
export function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  for (const [re, lang] of LANGUAGE_MAP) {
    if (re.test(lower)) { return lang; }
  }
  return 'plaintext';
}

/** True when a file's language is supported by `SymbolExtractor`. */
export function isSymbolIndexable(language: string): boolean {
  return ['typescript', 'javascript', 'python', 'java'].includes(language);
}
