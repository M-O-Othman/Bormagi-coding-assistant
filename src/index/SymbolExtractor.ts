// ─── Symbol Extractor ─────────────────────────────────────────────────────────
//
// Extracts symbol information from a document using VS Code's built-in
// DocumentSymbolProvider (language-server integration).
//
// Supported languages: TypeScript, JavaScript, Java, Python.
// Other file types receive an empty symbol list without error.
//
// Spec reference: §FR-2 (OQ-5: JS/TS/Java/Python).

import * as vscode from 'vscode';
import type { SymbolEntry } from '../context/types';

// ─── VS Code symbol kind → spec kind mapping ──────────────────────────────────

const VSCODE_KIND_MAP: Partial<Record<vscode.SymbolKind, SymbolEntry['kind']>> = {
  [vscode.SymbolKind.Class]:     'class',
  [vscode.SymbolKind.Function]:  'function',
  [vscode.SymbolKind.Method]:    'method',
  [vscode.SymbolKind.Constructor]: 'method',
  [vscode.SymbolKind.Interface]: 'interface',
  [vscode.SymbolKind.TypeParameter]: 'type',
  // TS-specific: vscode uses Constant for `const` declarations
  [vscode.SymbolKind.Constant]:  'const',
  [vscode.SymbolKind.Variable]:  'const',
  [vscode.SymbolKind.Enum]:      'enum',
  [vscode.SymbolKind.EnumMember]: 'enum',
  [vscode.SymbolKind.Struct]:    'class',
  [vscode.SymbolKind.Object]:    'const',
  [vscode.SymbolKind.Property]:  'const',
  [vscode.SymbolKind.Field]:     'const',
};

// ─── Recursive flatten ────────────────────────────────────────────────────────

/**
 * VS Code returns a tree of `DocumentSymbol` objects (children for nested
 * classes/methods).  This flattens the tree into a single list, which is
 * what the repo map entry expects.
 */
function flattenSymbols(
  symbols: vscode.DocumentSymbol[],
  lines: string[],
  maxSymbols: number,
  collected: SymbolEntry[],
): void {
  for (const sym of symbols) {
    if (collected.length >= maxSymbols) { break; }

    const kind = VSCODE_KIND_MAP[sym.kind];
    if (!kind) {
      // Recurse into children even if parent kind is unmapped
      if (sym.children.length > 0) {
        flattenSymbols(sym.children, lines, maxSymbols, collected);
      }
      continue;
    }

    // Extract signature: the first non-empty line in the symbol's range.
    const lineStart = sym.range.start.line;
    const lineEnd   = sym.range.end.line;
    const signatureLine = (lines[lineStart] ?? '').trim();
    // Truncate long signatures (e.g., a function with a huge parameter list).
    const signature = signatureLine.length > 160
      ? `${signatureLine.slice(0, 157)}...`
      : signatureLine || undefined;

    collected.push({
      name:      sym.name,
      kind,
      signature,
      lineStart,
      lineEnd,
    });

    // Recurse into children (methods inside a class, etc.)
    if (sym.children.length > 0) {
      flattenSymbols(sym.children, lines, maxSymbols, collected);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract symbols from an already-open VS Code `TextDocument`.
 *
 * @param document    The document to extract symbols from.
 * @param maxSymbols  Maximum number of symbols to return (default 200).
 * @returns           Array of `SymbolEntry` objects (may be empty if the
 *                    language server provides no symbols or is unavailable).
 */
export async function extractSymbols(
  document: vscode.TextDocument,
  maxSymbols = 200,
): Promise<SymbolEntry[]> {
  let rawSymbols: vscode.DocumentSymbol[];

  try {
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    );
    rawSymbols = result ?? [];
  } catch {
    // Language server not available or document type unsupported — return empty.
    return [];
  }

  if (rawSymbols.length === 0) { return []; }

  const lines = document.getText().split('\n');
  const collected: SymbolEntry[] = [];
  flattenSymbols(rawSymbols, lines, maxSymbols, collected);
  return collected;
}

/**
 * Extract symbols by opening the file at `uri` (or reusing an already-open
 * editor).  Caller is responsible for providing a URI within the current
 * workspace so that a language server is available.
 *
 * This overload is used by `RepoMapBuilder` which iterates workspace files
 * without necessarily having a visible editor open for each one.
 *
 * @param uri         VS Code URI for the file to index.
 * @param maxSymbols  Maximum number of symbols to return.
 */
export async function extractSymbolsFromUri(
  uri: vscode.Uri,
  maxSymbols = 200,
): Promise<SymbolEntry[]> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    return [];
  }
  return extractSymbols(document, maxSymbols);
}

// ─── Import / export extraction (regex fallback) ──────────────────────────────

/**
 * Extract ES-module import / require paths from TypeScript or JavaScript source.
 * Returns an array of module specifiers (relative or package names).
 */
export function extractImports(content: string): string[] {
  const patterns = [
    // ES module: import ... from 'path'
    /\bimport\s+(?:(?:\*\s+as\s+\w+|[\w{},\s*]+)\s+from\s+)?['"]([^'"]+)['"]/g,
    // CommonJS: require('path')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  const imports = new Set<string>();
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const specifier = match[1];
      if (specifier) { imports.add(specifier); }
    }
  }
  return Array.from(imports);
}

/**
 * Extract top-level named exports from TypeScript / JavaScript source using a
 * simple regex approach (not full AST parsing).
 *
 * Captures: `export function`, `export class`, `export const/let/var`,
 * `export interface`, `export type`, `export enum`.
 */
export function extractExports(content: string): string[] {
  const re = /^export\s+(?:default\s+)?(?:function\s+|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+)(\w+)/gm;
  const exports: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match[1]) { exports.push(match[1]); }
  }
  return exports;
}
