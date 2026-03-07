import type { ChatMessage, MCPToolDefinition } from '../../types';
import type { ScannedFile } from '../../utils/FileScanner';

export interface RelevantFileSnippet {
  relativePath: string;
  score: number;
  matchedTerms: string[];
  snippet: string;
}

export interface RequestSizeBreakdown {
  systemChars: number;
  historyChars: number;
  repoSummaryChars: number;
  retrievalChars: number;
  userChars: number;
  toolSchemaChars: number;
  totalChars: number;
  totalBytes: number;
  estimatedInputTokens: number;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'is', 'are', 'be',
  'with', 'by', 'from', 'that', 'this', 'it', 'as', 'if', 'into', 'about', 'can', 'could',
  'should', 'would', 'please', 'help', 'need', 'want', 'use', 'using', 'make', 'build',
  'update', 'fix', 'add', 'remove', 'code', 'file', 'files', 'project', 'repo', 'application'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 16) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 15)}\n...[truncated]`;
}

function firstNonEmptyLine(content: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r/g, '').replace(/\t/g, '  ').trim();
}

function sanitizeForSnippet(text: string): string {
  const compact = normalizeWhitespace(text);
  return compact.split('\n').slice(0, 60).join('\n');
}

function snippetAround(content: string, anchorIndex: number, maxChars: number): string {
  if (!content.trim()) {
    return '';
  }
  const safeAnchor = Math.max(0, Math.min(anchorIndex, content.length - 1));
  const half = Math.max(80, Math.floor(maxChars / 2));
  const start = Math.max(0, safeAnchor - half);
  const end = Math.min(content.length, start + maxChars);
  const raw = content.slice(start, end);
  return truncate(sanitizeForSnippet(raw), maxChars);
}

function shortenDescription(description: string): string {
  const clean = description.replace(/\s+/g, ' ').trim();
  if (!clean) {
    return '';
  }
  const firstSentence = clean.split(/[.!?]/)[0]?.trim() ?? clean;
  return firstSentence.length > 120
    ? `${firstSentence.slice(0, 117)}...`
    : firstSentence;
}

function minifyJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(minifyJsonSchema);
  }
  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  const allowedKeys = new Set([
    'type',
    'properties',
    'required',
    'items',
    'enum',
    'oneOf',
    'anyOf',
    'allOf',
    'additionalProperties',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'pattern',
    'format'
  ]);

  for (const [key, raw] of Object.entries(value)) {
    if (!allowedKeys.has(key)) {
      continue;
    }

    if (key === 'properties' && isRecord(raw)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propValue] of Object.entries(raw)) {
        props[propName] = minifyJsonSchema(propValue);
      }
      out.properties = props;
      continue;
    }

    out[key] = minifyJsonSchema(raw);
  }

  return out;
}

export function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(Math.max(0, charCount) / 4);
}

export function extractQueryTerms(query: string, maxTerms = 20): string[] {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9_\-./\s]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => t.length >= 3)
    .filter(t => !STOP_WORDS.has(t));

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (seen.has(term)) {
      continue;
    }
    seen.add(term);
    unique.push(term);
    if (unique.length >= maxTerms) {
      break;
    }
  }
  return unique;
}

export function minifyToolDefinitions(tools: MCPToolDefinition[]): MCPToolDefinition[] {
  return tools.map(tool => {
    const minifiedSchema = minifyJsonSchema(tool.inputSchema);
    const safeSchema = isRecord(minifiedSchema) && Object.keys(minifiedSchema).length > 0
      ? minifiedSchema
      : { type: 'object' };

    const description = shortenDescription(tool.description ?? '');
    return {
      name: tool.name,
      description,
      inputSchema: safeSchema
    };
  });
}

export function buildRepoSummary(files: ScannedFile[], maxChars = 2400): string {
  if (files.length === 0) {
    return '';
  }

  const extCounts = new Map<string, number>();
  const dirCounts = new Map<string, number>();

  for (const file of files) {
    const extMatch = file.relativePath.match(/(\.[^./\\]+)$/);
    const ext = (extMatch?.[1] ?? '(no-ext)').toLowerCase();
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);

    const normalized = file.relativePath.replace(/\\/g, '/');
    const topDir = normalized.includes('/') ? normalized.split('/')[0] : '(root)';
    dirCounts.set(topDir, (dirCounts.get(topDir) ?? 0) + 1);
  }

  const topExt = [...extCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => `${ext}:${count}`)
    .join(', ');

  const topDirs = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([dir, count]) => `${dir}:${count}`)
    .join(', ');

  const keyPriority = [
    'readme.md',
    'package.json',
    'tsconfig.json',
    'webpack.config.js',
    'src/extension.ts',
    'src/chat/chatcontroller.ts',
    'src/agents/agentrunner.ts'
  ];

  const keyFiles: string[] = [];
  for (const key of keyPriority) {
    const found = files.find(f => f.relativePath.replace(/\\/g, '/').toLowerCase() === key);
    if (!found) {
      continue;
    }
    const headline = firstNonEmptyLine(found.content).slice(0, 140);
    keyFiles.push(`${found.relativePath}${headline ? ` -> ${headline}` : ''}`);
  }

  const lines: string[] = [
    '[Repository Summary]',
    `Indexed files: ${files.length}`,
    `Top dirs: ${topDirs || 'n/a'}`,
    `Top extensions: ${topExt || 'n/a'}`
  ];

  if (keyFiles.length > 0) {
    lines.push('');
    lines.push('Key files:');
    for (const entry of keyFiles) {
      lines.push(`- ${entry}`);
    }
  }

  return truncate(lines.join('\n'), maxChars);
}

interface ScoredFile {
  file: ScannedFile;
  score: number;
  matchedTerms: string[];
  anchorIndex: number;
}

function scoreFile(file: ScannedFile, terms: string[]): ScoredFile | null {
  if (terms.length === 0) {
    return null;
  }

  const pathLower = file.relativePath.toLowerCase();
  const contentLower = file.content.toLowerCase();
  const matched = new Set<string>();
  let score = 0;
  let anchorIndex = -1;

  for (const term of terms) {
    if (pathLower.includes(term)) {
      score += 10;
      matched.add(term);
    }

    let localMatches = 0;
    let idx = contentLower.indexOf(term);
    while (idx !== -1 && localMatches < 3) {
      localMatches++;
      score += 3;
      matched.add(term);
      if (anchorIndex < 0) {
        anchorIndex = idx;
      }
      idx = contentLower.indexOf(term, idx + term.length);
    }
  }

  if (score <= 0) {
    return null;
  }

  return {
    file,
    score,
    matchedTerms: [...matched],
    anchorIndex: anchorIndex >= 0 ? anchorIndex : 0
  };
}

export function selectRelevantFileSnippets(
  files: ScannedFile[],
  query: string,
  maxFiles = 6,
  snippetChars = 900
): RelevantFileSnippet[] {
  const terms = extractQueryTerms(query);
  if (terms.length === 0 || files.length === 0 || maxFiles <= 0) {
    return [];
  }

  const ranked = files
    .map(file => scoreFile(file, terms))
    .filter((item): item is ScoredFile => item !== null)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.file.relativePath.localeCompare(b.file.relativePath);
    })
    .slice(0, maxFiles);

  return ranked.map(item => ({
    relativePath: item.file.relativePath,
    score: item.score,
    matchedTerms: item.matchedTerms,
    snippet: snippetAround(item.file.content, item.anchorIndex, snippetChars)
  }));
}

export function formatRelevantContext(query: string, snippets: RelevantFileSnippet[]): string {
  if (snippets.length === 0) {
    return '';
  }

  const lines: string[] = [
    '[Task-scoped Repository Context]',
    `Query: ${query}`,
    'Only the most relevant snippets are included below.'
  ];

  for (const item of snippets) {
    lines.push('');
    lines.push(`### ${item.relativePath} (score: ${item.score})`);
    if (item.matchedTerms.length > 0) {
      lines.push(`Matched: ${item.matchedTerms.join(', ')}`);
    }
    lines.push('```');
    lines.push(item.snippet || '(empty)');
    lines.push('```');
  }

  return lines.join('\n');
}

