// ─── Project & Agent configuration types ──────────────────────────────────────

// Re-export context pipeline types for consumer convenience.
export type { AssistantMode, ModeDecision } from './context/types';

/** User role selected during onboarding wizard (NF2-UX-003). */
export type UserRole = 'Developer' | 'Architect' | 'Business Analyst' | 'Reviewer';

export interface ProjectConfig {
  project: {
    name: string;
    created_at: string;
  };
  agents: string[];
  defaultProvider?: ProviderConfig;
  /**
   * Secondary lightweight provider used for mode classification.
   * When set, AgentRunner calls this provider instead of the regex classifier
   * to determine the assistant mode for each request.
   */
  classifierProvider?: ProviderConfig;
  /** Role selected during first-launch onboarding wizard. Used to rank agent list. */
  userRole?: UserRole;
}

export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'qwen' | 'openai_compatible';
/**
 * Authentication mode for provider calls.
 * `gcp_adc` is kept as a legacy alias and mapped to `vertex_ai` at runtime.
 */
export type AuthMethod = 'api_key' | 'oauth_proxy' | 'vertex_ai' | 'gcp_adc';

export interface ProviderConfig {
  type: ProviderType;
  model: string;
  base_url: string | null;
  proxy_url: string | null;
  auth_method: AuthMethod;
  /** GCP region for Vertex AI, e.g. "europe-west4". Overrides env vars. */
  vertex_location?: string | null;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ContextFilter {
  include_extensions: string[];
  exclude_patterns: string[];
}

export type AgentCategory =
  | 'Solution Architect Agent'
  | 'Data Architect Agent'
  | 'Business Analyst Agent'
  | 'Cloud Architect Agent'
  | 'Software QA / Testing Agent'
  | 'Front-End Designer Agent'
  | 'Advanced Coder Agent'
  | 'Security Engineer Agent'
  | 'DevOps Engineer Agent'
  | 'Technical Writer Agent'
  | 'AI / LLM Engineer Agent'
  | 'Custom Agent';

export interface AgentKnowledgeConfig {
  source_folders: string[];
}

export interface AgentConfig {
  id: string;
  name: string;
  category: AgentCategory;
  description: string;
  enabled: boolean;
  provider: ProviderConfig;
  useDefaultProvider?: boolean;
  system_prompt_files: string[];
  mcp_servers: MCPServerConfig[];
  context_filter: ContextFilter;
  knowledge?: AgentKnowledgeConfig;
}

// ─── Chat / messaging types ────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool_result';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Present when role is 'tool_result' — links back to the tool_use event that produced this result. */
  toolCallId?: string;
}

export type ThoughtEventType = 'thinking' | 'tool_call' | 'tool_result' | 'error';

export interface ThoughtEvent {
  type: ThoughtEventType;
  label: string;
  detail?: string;
  timestamp: Date;
}

// ─── MCP types ─────────────────────────────────────────────────────────────────

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface MCPToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ─── Undo types ────────────────────────────────────────────────────────────────

export type UndoActionType = 'write_file' | 'run_command';

export interface UndoAction {
  type: UndoActionType;
  filePath?: string;
  /**
   * The content the file had before the write.
   * `undefined` means this action is not a file-write (e.g. run_command).
   * Use `fileExisted` to distinguish "new file" from "existing empty file".
   */
  previousContent?: string;
  /**
   * True when the file already existed before the agent wrote it.
   * False when the agent created the file from scratch.
   * This disambiguates an empty previousContent ('') from a new file (undefined-ish).
   */
  fileExisted?: boolean;
  description: string;
  timestamp: Date;
}

// ─── Provider streaming ────────────────────────────────────────────────────────

export interface LLMStreamOptions {
  messages: ChatMessage[];
  tools?: MCPToolDefinition[];
  maxTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'provider_headers'; provider: string; headers: Record<string, string> }
  | { type: 'token_usage'; usage: TokenUsage }
  | { type: 'done' };