export function measureRequestSize(params: {
  systemPrompt: string;
  history: ChatMessage[];
  repoSummaryContext?: string;
  retrievalContext?: string;
  userMessage: string;
  tools: MCPToolDefinition[];
}): RequestSizeBreakdown {
  const systemChars = params.systemPrompt.length;
  const historyChars = params.history.reduce((sum, msg) => sum + (msg.content?.length ?? 0), 0);
  const repoSummaryChars = params.repoSummaryContext?.length ?? 0;
  const retrievalChars = params.retrievalContext?.length ?? 0;
  const userChars = params.userMessage.length;
  const toolSchemaChars = JSON.stringify(params.tools).length;

  const totalChars = systemChars + historyChars + repoSummaryChars + retrievalChars + userChars + toolSchemaChars;
  const totalBytes = utf8Bytes(params.systemPrompt)
    + utf8Bytes(params.history.map(m => m.content).join('\n'))
    + utf8Bytes(params.repoSummaryContext ?? '')
    + utf8Bytes(params.retrievalContext ?? '')
    + utf8Bytes(params.userMessage)
    + utf8Bytes(JSON.stringify(params.tools));

  return {
    systemChars,
    historyChars,
    repoSummaryChars,
    retrievalChars,
    userChars,
    toolSchemaChars,
    totalChars,
    totalBytes,
    estimatedInputTokens: estimateTokensFromChars(totalChars)
  };
}
